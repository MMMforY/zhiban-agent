const { ChromaClient } = require('chromadb');

function clientOptions(config) {
  const url = new URL(config.url);
  const headers = {};
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    ssl: url.protocol === 'https:',
    tenant: config.tenant,
    database: config.database,
    ...(Object.keys(headers).length ? { headers } : {})
  };
}

function createChromaStore({ db, config = {}, embeddingClient, clientFactory } = {}) {
  const configured = Boolean(config.enabled && config.url);
  const enabled = Boolean(configured && embeddingClient?.enabled);
  const makeClient = clientFactory || ((options) => new ChromaClient(options));
  let client;
  let collectionPromise;
  let lastError = '';
  let lastSuccessAt = null;

  function enqueue(objectId, operation) {
    db.prepare(`
      INSERT INTO vector_index_jobs(object_type,object_id,operation,status,attempts,last_error,updated_at,completed_at)
      VALUES('fragment', ?, ?, 'pending', 0, '', CURRENT_TIMESTAMP, NULL)
      ON CONFLICT(object_type,object_id) DO UPDATE SET
        operation=excluded.operation, status='pending', attempts=0,
        last_error='', updated_at=CURRENT_TIMESTAMP, completed_at=NULL
    `).run(Number(objectId), operation);
  }

  function enqueueUpsert(fragmentId) { enqueue(fragmentId, 'upsert'); }
  function enqueueDelete(fragmentId) { enqueue(fragmentId, 'delete'); }

  async function collection() {
    if (!enabled) throw new Error(configured ? 'Embedding provider is not configured' : 'ChromaDB is not configured');
    if (!collectionPromise) {
      collectionPromise = (async () => {
        client = makeClient(clientOptions(config));
        await client.heartbeat();
        return client.getOrCreateCollection({
          name: config.collection,
          embeddingFunction: null,
          metadata: {
            scope: 'ai-aa-memory-fragments',
            continuity: 'B-GPE',
            embedding_model: embeddingClient.model || 'external'
          }
        });
      })().catch((error) => {
        collectionPromise = null;
        lastError = error.message;
        throw error;
      });
    }
    return collectionPromise;
  }

  function markJobs(jobs, status, error = '') {
    if (!jobs.length) return;
    const update = db.prepare(`
      UPDATE vector_index_jobs SET status=?, last_error=?, updated_at=CURRENT_TIMESTAMP,
        completed_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE object_type='fragment' AND object_id=?
    `);
    db.transaction(() => jobs.forEach((job) => update.run(status, error.slice(0, 2000), status, job.object_id)))();
  }

  async function flushPending(options = {}) {
    if (!enabled) {
      return { skipped: true, reason: configured ? 'embedding_disabled' : 'chroma_disabled', processed: 0 };
    }
    const limit = Math.max(1, Math.min(Number(options.limit) || config.batchSize || 32, 200));
    const jobs = db.prepare(`
      SELECT * FROM vector_index_jobs
      WHERE status IN ('pending','failed') AND attempts < ?
      ORDER BY updated_at, object_id LIMIT ?
    `).all(config.maxAttempts || 8, limit);
    if (!jobs.length) return { processed: 0, upserted: 0, deleted: 0, failed: 0 };
    const increment = db.prepare(`
      UPDATE vector_index_jobs SET status='processing', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP
      WHERE object_type='fragment' AND object_id=?
    `);
    db.transaction(() => jobs.forEach((job) => increment.run(job.object_id)))();

    const target = await collection().catch((error) => {
      markJobs(jobs, 'failed', error.message);
      return null;
    });
    if (!target) return { processed: jobs.length, upserted: 0, deleted: 0, failed: jobs.length, error: lastError };

    const deletes = jobs.filter((job) => job.operation === 'delete');
    const upsertJobs = jobs.filter((job) => job.operation === 'upsert');
    const rows = upsertJobs.length
      ? db.prepare(`
        SELECT id,type,entity,content,emotional_weight,confidence,source_date,status,updated_at
        FROM memory_fragments WHERE id IN (${upsertJobs.map(() => '?').join(',')})
          AND write_state='active' AND status!='tombstone'
      `).all(...upsertJobs.map((job) => job.object_id))
      : [];
    const rowIds = new Set(rows.map((row) => row.id));
    for (const job of upsertJobs) if (!rowIds.has(job.object_id)) deletes.push({ ...job, operation: 'delete' });
    const actualUpserts = upsertJobs.filter((job) => rowIds.has(job.object_id));

    let upserted = 0;
    let deleted = 0;
    let failed = 0;
    if (actualUpserts.length) {
      try {
        const rowById = new Map(rows.map((row) => [row.id, row]));
        const ordered = actualUpserts.map((job) => rowById.get(job.object_id));
        const embeddings = await embeddingClient.embed(ordered.map((row) => row.content));
        await target.upsert({
          ids: ordered.map((row) => `fragment:${row.id}`),
          documents: ordered.map((row) => row.content),
          embeddings,
          metadatas: ordered.map((row) => ({
            fragment_id: row.id,
            type: row.type,
            entity: row.entity,
            confidence: row.confidence,
            emotional_weight: row.emotional_weight,
            source_date: row.source_date || '',
            sqlite_updated_at: row.updated_at
          }))
        });
        markJobs(actualUpserts, 'done');
        upserted = actualUpserts.length;
      } catch (error) {
        lastError = error.message;
        markJobs(actualUpserts, 'failed', error.message);
        failed += actualUpserts.length;
      }
    }
    if (deletes.length) {
      try {
        await target.delete({ ids: [...new Set(deletes.map((job) => `fragment:${job.object_id}`))] });
        markJobs(deletes, 'done');
        deleted = deletes.length;
      } catch (error) {
        lastError = error.message;
        markJobs(deletes, 'failed', error.message);
        failed += deletes.length;
      }
    }
    if (!failed) {
      lastError = '';
      lastSuccessAt = new Date().toISOString();
    }
    return { processed: jobs.length, upserted, deleted, failed, ...(failed ? { error: lastError } : {}) };
  }

  async function search(query, limit = 20) {
    const text = String(query || '').trim();
    if (!enabled || !text) return [];
    try {
      const target = await collection();
      const [embedding] = await embeddingClient.embed([text]);
      const maxResults = Math.max(1, Math.min(Number(config.maxResults) || 3, 12));
      const maxDistance = Number.isFinite(Number(config.maxDistance))
        ? Math.max(0, Number(config.maxDistance))
        : 0.82;
      const result = await target.query({
        queryEmbeddings: [embedding],
        nResults: Math.max(1, Math.min(Number(limit) || maxResults, maxResults)),
        include: ['documents', 'metadatas', 'distances']
      });
      const ids = result.ids?.[0] || [];
      const distances = result.distances?.[0] || [];
      const documents = result.documents?.[0] || [];
      const metadatas = result.metadatas?.[0] || [];
      lastError = '';
      lastSuccessAt = new Date().toISOString();
      return ids.map((id, index) => ({
        id,
        fragmentId: Number(String(id).replace(/^fragment:/, '')),
        distance: Number(distances[index]),
        document: documents[index] || '',
        metadata: metadatas[index] || {}
      })).filter((row) => (
        Number.isInteger(row.fragmentId)
        && Number.isFinite(row.distance)
        && row.distance <= maxDistance
      )).slice(0, maxResults);
    } catch (error) {
      lastError = error.message;
      return [];
    }
  }

  function reindexAll() {
    const rows = db.prepare(`
      SELECT id FROM memory_fragments
      WHERE write_state='active' AND status!='tombstone'
    `).all();
    db.transaction(() => rows.forEach((row) => enqueueUpsert(row.id)))();
    return rows.length;
  }

  async function rebuildAll() {
    if (!enabled) {
      return { skipped: true, reason: configured ? 'embedding_disabled' : 'chroma_disabled', removed: 0, queued: 0 };
    }
    const target = await collection();
    const existing = await target.get();
    const ids = existing.ids || [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      await target.delete({ ids: ids.slice(offset, offset + 500) });
    }
    db.prepare(`DELETE FROM vector_index_jobs WHERE object_type='fragment'`).run();
    const queued = reindexAll();
    lastError = '';
    lastSuccessAt = new Date().toISOString();
    return { removed: ids.length, queued };
  }

  function status() {
    const counts = Object.fromEntries(db.prepare(`
      SELECT status, COUNT(*) AS count FROM vector_index_jobs GROUP BY status
    `).all().map((row) => [row.status, row.count]));
    return {
      configured,
      enabled,
      url: config.url || '',
      collection: config.collection || '',
      maxDistance: Number(config.maxDistance),
      maxResults: Number(config.maxResults),
      embedding: embeddingClient?.status?.() || { enabled: false },
      queue: counts,
      lastSuccessAt,
      lastError
    };
  }

  async function heartbeat() {
    if (!enabled) return { ok: false, reason: configured ? 'embedding_disabled' : 'chroma_disabled' };
    try {
      const target = await collection();
      return { ok: true, collection: target.name, count: await target.count() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return { enabled, enqueueUpsert, enqueueDelete, flushPending, search, reindexAll, rebuildAll, status, heartbeat };
}

module.exports = { createChromaStore, clientOptions };

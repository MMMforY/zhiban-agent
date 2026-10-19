const { ChromaClient } = require('chromadb');
const { clientOptions } = require('./chroma-store');

function createAssetVectorStore({ db, config = {}, embeddingClient, clientFactory } = {}) {
  const configured = Boolean(config.enabled && config.url);
  const enabled = Boolean(configured && embeddingClient?.enabled);
  const makeClient = clientFactory || ((options) => new ChromaClient(options));
  let collectionPromise;
  let lastError = '';
  let lastSuccessAt = null;

  function enqueue(assetId, operation) {
    db.prepare(`
      INSERT INTO asset_vector_jobs(asset_id,operation,status,attempts,last_error,updated_at,completed_at)
      VALUES(?, ?, 'pending', 0, '', CURRENT_TIMESTAMP, NULL)
      ON CONFLICT(asset_id) DO UPDATE SET operation=excluded.operation,status='pending',attempts=0,
        last_error='',updated_at=CURRENT_TIMESTAMP,completed_at=NULL
    `).run(String(assetId), operation);
  }

  async function collection() {
    if (!enabled) throw new Error(configured ? 'Embedding provider is not configured' : 'Asset ChromaDB is not configured');
    if (!collectionPromise) {
      collectionPromise = (async () => {
        const client = makeClient(clientOptions(config));
        await client.heartbeat();
        return client.getOrCreateCollection({
          name: config.collection,
          embeddingFunction: null,
          metadata: { scope: 'ai-aa-assets', embedding_model: embeddingClient.model || 'external' }
        });
      })().catch((error) => {
        collectionPromise = null;
        lastError = error.message;
        throw error;
      });
    }
    return collectionPromise;
  }

  function rowsFor(ids) {
    if (!ids.length) return [];
    return db.prepare(`
      SELECT a.id,a.kind,a.filename,a.caption,a.source_platform,a.created_at,a.updated_at,
             trim(a.filename || char(10) || a.caption || char(10) ||
               coalesce(group_concat(aa.content, char(10)), '')) AS search_text
      FROM assets a LEFT JOIN asset_annotations aa ON aa.asset_id=a.id
      WHERE a.id IN (${ids.map(() => '?').join(',')}) AND a.status='active'
      GROUP BY a.id
    `).all(...ids);
  }

  function mark(ids, status, error = '') {
    if (!ids.length) return;
    const update = db.prepare(`
      UPDATE asset_vector_jobs SET status=?,last_error=?,updated_at=CURRENT_TIMESTAMP,
        completed_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE asset_id=?
    `);
    db.transaction(() => ids.forEach((id) => update.run(status, error.slice(0, 2000), status, id)))();
  }

  async function flushPending(options = {}) {
    if (!enabled) return { skipped: true, reason: configured ? 'embedding_disabled' : 'chroma_disabled', processed: 0 };
    const limit = Math.max(1, Math.min(Number(options.limit) || config.batchSize || 10, 100));
    const jobs = db.prepare(`
      SELECT * FROM asset_vector_jobs WHERE status IN ('pending','failed') AND attempts<?
      ORDER BY updated_at,asset_id LIMIT ?
    `).all(config.maxAttempts || 8, limit);
    if (!jobs.length) return { processed: 0, upserted: 0, deleted: 0, failed: 0 };
    db.transaction(() => jobs.forEach((job) => db.prepare(`
      UPDATE asset_vector_jobs SET status='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE asset_id=?
    `).run(job.asset_id)))();
    let target;
    try { target = await collection(); } catch (error) {
      mark(jobs.map((job) => job.asset_id), 'failed', error.message);
      return { processed: jobs.length, upserted: 0, deleted: 0, failed: jobs.length, error: error.message };
    }
    const rows = rowsFor(jobs.filter((job) => job.operation === 'upsert').map((job) => job.asset_id));
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    const upserts = jobs.filter((job) => job.operation === 'upsert' && rowMap.has(job.asset_id));
    const deletes = jobs.filter((job) => job.operation === 'delete' || !rowMap.has(job.asset_id));
    let upserted = 0;
    let deleted = 0;
    let failed = 0;
    if (upserts.length) {
      try {
        const ordered = upserts.map((job) => rowMap.get(job.asset_id));
        const embeddings = await embeddingClient.embed(ordered.map((row) => row.search_text));
        await target.upsert({
          ids: ordered.map((row) => `asset:${row.id}`),
          documents: ordered.map((row) => row.search_text),
          embeddings,
          metadatas: ordered.map((row) => ({ asset_id: row.id, kind: row.kind, filename: row.filename }))
        });
        mark(upserts.map((job) => job.asset_id), 'done');
        upserted = upserts.length;
      } catch (error) {
        lastError = error.message;
        mark(upserts.map((job) => job.asset_id), 'failed', error.message);
        failed += upserts.length;
      }
    }
    if (deletes.length) {
      try {
        await target.delete({ ids: [...new Set(deletes.map((job) => `asset:${job.asset_id}`))] });
        mark(deletes.map((job) => job.asset_id), 'done');
        deleted = deletes.length;
      } catch (error) {
        lastError = error.message;
        mark(deletes.map((job) => job.asset_id), 'failed', error.message);
        failed += deletes.length;
      }
    }
    if (!failed) {
      lastError = '';
      lastSuccessAt = new Date().toISOString();
    }
    return { processed: jobs.length, upserted, deleted, failed, ...(failed ? { error: lastError } : {}) };
  }

  async function search(query, limit = 8) {
    const text = String(query || '').trim();
    if (!enabled || !text) return [];
    try {
      const target = await collection();
      const [embedding] = await embeddingClient.embed([text]);
      const result = await target.query({
        queryEmbeddings: [embedding],
        nResults: Math.max(1, Math.min(Number(limit) || config.maxResults || 8, 20)),
        include: ['metadatas', 'distances']
      });
      const ids = result.ids?.[0] || [];
      const distances = result.distances?.[0] || [];
      const maxDistance = Number.isFinite(Number(config.maxDistance)) ? Number(config.maxDistance) : 0.82;
      lastError = '';
      lastSuccessAt = new Date().toISOString();
      return ids.map((id, index) => ({
        assetId: String(id).replace(/^asset:/, ''),
        distance: Number(distances[index])
      })).filter((row) => Number.isFinite(row.distance) && row.distance <= maxDistance);
    } catch (error) {
      lastError = error.message;
      return [];
    }
  }

  function reindexAll() {
    const rows = db.prepare("SELECT id FROM assets WHERE status='active'").all();
    db.transaction(() => rows.forEach((row) => enqueue(row.id, 'upsert')))();
    return rows.length;
  }

  function status() {
    const queue = Object.fromEntries(db.prepare(`
      SELECT status,COUNT(*) AS count FROM asset_vector_jobs GROUP BY status
    `).all().map((row) => [row.status, row.count]));
    return { configured, enabled, collection: config.collection || '', queue, lastSuccessAt, lastError };
  }

  return {
    enabled,
    enqueueUpsert: (id) => enqueue(id, 'upsert'),
    enqueueDelete: (id) => enqueue(id, 'delete'),
    flushPending,
    search,
    reindexAll,
    status
  };
}

module.exports = { createAssetVectorStore };

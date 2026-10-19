const { ChromaClient } = require('chromadb');
const { clientOptions } = require('./chroma-store');

function createAssetDocumentVectorStore({ db, config = {}, embeddingClient, clientFactory } = {}) {
  const configured = Boolean(config.enabled && config.url);
  const enabled = Boolean(configured && embeddingClient?.enabled);
  const makeClient = clientFactory || ((options) => new ChromaClient(options));
  let collectionPromise;
  let lastError = '';
  let lastSuccessAt = null;

  function enqueue(unitId, operation) {
    db.prepare(`
      INSERT INTO asset_document_vector_jobs(unit_id,operation,status,attempts,last_error,updated_at,completed_at)
      VALUES(?,?,'pending',0,'',CURRENT_TIMESTAMP,NULL)
      ON CONFLICT(unit_id) DO UPDATE SET operation=excluded.operation,status='pending',attempts=0,
        last_error='',updated_at=CURRENT_TIMESTAMP,completed_at=NULL
    `).run(String(unitId), operation);
  }

  async function collection() {
    if (!enabled) throw new Error(configured ? 'Embedding provider is not configured' : 'Asset document ChromaDB is not configured');
    if (!collectionPromise) {
      collectionPromise = (async () => {
        const client = makeClient(clientOptions(config));
        await client.heartbeat();
        return client.getOrCreateCollection({
          name: config.collection,
          embeddingFunction: null,
          metadata: { scope: 'ai-aa-asset-documents', embedding_model: embeddingClient.model || 'external' }
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
      SELECT u.*,d.title AS document_title,d.source_type,d.version_label,d.authority,
        trim(CASE WHEN u.unit_type='route_card' THEN '个人理论记忆路标' ELSE '个人理论原文片段' END || char(10) ||
          d.title || char(10) || u.section_title || char(10) || u.title || char(10) ||
          u.content || char(10) || u.keywords_json) AS search_text
      FROM asset_document_units u JOIN asset_documents d ON d.asset_id=u.asset_id JOIN assets a ON a.id=d.asset_id
      WHERE u.id IN (${ids.map(() => '?').join(',')}) AND u.status='active' AND d.status='active' AND a.status='active'
    `).all(...ids);
  }

  function mark(ids, status, error = '') {
    if (!ids.length) return;
    const update = db.prepare(`
      UPDATE asset_document_vector_jobs SET status=?,last_error=?,updated_at=CURRENT_TIMESTAMP,
        completed_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE unit_id=?
    `);
    db.transaction(() => ids.forEach((id) => update.run(status, String(error).slice(0, 2000), status, id)))();
  }

  async function flushPending(options = {}) {
    if (!enabled) return { skipped: true, reason: configured ? 'embedding_disabled' : 'chroma_disabled', processed: 0 };
    const limit = Math.max(1, Math.min(Number(options.limit) || config.batchSize || 10, 10));
    const jobs = db.prepare(`
      SELECT * FROM asset_document_vector_jobs WHERE status IN ('pending','failed') AND attempts<?
      ORDER BY updated_at,unit_id LIMIT ?
    `).all(config.maxAttempts || 8, limit);
    if (!jobs.length) return { processed: 0, upserted: 0, deleted: 0, failed: 0 };
    db.transaction(() => jobs.forEach((job) => db.prepare(`
      UPDATE asset_document_vector_jobs SET status='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE unit_id=?
    `).run(job.unit_id)))();
    let target;
    try { target = await collection(); } catch (error) {
      mark(jobs.map((job) => job.unit_id), 'failed', error.message);
      return { processed: jobs.length, upserted: 0, deleted: 0, failed: jobs.length, error: error.message };
    }
    const rows = rowsFor(jobs.filter((job) => job.operation === 'upsert').map((job) => job.unit_id));
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    const upserts = jobs.filter((job) => job.operation === 'upsert' && rowMap.has(job.unit_id));
    const deletes = jobs.filter((job) => job.operation === 'delete' || !rowMap.has(job.unit_id));
    let upserted = 0; let deleted = 0; let failed = 0;
    if (upserts.length) {
      try {
        const ordered = upserts.map((job) => rowMap.get(job.unit_id));
        const embeddings = await embeddingClient.embed(ordered.map((row) => row.search_text));
        await target.upsert({
          ids: ordered.map((row) => `asset-document:${row.id}`),
          documents: ordered.map((row) => row.search_text),
          embeddings,
          metadatas: ordered.map((row) => ({
            unit_id: row.id, asset_id: row.asset_id, unit_type: row.unit_type,
            source_type: row.source_type, document_title: row.document_title
          }))
        });
        mark(upserts.map((job) => job.unit_id), 'done');
        upserted = upserts.length;
      } catch (error) {
        lastError = error.message;
        mark(upserts.map((job) => job.unit_id), 'failed', error.message);
        failed += upserts.length;
      }
    }
    if (deletes.length) {
      try {
        await target.delete({ ids: [...new Set(deletes.map((job) => `asset-document:${job.unit_id}`))] });
        mark(deletes.map((job) => job.unit_id), 'done');
        deleted = deletes.length;
      } catch (error) {
        lastError = error.message;
        mark(deletes.map((job) => job.unit_id), 'failed', error.message);
        failed += deletes.length;
      }
    }
    if (!failed) { lastError = ''; lastSuccessAt = new Date().toISOString(); }
    return { processed: jobs.length, upserted, deleted, failed, ...(failed ? { error: lastError } : {}) };
  }

  async function search(query, options = {}) {
    const text = String(query || '').trim();
    if (!enabled || !text) return [];
    try {
      const target = await collection();
      const [embedding] = await embeddingClient.embed([text]);
      const result = await target.query({
        queryEmbeddings: [embedding],
        nResults: Math.max(1, Math.min(Number(options.limit) || config.maxResults || 8, 20)),
        include: ['metadatas', 'distances'],
        ...(options.unitType ? { where: { unit_type: options.unitType } } : {})
      });
      const ids = result.ids?.[0] || [];
      const distances = result.distances?.[0] || [];
      const maxDistance = Number.isFinite(Number(options.maxDistance))
        ? Number(options.maxDistance)
        : (Number.isFinite(Number(config.maxDistance)) ? Number(config.maxDistance) : 0.82);
      lastError = '';
      lastSuccessAt = new Date().toISOString();
      return ids.map((id, index) => ({
        unitId: String(id).replace(/^asset-document:/, ''),
        assetId: String(result.metadatas?.[0]?.[index]?.asset_id || ''),
        unitType: String(result.metadatas?.[0]?.[index]?.unit_type || ''),
        distance: Number(distances[index])
      })).filter((row) => Number.isFinite(row.distance) && row.distance <= maxDistance);
    } catch (error) {
      lastError = error.message;
      return [];
    }
  }

  function reindexAll() {
    const rows = db.prepare(`SELECT u.id FROM asset_document_units u JOIN asset_documents d ON d.asset_id=u.asset_id
      JOIN assets a ON a.id=d.asset_id WHERE u.status='active' AND d.status='active' AND a.status='active'`).all();
    db.transaction(() => rows.forEach((row) => enqueue(row.id, 'upsert')))();
    return rows.length;
  }

  function status() {
    const queue = Object.fromEntries(db.prepare(`SELECT status,COUNT(*) AS count FROM asset_document_vector_jobs GROUP BY status`)
      .all().map((row) => [row.status, row.count]));
    return { configured, enabled, collection: config.collection || '', queue, lastSuccessAt, lastError };
  }

  return { enabled, enqueueUpsert: (id) => enqueue(id, 'upsert'), enqueueDelete: (id) => enqueue(id, 'delete'),
    flushPending, search, reindexAll, status };
}

module.exports = { createAssetDocumentVectorStore };

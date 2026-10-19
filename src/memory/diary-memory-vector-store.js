const { ChromaClient } = require('chromadb');
const { clientOptions } = require('./chroma-store');

function createDiaryMemoryVectorStore({ db, config = {}, embeddingClient, clientFactory } = {}) {
  const configured = Boolean(config.enabled && config.url);
  const enabled = Boolean(configured && embeddingClient?.enabled);
  const makeClient = clientFactory || ((options) => new ChromaClient(options));
  let collectionPromise;
  let lastError = '';
  let lastSuccessAt = null;

  function enqueue(memoryId, operation = 'upsert') {
    db.prepare(`
      INSERT INTO diary_memory_vector_jobs(memory_id,operation,status,attempts,last_error,updated_at,completed_at)
      VALUES(?,?,'pending',0,'',CURRENT_TIMESTAMP,NULL)
      ON CONFLICT(memory_id) DO UPDATE SET operation=excluded.operation,status='pending',attempts=0,
        last_error='',updated_at=CURRENT_TIMESTAMP,completed_at=NULL
    `).run(String(memoryId), operation);
  }

  async function collection() {
    if (!enabled) throw new Error(configured ? 'Embedding provider is not configured' : '关于日记的记忆 ChromaDB is not configured');
    if (!collectionPromise) {
      collectionPromise = (async () => {
        const client = makeClient(clientOptions(config));
        await client.heartbeat();
        return client.getOrCreateCollection({
          name: config.collection,
          embeddingFunction: null,
          metadata: { scope: 'ai-aa-about-diary-memories', display_name: '关于日记的记忆', embedding_model: embeddingClient.model || 'external' }
        });
      })().catch((error) => { collectionPromise = null; lastError = error.message; throw error; });
    }
    return collectionPromise;
  }

  function mark(ids, status, error = '') {
    if (!ids.length) return;
    const update = db.prepare(`UPDATE diary_memory_vector_jobs SET status=?,last_error=?,updated_at=CURRENT_TIMESTAMP,
      completed_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE memory_id=?`);
    db.transaction(() => ids.forEach((id) => update.run(status, error.slice(0, 2000), status, id)))();
  }

  async function flushPending(options = {}) {
    if (!enabled) return { skipped: true, reason: configured ? 'embedding_disabled' : 'chroma_disabled', processed: 0 };
    const limit = Math.max(1, Math.min(Number(options.limit) || config.batchSize || 10, 10));
    const jobs = db.prepare(`SELECT * FROM diary_memory_vector_jobs WHERE status IN ('pending','failed') AND attempts<?
      ORDER BY updated_at,memory_id LIMIT ?`).all(config.maxAttempts || 8, limit);
    if (!jobs.length) return { processed: 0, upserted: 0, deleted: 0, failed: 0 };
    db.transaction(() => jobs.forEach((job) => db.prepare(`UPDATE diary_memory_vector_jobs SET status='processing',
      attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE memory_id=?`).run(job.memory_id)))();
    let target;
    try { target = await collection(); } catch (error) {
      mark(jobs.map((job) => job.memory_id), 'failed', error.message);
      return { processed: jobs.length, upserted: 0, deleted: 0, failed: jobs.length, error: error.message };
    }
    const upsertIds = jobs.filter((job) => job.operation === 'upsert').map((job) => job.memory_id);
    const rows = upsertIds.length ? db.prepare(`SELECT * FROM about_diary_memories WHERE id IN (${upsertIds.map(() => '?').join(',')}) AND status='active'`).all(...upsertIds) : [];
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    const upserts = jobs.filter((job) => job.operation === 'upsert' && rowMap.has(job.memory_id));
    const deletes = jobs.filter((job) => job.operation === 'delete' || !rowMap.has(job.memory_id));
    let upserted = 0; let deleted = 0; let failed = 0;
    if (upserts.length) {
      try {
        const ordered = upserts.map((job) => rowMap.get(job.memory_id));
        const documents = ordered.map((row) => `关于日记的记忆\n${row.title}\n${row.content}\n主题 ${JSON.parse(row.themes_json || '[]').join(' ')}`);
        const embeddings = await embeddingClient.embed(documents);
        await target.upsert({
          ids: ordered.map((row) => `about-diary:${row.id}`), documents, embeddings,
          metadatas: ordered.map((row) => ({ memory_id: row.id, category: row.category, date_start: row.date_start || '',
            date_end: row.date_end || '', importance_score: row.importance_score, emotional_intensity: row.emotional_intensity }))
        });
        mark(upserts.map((job) => job.memory_id), 'done'); upserted = upserts.length;
      } catch (error) { lastError = error.message; mark(upserts.map((job) => job.memory_id), 'failed', error.message); failed += upserts.length; }
    }
    if (deletes.length) {
      try { await target.delete({ ids: [...new Set(deletes.map((job) => `about-diary:${job.memory_id}`))] });
        mark(deletes.map((job) => job.memory_id), 'done'); deleted = deletes.length;
      } catch (error) { lastError = error.message; mark(deletes.map((job) => job.memory_id), 'failed', error.message); failed += deletes.length; }
    }
    if (!failed) { lastError = ''; lastSuccessAt = new Date().toISOString(); }
    return { processed: jobs.length, upserted, deleted, failed, ...(failed ? { error: lastError } : {}) };
  }

  async function search(query, limit = 6) {
    const text = String(query || '').trim(); if (!enabled || !text) return [];
    try {
      const target = await collection(); const [embedding] = await embeddingClient.embed([text]);
      const result = await target.query({ queryEmbeddings: [embedding], nResults: Math.max(1, Math.min(Number(limit) || 6, 20)), include: ['distances'] });
      const maxDistance = Number.isFinite(Number(config.maxDistance)) ? Number(config.maxDistance) : 0.82;
      lastError = ''; lastSuccessAt = new Date().toISOString();
      return (result.ids?.[0] || []).map((id, index) => ({ memoryId: String(id).replace(/^about-diary:/, ''), distance: Number(result.distances?.[0]?.[index]) }))
        .filter((row) => Number.isFinite(row.distance) && row.distance <= maxDistance);
    } catch (error) { lastError = error.message; return []; }
  }

  function reindexAll() {
    const rows = db.prepare("SELECT id FROM about_diary_memories WHERE status='active'").all();
    db.transaction(() => rows.forEach((row) => enqueue(row.id, 'upsert')))(); return rows.length;
  }
  function status() {
    const queue = Object.fromEntries(db.prepare('SELECT status,COUNT(*) AS count FROM diary_memory_vector_jobs GROUP BY status').all().map((row) => [row.status, row.count]));
    return { configured, enabled, collection: config.collection || '', displayName: '关于日记的记忆', queue, lastSuccessAt, lastError };
  }
  return { enabled, enqueueUpsert: (id) => enqueue(id, 'upsert'), enqueueDelete: (id) => enqueue(id, 'delete'), flushPending, search, reindexAll, status };
}

module.exports = { createDiaryMemoryVectorStore };

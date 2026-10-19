const assert = require('node:assert/strict');
const { test } = require('node:test');
const { initializeDatabase } = require('../src/db');
const { createChromaStore, clientOptions } = require('../src/memory/chroma-store');
const { createLibrarian } = require('../src/memory/librarian');

function fixture(options = {}) {
  const db = initializeDatabase(':memory:');
  const calls = { upsert: [], delete: [], query: [] };
  const collection = {
    name: 'test_memories',
    async upsert(payload) { calls.upsert.push(payload); },
    async delete(payload) { calls.delete.push(payload); },
    async get() { return { ids: ['fragment:999'] }; },
    async query(payload) {
      calls.query.push(payload);
      return options.queryResponse || {
        ids: [['fragment:1']],
        distances: [[0.08]],
        documents: [['The user enjoys astronomy.']],
        metadatas: [[{ fragment_id: 1 }]]
      };
    },
    async count() { return calls.upsert.length; }
  };
  const client = {
    async heartbeat() { return Date.now(); },
    async getOrCreateCollection(options) {
      assert.equal(options.embeddingFunction, null);
      return collection;
    }
  };
  const embeddingClient = {
    enabled: true,
    model: 'test-embedding',
    async embed(texts) { return texts.map((text) => [text.length, 1, 0]); },
    status() { return { enabled: true, model: 'test-embedding' }; }
  };
  const store = createChromaStore({
    db,
    config: {
      enabled: true,
      url: 'http://127.0.0.1:8000',
      collection: 'test_memories',
      tenant: 'default_tenant',
      database: 'default_database',
      authToken: 'secret',
      batchSize: 16,
      maxAttempts: 3,
      maxDistance: 0.82,
      maxResults: 3,
      ...(options.config || {})
    },
    embeddingClient,
    clientFactory(options) {
      assert.deepEqual(options, {
        host: '127.0.0.1', port: 8000, ssl: false,
        tenant: 'default_tenant', database: 'default_database',
        headers: { Authorization: 'Bearer secret' }
      });
      return client;
    }
  });
  return { db, store, calls };
}

test('Chroma queue upserts SQLite fragments with external embeddings', async () => {
  const { db, store, calls } = fixture();
  db.prepare(`
    INSERT INTO memory_fragments(type,entity,content,confidence,emotional_weight)
    VALUES('preference','Sky','The user enjoys astronomy.',0.9,0.7)
  `).run();
  store.enqueueUpsert(1);
  const result = await store.flushPending();
  assert.deepEqual(result, { processed: 1, upserted: 1, deleted: 0, failed: 0 });
  assert.deepEqual(calls.upsert[0].ids, ['fragment:1']);
  assert.deepEqual(calls.upsert[0].embeddings, [[26, 1, 0]]);
  assert.equal(db.prepare(`SELECT status FROM vector_index_jobs WHERE object_id=1`).get().status, 'done');
  const hits = await store.search('stars at night', 5);
  assert.equal(hits[0].fragmentId, 1);
  assert.equal(hits[0].distance, 0.08);
  db.close();
});

test('semantic search rejects distant memories and caps candidates', async () => {
  const { db, store, calls } = fixture({
    queryResponse: {
      ids: [['fragment:1', 'fragment:2', 'fragment:3']],
      distances: [[0.08, 0.9, 0.81]],
      documents: [['one', 'two', 'three']],
      metadatas: [[{}, {}, {}]]
    }
  });
  const hits = await store.search('a query', 20);
  assert.equal(calls.query[0].nResults, 3);
  assert.deepEqual(hits.map((hit) => hit.fragmentId), [1, 3]);
  assert.ok(hits.every((hit) => hit.distance <= 0.82));
  db.close();
});

test('hybrid search fuses semantic results that lexical search cannot find', async () => {
  const { db, store } = fixture();
  db.prepare(`
    INSERT INTO memory_fragments(type,entity,content,confidence,emotional_weight)
    VALUES('preference','Sky','The user enjoys astronomy.',0.9,0.7)
  `).run();
  const librarian = createLibrarian(db, store);
  assert.equal(librarian.search('stars at night', 5).length, 0);
  const hybrid = await librarian.searchHybrid('stars at night', 5);
  assert.equal(hybrid[0].id, 1);
  assert.ok(hybrid[0].channels.includes('semantic'));
  db.close();
});

test('full rebuild removes orphan vectors before queuing SQLite truth', async () => {
  const { db, store, calls } = fixture();
  db.prepare(`
    INSERT INTO memory_fragments(type,entity,content,confidence,emotional_weight)
    VALUES('preference','Tea','The user prefers oolong tea.',0.9,0.7)
  `).run();
  const rebuilt = await store.rebuildAll();
  assert.deepEqual(rebuilt, { removed: 1, queued: 1 });
  assert.deepEqual(calls.delete[0].ids, ['fragment:999']);
  const flushed = await store.flushPending();
  assert.equal(flushed.upserted, 1);
  db.close();
});

test('Chroma URL parsing keeps the vector service on an explicit internal endpoint', () => {
  assert.deepEqual(clientOptions({
    url: 'https://chroma.internal:8443',
    tenant: 'tenant-a',
    database: 'memory',
    authToken: ''
  }), {
    host: 'chroma.internal', port: 8443, ssl: true,
    tenant: 'tenant-a', database: 'memory'
  });
});

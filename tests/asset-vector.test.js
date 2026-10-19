const assert = require('node:assert/strict');
const { test } = require('node:test');
const { initializeDatabase } = require('../src/db');
const { createAssetVectorStore } = require('../src/memory/asset-vector-store');

function fixture() {
  const db = initializeDatabase(':memory:');
  const calls = { upsert: [], delete: [], query: [] };
  const collection = {
    async upsert(payload) { calls.upsert.push(payload); },
    async delete(payload) { calls.delete.push(payload); },
    async query(payload) {
      calls.query.push(payload);
      return {
        ids: [['asset:asset-1', 'asset:too-far']],
        distances: [[0.12, 0.95]],
        metadatas: [[{ asset_id: 'asset-1' }, { asset_id: 'too-far' }]]
      };
    }
  };
  const client = {
    async heartbeat() { return 1; },
    async getOrCreateCollection(options) {
      assert.equal(options.name, 'test_assets');
      assert.equal(options.embeddingFunction, null);
      return collection;
    }
  };
  const embeddingClient = {
    enabled: true,
    model: 'test-embedding',
    async embed(texts) { return texts.map((text) => [text.length, 1]); }
  };
  const store = createAssetVectorStore({
    db,
    config: {
      enabled: true,
      url: 'http://127.0.0.1:8000',
      collection: 'test_assets',
      tenant: 'default_tenant',
      database: 'default_database',
      authToken: '',
      batchSize: 10,
      maxAttempts: 3,
      maxDistance: 0.82,
      maxResults: 8
    },
    embeddingClient,
    clientFactory: () => client
  });
  return { db, store, calls };
}

test('素材向量索引使用文件名、用户说明和模型注释，但不改变记忆', async () => {
  const { db, store, calls } = fixture();
  db.prepare(`INSERT INTO asset_blobs(sha256,storage_name,size_bytes,mime_type) VALUES('hash','hash.jpg',10,'image/jpeg')`).run();
  db.prepare(`
    INSERT INTO assets(id,blob_sha256,kind,filename,caption)
    VALUES('asset-1','hash','photo','晚霞.jpg','散步时看到的云')
  `).run();
  db.prepare(`
    INSERT INTO asset_annotations(asset_id,annotation_type,content,authority)
    VALUES('asset-1','vision','河岸上方有橙色云层','model')
  `).run();
  store.enqueueUpsert('asset-1');
  const result = await store.flushPending();
  assert.deepEqual(result, { processed: 1, upserted: 1, deleted: 0, failed: 0 });
  assert.deepEqual(calls.upsert[0].ids, ['asset:asset-1']);
  assert.match(calls.upsert[0].documents[0], /晚霞/);
  assert.match(calls.upsert[0].documents[0], /橙色云层/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_fragments').get().count, 0);
  const hits = await store.search('河边的晚霞', 8);
  assert.deepEqual(hits, [{ assetId: 'asset-1', distance: 0.12 }]);
  db.close();
});

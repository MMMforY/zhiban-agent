// Synthetic gardening notes for public tests.
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { test } = require('node:test');
const { initializeDatabase } = require('../src/db');
const { createAssetDocumentStore } = require('../src/asset-document-store');
const { createAssetDocumentVectorStore } = require('../src/memory/asset-document-vector-store');
const { createPromptBuilder } = require('../src/prompt');

function insertAsset(db, id = 'asset-theory') {
  db.prepare(`INSERT INTO asset_blobs(sha256,storage_name,size_bytes,mime_type)
    VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','theory.md',10,'text/markdown')`).run();
  db.prepare(`INSERT INTO assets(id,blob_sha256,kind,filename,caption)
    VALUES(?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','document','播种+浇水=向量.md','个人理论文档')`).run(id);
}

function units() {
  const segment = '浇水是力，播种是方向。';
  const card = '用户把目标推进理解为播种与浇水的统一过程。';
  return [
    { id: 'theoryseg-1', unitType: 'segment', unitKey: 'segment-1', ordinal: 1,
      sectionId: 'core', sectionTitle: '核心', content: segment,
      contentSha256: crypto.createHash('sha256').update(segment).digest('hex'), sourceLineStart: 1, sourceLineEnd: 2 },
    { id: 'theorycard-1', unitType: 'route_card', unitKey: 'thought-practice', ordinal: 1,
      title: '播种与浇水共同构成向量', content: card,
      contentSha256: crypto.createHash('sha256').update(card).digest('hex'), keywords: ['播种','浇水','向量'],
      evidence: [{ quote: '浇水是力，播种是方向。', line_start: 1, line_end: 1 }], sourceLineStart: 1, sourceLineEnd: 1 }
  ];
}

test('个人理论进入统一素材库，路标卡成为有来源记忆而不复制普通记忆', async () => {
  const db = initializeDatabase(':memory:');
  insertAsset(db);
  const queued = [];
  const vectorStore = {
    enqueueUpsert(id) { queued.push(id); }, enqueueDelete() {},
    async search(_query, options) {
      return options.unitType === 'route_card'
        ? [{ unitId: 'theorycard-1', assetId: 'asset-theory', unitType: 'route_card', distance: 0.2 }]
        : [{ unitId: 'theoryseg-1', assetId: 'asset-theory', unitType: 'segment', distance: 0.3 }];
    }
  };
  const store = createAssetDocumentStore({ db, vectorStore, config: { recallEnabled: true, recallMaxDistance: 0.62, recallMaxResults: 1 } });
  const result = store.importDocument('asset-theory', {
    sourceType: 'personal_theory', title: '播种+浇水=向量', author: 'user', authority: 'user_authored',
    temporalInterpretation: 'authored_theory_at_document_version', versionLabel: 'source-snapshot-test',
    sourceSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  }, units());
  assert.equal(result.unitCount, 2);
  assert.deepEqual(queued, ['theoryseg-1', 'theorycard-1']);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM memory_fragments').get().count, 0);
  const recalled = await store.searchRouteCards('播种和浇水是什么关系');
  assert.equal(recalled[0].id, 'theorycard-1');
  assert.equal(recalled[0].document.sourceType, 'personal_theory');

  const builder = createPromptBuilder({
    db, continuityId: 'companion-example-001', assetDocumentStore: store,
    librarian: { searchHybrid: async () => [] }, diaryStore: { search: async () => [] },
    aboutDiaryMemoryStore: { search: async () => [] }
  });
  const context = await builder.buildHermesContext('播种和浇水是什么关系');
  assert.match(context.context, /个人理论记忆:theorycard-1/);
  assert.deepEqual(context.retrievedTheoryUnitIds, ['theorycard-1']);
  const disabled = createAssetDocumentStore({ db, vectorStore, config: { recallEnabled: false } });
  assert.deepEqual(await disabled.searchRouteCards('播种和浇水'), []);
  db.close();
});

test('理论文档向量队列即使请求更大批次也不超过10条', async () => {
  const db = initializeDatabase(':memory:');
  insertAsset(db);
  const collectionCalls = [];
  const collection = {
    async upsert(payload) { collectionCalls.push(payload); }, async delete() {}, async query() { return { ids:[[]],distances:[[]],metadatas:[[]] }; }
  };
  const vectorStore = createAssetDocumentVectorStore({
    db,
    config: { enabled:true,url:'http://127.0.0.1:8000',collection:'test_asset_documents',tenant:'default_tenant',database:'default_database',batchSize:10,maxAttempts:3,maxDistance:0.82,maxResults:8 },
    embeddingClient: { enabled:true,model:'test',async embed(texts){ return texts.map((_,index)=>[index,1]); } },
    clientFactory: () => ({ async heartbeat(){return 1;}, async getOrCreateCollection(){return collection;} })
  });
  const store = createAssetDocumentStore({ db, vectorStore, config:{} });
  const rows = [];
  for (let i=0;i<12;i+=1) {
    const content = `segment ${i}`;
    rows.push({ id:`segment-${i}`,unitType:'segment',unitKey:`segment-${i}`,ordinal:i,content,
      contentSha256:crypto.createHash('sha256').update(content).digest('hex') });
  }
  store.importDocument('asset-theory', { title:'T',sourceSha256:'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }, rows);
  const first = await vectorStore.flushPending({ limit: 50 });
  assert.equal(first.processed, 10);
  assert.equal(collectionCalls[0].ids.length, 10);
  const second = await vectorStore.flushPending({ limit: 50 });
  assert.equal(second.processed, 2);
  db.close();
});

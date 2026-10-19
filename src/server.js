const { loadConfig } = require('./config');
const { initializeDatabase } = require('./db');
const { syncBlueprint } = require('./b-gpe-adapter');
const { createLlmClient } = require('./llm');
const { createEmbeddingClient } = require('./embedding');
const { createChromaStore } = require('./memory/chroma-store');
const { createAssetVectorStore } = require('./memory/asset-vector-store');
const { createAssetDocumentVectorStore } = require('./memory/asset-document-vector-store');
const { createAssetStore } = require('./asset-store');
const { createAssetDocumentStore } = require('./asset-document-store');
const { createDiaryVectorStore } = require('./memory/diary-vector-store');
const { createDiaryStore } = require('./diary-store');
const { createDiaryMemoryVectorStore } = require('./memory/diary-memory-vector-store');
const { createAboutDiaryMemoryStore } = require('./about-diary-memory-store');
const { createDiaryMemoryCurator } = require('./memory/diary-memory-curator');
const { createLibrarian } = require('./memory/librarian');
const { createScribe } = require('./memory/scribe');
const { createArchivist } = require('./memory/archivist');
const { createPromptBuilder } = require('./prompt');
const { createScheduler } = require('./scheduler');
const { createApp } = require('./app');

function createRuntime(overrides = {}) {
  const config = loadConfig(overrides.config);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('Public edition only supports loopback binding; use your own SSH tunnel.');
  const db = overrides.db || initializeDatabase(config.databasePath);
  const blueprint = syncBlueprint(db, config.bGpeRoot);
  const llm = overrides.llm || createLlmClient(config.llm);
  const embeddingClient = overrides.embeddingClient || createEmbeddingClient(config.embedding);
  const vectorStore = overrides.vectorStore || createChromaStore({ db, config: config.chroma, embeddingClient });
  const assetVectorStore = overrides.assetVectorStore || createAssetVectorStore({
    db,
    config: config.assetChroma,
    embeddingClient,
    clientFactory: overrides.assetClientFactory
  });
  const assetDocumentVectorStore = overrides.assetDocumentVectorStore || createAssetDocumentVectorStore({
    db,
    config: config.assetDocumentChroma,
    embeddingClient,
    clientFactory: overrides.assetDocumentClientFactory
  });
  const assetStore = overrides.assetStore || createAssetStore({
    db,
    storagePath: config.assetStoragePath,
    maxBytes: config.assetMaxBytes,
    vectorStore: assetVectorStore
  });
  const assetDocumentStore = overrides.assetDocumentStore || createAssetDocumentStore({
    db, vectorStore: assetDocumentVectorStore, config: config.assetDocument
  });
  const diaryVectorStore = overrides.diaryVectorStore || createDiaryVectorStore({
    db, config: config.diaryChroma, embeddingClient, clientFactory: overrides.diaryClientFactory
  });
  const diaryStore = overrides.diaryStore || createDiaryStore({
    db, storagePath: config.diaryStoragePath, vectorStore: diaryVectorStore, config: config.diary
  });
  const diaryMemoryVectorStore = overrides.diaryMemoryVectorStore || createDiaryMemoryVectorStore({
    db, config: config.diaryMemoryChroma, embeddingClient, clientFactory: overrides.diaryMemoryClientFactory
  });
  const aboutDiaryMemoryStore = overrides.aboutDiaryMemoryStore || createAboutDiaryMemoryStore({
    db, vectorStore: diaryMemoryVectorStore, config: config.diaryMemory
  });
  const diaryMemoryCurator = overrides.diaryMemoryCurator || createDiaryMemoryCurator({
    db, llm, store: aboutDiaryMemoryStore, config: config.diaryMemory, model: config.llm.model
  });
  const librarian = createLibrarian(db, vectorStore);
  const scribe = createScribe({
    db,
    llm,
    continuityId: blueprint.continuityId,
    vectorStore,
    confidencePolicy: {
      active: config.scribeActiveConfidence,
      observed: config.scribeObservedConfidence
    }
  });
  const archivist = createArchivist({ db, llm, vectorStore });
  const promptBuilder = createPromptBuilder({ db, librarian, diaryStore, aboutDiaryMemoryStore, assetDocumentStore, continuityId: blueprint.continuityId });
  const scheduler = createScheduler({ db, scribe, archivist, vectorStore, assetVectorStore, assetDocumentVectorStore, diaryVectorStore, diaryMemoryVectorStore, config });
  const app = createApp({ db, config, llm, librarian, scribe, archivist, promptBuilder, scheduler, vectorStore, assetVectorStore, assetStore,
    assetDocumentVectorStore, assetDocumentStore,
    diaryVectorStore, diaryStore, diaryMemoryVectorStore, aboutDiaryMemoryStore, diaryMemoryCurator, blueprint });
  return { app, db, config, blueprint, llm, embeddingClient, vectorStore, assetVectorStore, assetStore,
    assetDocumentVectorStore, assetDocumentStore,
    diaryVectorStore, diaryStore, diaryMemoryVectorStore, aboutDiaryMemoryStore, diaryMemoryCurator,
    librarian, scribe, archivist, promptBuilder, scheduler };
}

if (require.main === module) {
  const runtime = createRuntime();
  const server = runtime.app.listen(runtime.config.port, runtime.config.host, () => {
    if (runtime.config.autoStartScheduler) runtime.scheduler.start();
    console.log(`Zhiban Memory Constellations listening on http://${runtime.config.host}:${runtime.config.port}`);
    console.log(`B-GPE ${runtime.blueprint.version} / ${runtime.blueprint.continuityId}`);
  });
  const shutdown = () => {
    runtime.scheduler.stop();
    server.close(() => {
      runtime.db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createRuntime };

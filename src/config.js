const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function resolveFromCwd(value, fallback) {
  return path.resolve(process.cwd(), value || fallback);
}

function loadConfig(overrides = {}) {
  const config = {
    host: process.env.HOST || '127.0.0.1',
    port: numberFromEnv('PORT', 3030),
    databasePath: resolveFromCwd(process.env.DATABASE_PATH, './data/companion.db'),
    assetStoragePath: resolveFromCwd(process.env.ASSET_STORAGE_PATH, './data/assets'),
    assetMaxBytes: numberFromEnv('ASSET_MAX_BYTES', 15 * 1024 * 1024),
    diaryStoragePath: resolveFromCwd(process.env.DIARY_STORAGE_PATH, './data/diary-documents'),
    bGpeRoot: resolveFromCwd(process.env.B_GPE_ROOT, './blueprint'),
    authToken: process.env.API_AUTH_TOKEN || '',
    allowedOrigin: process.env.ALLOWED_ORIGIN || '',
    userDisplayName: process.env.USER_DISPLAY_NAME || 'User',
    companionDisplayName: process.env.COMPANION_DISPLAY_NAME || '',
    trustProxy: booleanFromEnv('TRUST_PROXY', false),
    autoStartScheduler: booleanFromEnv('AUTO_START_SCHEDULER', false),
    scribeSilenceMinutes: numberFromEnv('SCRIBE_SILENCE_MINUTES', 20),
    scribeBacklogMessages: numberFromEnv('SCRIBE_BACKLOG_MESSAGES', 100),
    scribeActiveConfidence: numberFromEnv('SCRIBE_ACTIVE_CONFIDENCE', 0.95),
    scribeObservedConfidence: numberFromEnv('SCRIBE_OBSERVED_CONFIDENCE', 0.6),
    archivistTickSeconds: numberFromEnv('ARCHIVIST_TICK_SECONDS', 120),
    deepCycleIdleMinutes: numberFromEnv('DEEP_CYCLE_IDLE_MINUTES', 60),
    llm: {
      baseUrl: (process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
      apiKey: process.env.LLM_API_KEY || '',
      allowNoKey: booleanFromEnv('LLM_ALLOW_NO_KEY', false),
      model: process.env.LLM_MODEL || ''
    },
    embedding: {
      baseUrl: (process.env.EMBEDDING_BASE_URL || process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
      apiKey: process.env.EMBEDDING_API_KEY || process.env.LLM_API_KEY || '',
      model: process.env.EMBEDDING_MODEL || '',
      dimensions: numberFromEnv('EMBEDDING_DIMENSIONS', 0),
      timeoutMs: numberFromEnv('EMBEDDING_TIMEOUT_MS', 15000)
    },
    chroma: {
      enabled: booleanFromEnv('CHROMA_ENABLED', Boolean(process.env.CHROMA_URL)),
      url: (process.env.CHROMA_URL || '').replace(/\/$/, ''),
      collection: process.env.CHROMA_COLLECTION || 'ai_aa_memory_fragments',
      tenant: process.env.CHROMA_TENANT || 'default_tenant',
      database: process.env.CHROMA_DATABASE || 'default_database',
      authToken: process.env.CHROMA_AUTH_TOKEN || '',
      batchSize: numberFromEnv('CHROMA_BATCH_SIZE', 10),
      maxAttempts: numberFromEnv('CHROMA_MAX_ATTEMPTS', 8),
      maxDistance: numberFromEnv('CHROMA_MAX_DISTANCE', 0.82),
      maxResults: numberFromEnv('CHROMA_MAX_RESULTS', 3)
    },
    assetChroma: {
      enabled: booleanFromEnv('ASSET_CHROMA_ENABLED', Boolean(process.env.CHROMA_URL)),
      url: (process.env.CHROMA_URL || '').replace(/\/$/, ''),
      collection: process.env.ASSET_CHROMA_COLLECTION || 'ai_aa_assets',
      tenant: process.env.CHROMA_TENANT || 'default_tenant',
      database: process.env.CHROMA_DATABASE || 'default_database',
      authToken: process.env.CHROMA_AUTH_TOKEN || '',
      batchSize: numberFromEnv('ASSET_CHROMA_BATCH_SIZE', 10),
      maxAttempts: numberFromEnv('ASSET_CHROMA_MAX_ATTEMPTS', 8),
      maxDistance: numberFromEnv('ASSET_CHROMA_MAX_DISTANCE', 0.82),
      maxResults: numberFromEnv('ASSET_CHROMA_MAX_RESULTS', 8)
    },
    assetDocument: {
      recallEnabled: booleanFromEnv('ASSET_DOCUMENT_RECALL_ENABLED', true),
      recallMaxResults: numberFromEnv('ASSET_DOCUMENT_RECALL_MAX_RESULTS', 1),
      recallMaxDistance: numberFromEnv('ASSET_DOCUMENT_RECALL_MAX_DISTANCE', 0.62)
    },
    assetDocumentChroma: {
      enabled: booleanFromEnv('ASSET_DOCUMENT_CHROMA_ENABLED', Boolean(process.env.CHROMA_URL)),
      url: (process.env.CHROMA_URL || '').replace(/\/$/, ''),
      collection: process.env.ASSET_DOCUMENT_CHROMA_COLLECTION || 'ai_aa_asset_documents',
      tenant: process.env.CHROMA_TENANT || 'default_tenant',
      database: process.env.CHROMA_DATABASE || 'default_database',
      authToken: process.env.CHROMA_AUTH_TOKEN || '',
      batchSize: Math.min(numberFromEnv('ASSET_DOCUMENT_CHROMA_BATCH_SIZE', 10), 10),
      maxAttempts: numberFromEnv('ASSET_DOCUMENT_CHROMA_MAX_ATTEMPTS', 8),
      maxDistance: numberFromEnv('ASSET_DOCUMENT_CHROMA_MAX_DISTANCE', 0.82),
      maxResults: numberFromEnv('ASSET_DOCUMENT_CHROMA_MAX_RESULTS', 8)
    },
    diary: {
      recallEnabled: booleanFromEnv('DIARY_RECALL_ENABLED', false),
      maxResults: numberFromEnv('DIARY_MAX_RESULTS', 3),
      maxContextChars: numberFromEnv('DIARY_MAX_CONTEXT_CHARS', 2500)
    },
    diaryChroma: {
      enabled: booleanFromEnv('DIARY_CHROMA_ENABLED', Boolean(process.env.CHROMA_URL)),
      url: (process.env.CHROMA_URL || '').replace(/\/$/, ''),
      collection: process.env.DIARY_CHROMA_COLLECTION || 'ai_aa_diary',
      tenant: process.env.CHROMA_TENANT || 'default_tenant',
      database: process.env.CHROMA_DATABASE || 'default_database',
      authToken: process.env.CHROMA_AUTH_TOKEN || '',
      batchSize: Math.min(numberFromEnv('DIARY_CHROMA_BATCH_SIZE', 10), 10),
      maxAttempts: numberFromEnv('DIARY_CHROMA_MAX_ATTEMPTS', 8),
      maxDistance: numberFromEnv('DIARY_CHROMA_MAX_DISTANCE', 0.82),
      maxResults: numberFromEnv('DIARY_CHROMA_MAX_RESULTS', 3)
    },
    diaryMemory: {
      enabled: booleanFromEnv('DIARY_MEMORY_ENABLED', true),
      recallEnabled: booleanFromEnv('DIARY_MEMORY_RECALL_ENABLED', true),
      maxResults: numberFromEnv('DIARY_MEMORY_MAX_RESULTS', 3),
      maxContextChars: numberFromEnv('DIARY_MEMORY_MAX_CONTEXT_CHARS', 2400),
      emotionalPeakThreshold: numberFromEnv('DIARY_MEMORY_EMOTIONAL_PEAK_THRESHOLD', 0.75),
      extractionBatchEntries: Math.min(numberFromEnv('DIARY_MEMORY_EXTRACTION_BATCH_ENTRIES', 10), 20),
      extractionMaxChars: numberFromEnv('DIARY_MEMORY_EXTRACTION_MAX_CHARS', 9000)
    },
    diaryMemoryChroma: {
      enabled: booleanFromEnv('DIARY_MEMORY_CHROMA_ENABLED', Boolean(process.env.CHROMA_URL)),
      url: (process.env.CHROMA_URL || '').replace(/\/$/, ''),
      collection: process.env.DIARY_MEMORY_CHROMA_COLLECTION || 'ai_aa_about_diary_memories',
      tenant: process.env.CHROMA_TENANT || 'default_tenant',
      database: process.env.CHROMA_DATABASE || 'default_database',
      authToken: process.env.CHROMA_AUTH_TOKEN || '',
      batchSize: Math.min(numberFromEnv('DIARY_MEMORY_CHROMA_BATCH_SIZE', 10), 10),
      maxAttempts: numberFromEnv('DIARY_MEMORY_CHROMA_MAX_ATTEMPTS', 8),
      maxDistance: numberFromEnv('DIARY_MEMORY_CHROMA_MAX_DISTANCE', 0.82),
      maxResults: numberFromEnv('DIARY_MEMORY_CHROMA_MAX_RESULTS', 6)
    }
  };
  return {
    ...config,
    ...overrides,
    llm: { ...config.llm, ...(overrides.llm || {}) },
    embedding: { ...config.embedding, ...(overrides.embedding || {}) },
    chroma: { ...config.chroma, ...(overrides.chroma || {}) },
    assetChroma: { ...config.assetChroma, ...(overrides.assetChroma || {}) },
    assetDocument: { ...config.assetDocument, ...(overrides.assetDocument || {}) },
    assetDocumentChroma: { ...config.assetDocumentChroma, ...(overrides.assetDocumentChroma || {}) },
    diary: { ...config.diary, ...(overrides.diary || {}) },
    diaryChroma: { ...config.diaryChroma, ...(overrides.diaryChroma || {}) },
    diaryMemory: { ...config.diaryMemory, ...(overrides.diaryMemory || {}) },
    diaryMemoryChroma: { ...config.diaryMemoryChroma, ...(overrides.diaryMemoryChroma || {}) }
  };
}

module.exports = { loadConfig };

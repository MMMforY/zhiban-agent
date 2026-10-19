const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { syncBlueprint, getActivePersona } = require('./b-gpe-adapter');

function parseJson(value, fallback = []) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function hash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizeConversationMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'normal' ? 'normal' : 'companion';
}

function createApp({ db, config, llm, librarian, scribe, archivist, promptBuilder, scheduler, vectorStore, assetVectorStore, assetStore,
  assetDocumentVectorStore, assetDocumentStore,
  diaryVectorStore, diaryStore, diaryMemoryVectorStore, aboutDiaryMemoryStore, diaryMemoryCurator, blueprint }) {
  assetDocumentVectorStore = assetDocumentVectorStore || { status: () => ({ configured: false, enabled: false, queue: {} }), reindexAll: () => 0, flushPending: async () => ({ skipped: true }) };
  assetDocumentStore = assetDocumentStore || { status: () => ({ documents: {}, units: {} }), search: async () => [], get: () => null, archiveAsset: () => 0 };
  diaryVectorStore = diaryVectorStore || { status: () => ({ configured: false, enabled: false, queue: {} }), reindexAll: () => 0, flushPending: async () => ({ skipped: true }) };
  diaryStore = diaryStore || { status: () => [], search: async () => [], entry: () => null };
  diaryMemoryVectorStore = diaryMemoryVectorStore || { status: () => ({ configured: false, enabled: false, queue: {} }), reindexAll: () => 0, flushPending: async () => ({ skipped: true }) };
  aboutDiaryMemoryStore = aboutDiaryMemoryStore || { status: () => ({ displayName: '关于日记的记忆', counts: {} }), search: async () => [], get: () => null, activateRun: () => ({ activated: 0 }) };
  diaryMemoryCurator = diaryMemoryCurator || { ensureJobs: () => 0, createRun: () => '', processBatch: async () => ({ skipped: true }), consolidatePatterns: async () => ({ skipped: true }), status: () => ({}) };
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({ contentSecurityPolicy: false }));

  if (config.allowedOrigin) {
    app.use((req, res, next) => {
      if (req.headers.origin === config.allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.get('/health', (req, res) => {
    const chromaStatus = vectorStore.status();
    res.json({
      ok: true,
      service: 'zhiban-agent',
      version: '0.6.1',
      continuityId: blueprint.continuityId,
      bGpeVersion: blueprint.version,
      llmConfigured: llm.enabled,
      chroma: {
        configured: chromaStatus.configured,
        enabled: chromaStatus.enabled,
        queue: chromaStatus.queue,
        lastSuccessAt: chromaStatus.lastSuccessAt
      },
      scheduler: scheduler.status(),
      assets: {
        enabled: true,
        maxBytes: assetStore.maxBytes,
        vectors: assetVectorStore.status(),
        documents: assetDocumentStore.status(),
        documentVectors: assetDocumentVectorStore.status()
      },
      diary: { recallEnabled: config.diary.recallEnabled, documents: diaryStore.status().length, vectors: diaryVectorStore.status(),
        aboutDiaryMemories: aboutDiaryMemoryStore.status(), aboutDiaryMemoryVectors: diaryMemoryVectorStore.status() }
    });
  });

  app.use('/api', (req, res, next) => {
    if (!config.authToken) return next();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const actual = Buffer.from(token || '');
    const expected = Buffer.from(config.authToken);
    if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  app.get('/api/v1/status', (req, res) => {
    const counts = {};
    for (const table of [
      'chats', 'messages', 'external_turns', 'memory_fragments', 'entities', 'episodes', 'sagas',
      'persona_candidates', 'vector_index_jobs', 'assets', 'asset_annotations', 'message_assets', 'asset_vector_jobs',
      'asset_documents', 'asset_document_units', 'asset_document_vector_jobs',
      'diary_documents', 'diary_entries', 'diary_chunks', 'diary_vector_jobs',
      'diary_memory_runs', 'about_diary_memories', 'diary_memory_sources', 'diary_memory_vector_jobs', 'diary_memory_extraction_jobs'
    ]) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    }
    const memoryWriteStates = Object.fromEntries(db.prepare(`
      SELECT write_state, COUNT(*) AS count FROM memory_fragments GROUP BY write_state
    `).all().map((row) => [row.write_state, row.count]));
    res.json({
      counts,
      memoryWriteStates,
      memoryWritePolicy: {
        activeConfidence: config.scribeActiveConfidence,
        observedConfidence: config.scribeObservedConfidence
      },
      scheduler: scheduler.status(),
      llmConfigured: llm.enabled,
      chroma: vectorStore.status(),
      assets: { vectors: assetVectorStore.status(), documents: assetDocumentStore.status(), documentVectors: assetDocumentVectorStore.status() },
      diary: diaryVectorStore.status(),
      aboutDiaryMemories: { ...aboutDiaryMemoryStore.status(), vectors: diaryMemoryVectorStore.status() }
    });
  });

  app.post('/api/v1/assets', express.raw({ type: () => true, limit: config.assetMaxBytes }), (req, res, next) => {
    try {
      const asset = assetStore.ingest(req.body, {
        filename: req.query.filename,
        kind: req.query.kind,
        mimeType: req.headers['content-type'],
        caption: req.query.caption,
        sourcePlatform: req.query.sourcePlatform,
        sourceSessionId: req.query.sourceSessionId
      });
      setImmediate(() => assetVectorStore.flushPending().catch((error) => {
        console.error('[asset-index] Flush failed:', error.message);
      }));
      res.status(201).json({ asset });
    } catch (error) { next(error); }
  });

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/v1/assets/search', async (req, res, next) => {
    try {
      const query = String(req.query.q || '').trim();
      const kind = String(req.query.kind || '');
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
      const [baseAssets, documentMatches] = await Promise.all([
        assetStore.search({ query, kind, limit }),
        query && (!kind || kind === 'document') ? assetDocumentStore.search(query, { limit: Math.max(limit, 8) }) : []
      ]);
      const assets = new Map(baseAssets.map((asset) => [asset.id, { ...asset, documentMatches: [] }]));
      for (const match of documentMatches) {
        const detail = assets.get(match.assetId) || assetStore.get(match.assetId)?.asset;
        if (!detail || (kind && detail.kind !== kind)) continue;
        const current = assets.get(match.assetId) || { ...detail, documentMatches: [] };
        current.documentMatches.push(match);
        assets.set(match.assetId, current);
      }
      const orderedIds = [...new Set([...documentMatches.map((item) => item.assetId), ...baseAssets.map((item) => item.id)])];
      res.json({ assets: orderedIds.filter((id) => assets.has(id)).slice(0, limit).map((id) => assets.get(id)) });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/assets/:id', (req, res) => {
    const result = assetStore.get(req.params.id);
    if (!result) return res.status(404).json({ error: 'asset_not_found' });
    res.json({ ...result, document: assetDocumentStore.get(req.params.id) });
  });

  app.get('/api/v1/assets/:id/content', (req, res) => {
    const result = assetStore.content(req.params.id);
    if (!result) return res.status(404).json({ error: 'asset_content_not_found' });
    res.type(result.asset.mimeType);
    res.setHeader('Content-Length', result.asset.sizeBytes);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(result.asset.filename)}`);
    res.sendFile(result.filePath);
  });

  app.post('/api/v1/assets/:id/annotations', (req, res, next) => {
    try {
      const annotation = assetStore.addAnnotation(req.params.id, req.body);
      if (!annotation) return res.status(404).json({ error: 'asset_not_found' });
      setImmediate(() => assetVectorStore.flushPending().catch((error) => {
        console.error('[asset-index] Flush failed:', error.message);
      }));
      res.status(201).json({ annotation, memoryChanged: false });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/assets/:id/links', (req, res, next) => {
    try {
      const link = assetStore.link(req.params.id, req.body.messageId, req.body.relation);
      if (!link) return res.status(404).json({ error: 'asset_not_found' });
      res.status(201).json({ link });
    } catch (error) { next(error); }
  });

  app.delete('/api/v1/assets/:id', (req, res) => {
    if (!assetStore.remove(req.params.id)) return res.status(404).json({ error: 'asset_not_found' });
    assetDocumentStore.archiveAsset(req.params.id);
    setImmediate(() => assetVectorStore.flushPending().catch((error) => {
      console.error('[asset-index] Delete flush failed:', error.message);
    }));
    res.json({ id: req.params.id, status: 'deleted' });
  });

  app.get('/api/v1/persona', (req, res) => {
    res.json({
      continuityId: blueprint.continuityId,
      bGpeVersion: blueprint.version,
      sections: getActivePersona(db, blueprint.continuityId),
      candidates: db.prepare(`
        SELECT * FROM persona_candidates WHERE continuity_id=? ORDER BY updated_at DESC
      `).all(blueprint.continuityId).map((candidate) => ({ ...candidate, evidence: parseJson(candidate.evidence_json) }))
    });
  });

  app.post('/api/v1/persona/sync', (req, res, next) => {
    try {
      res.json(syncBlueprint(db, config.bGpeRoot));
    } catch (error) { next(error); }
  });

  app.post('/api/v1/persona/candidates', (req, res, next) => {
    try {
      const id = scribe.addPersonaCandidate(req.body, req.body.evidence || []);
      res.status(201).json({ id });
    } catch (error) { next(error); }
  });

  app.patch('/api/v1/persona/candidates/:id', (req, res, next) => {
    try {
      const candidate = db.prepare('SELECT * FROM persona_candidates WHERE id=?').get(req.params.id);
      if (!candidate) return res.status(404).json({ error: 'candidate_not_found' });
      const decision = req.body.decision;
      if (!['approved', 'rejected'].includes(decision)) {
        return res.status(400).json({ error: 'decision_must_be_approved_or_rejected' });
      }
      if (decision === 'rejected') {
        db.prepare(`UPDATE persona_candidates SET status='rejected', decided_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(candidate.id);
        return res.json({ id: candidate.id, status: 'rejected' });
      }
      if (candidate.target_section_key === 'identity.core') {
        return res.status(409).json({ error: 'core_identity_must_be_changed_through_b_gpe' });
      }
      const existing = db.prepare(`
        SELECT * FROM persona_sections WHERE continuity_id=? AND section_key=? AND status='active'
      `).get(blueprint.continuityId, candidate.target_section_key);
      const content = existing?.content?.includes(candidate.claim)
        ? existing.content
        : `${existing?.content || ''}${existing?.content ? '\n' : ''}- ${candidate.claim}`;
      db.transaction(() => {
        if (existing) db.prepare(`UPDATE persona_sections SET status='superseded', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(existing.id);
        db.prepare(`
          INSERT INTO persona_sections (
            continuity_id, section_key, section_type, content, content_hash,
            authority, source_path, source_version, evidence_count, confidence, supersedes_id
          ) VALUES (?, ?, ?, ?, ?, 'learned', 'runtime/persona-candidate', ?, ?, ?, ?)
        `).run(
          blueprint.continuityId,
          candidate.target_section_key,
          candidate.target_section_key.startsWith('relationship') ? 'relationship_model' : candidate.target_section_key.startsWith('user') ? 'user_model' : 'self_model',
          content,
          hash(content),
          blueprint.version,
          candidate.evidence_count,
          candidate.confidence,
          existing?.id || null
        );
        db.prepare(`UPDATE persona_candidates SET status='approved', decided_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(candidate.id);
      })();
      res.json({ id: candidate.id, status: 'approved', targetSectionKey: candidate.target_section_key });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/chats', (req, res) => {
    const id = crypto.randomUUID();
    const title = String(req.body.title || 'New conversation').slice(0, 200);
    db.prepare('INSERT INTO chats(id,title) VALUES(?,?)').run(id, title);
    res.status(201).json({ id, title });
  });

  app.get('/api/v1/chats/:id/messages', (req, res) => {
    const chat = db.prepare('SELECT * FROM chats WHERE id=?').get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    res.json({ chat, messages: db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY id').all(chat.id) });
  });

  function ensureChat(chatId, title = 'New conversation') {
    const id = chatId || crypto.randomUUID();
    const existing = db.prepare('SELECT id FROM chats WHERE id=?').get(id);
    if (!existing) db.prepare('INSERT INTO chats(id,title) VALUES(?,?)').run(id, String(title).slice(0, 200));
    return id;
  }

  function saveMessage(chatId, role, content, metadata = {}) {
    const result = db.prepare(`INSERT INTO messages(chat_id,role,content,metadata_json) VALUES(?,?,?,?)`)
      .run(chatId, role, content, JSON.stringify(metadata));
    db.prepare(`UPDATE chats SET updated_at=CURRENT_TIMESTAMP, last_message_at=CURRENT_TIMESTAMP WHERE id=?`).run(chatId);
    return Number(result.lastInsertRowid);
  }

  app.post('/api/v1/hermes/turns', (req, res, next) => {
    try {
      const sessionId = String(req.body.sessionId || '').trim().slice(0, 500);
      const turnId = String(req.body.turnId || '').trim().slice(0, 500);
      const userContent = String(req.body.userContent || '').trim().slice(0, 100000);
      const assistantContent = String(req.body.assistantContent || '').trim().slice(0, 100000);
      const platform = String(req.body.platform || '').trim().slice(0, 100);
      const externalUserId = String(req.body.userId || '').trim().slice(0, 500);
      const conversationMode = normalizeConversationMode(req.body.conversationMode);
      const memoryEligible = conversationMode === 'companion' && req.body.processMemory !== false;
      if (!sessionId || !turnId || !userContent || !assistantContent) {
        return res.status(400).json({ error: 'sessionId_turnId_userContent_assistantContent_are_required' });
      }
      const prior = db.prepare(`
        SELECT * FROM external_turns WHERE provider='hermes' AND external_session_id=? AND external_turn_id=?
      `).get(sessionId, turnId);
      if (prior) return res.json({ deduplicated: true, chatId: prior.chat_id, turn: prior });
      const chatId = `hermes:${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
      let userMessageId;
      let assistantMessageId;
      db.transaction(() => {
        ensureChat(chatId, `Hermes ${platform || 'conversation'}`);
        const common = { provider: 'hermes', externalSessionId: sessionId, externalTurnId: turnId, platform, externalUserId,
          conversationMode, memoryEligible };
        userMessageId = saveMessage(chatId, 'user', userContent, common);
        const retrievedDiaryIds = [...new Set(Array.isArray(req.body.retrievedDiaryIds) ? req.body.retrievedDiaryIds.map(String) : [])].slice(0, 20);
        const retrievedDiaryMemoryIds = [...new Set(Array.isArray(req.body.retrievedDiaryMemoryIds) ? req.body.retrievedDiaryMemoryIds.map(String) : [])].slice(0, 20);
        const retrievedTheoryUnitIds = [...new Set(Array.isArray(req.body.retrievedTheoryUnitIds) ? req.body.retrievedTheoryUnitIds.map(String) : [])].slice(0, 20);
        assistantMessageId = saveMessage(chatId, 'assistant', assistantContent, { ...common, retrievedDiaryIds, retrievedDiaryMemoryIds, retrievedTheoryUnitIds });
        if (!memoryEligible) {
          db.prepare('UPDATE messages SET memory_processed=1 WHERE id IN (?,?)').run(userMessageId, assistantMessageId);
        }
        db.prepare(`
          INSERT INTO external_turns(
            provider,external_session_id,external_turn_id,chat_id,
            user_message_id,assistant_message_id,platform,external_user_id
          ) VALUES('hermes',?,?,?,?,?,?,?)
        `).run(sessionId, turnId, chatId, userMessageId, assistantMessageId, platform, externalUserId);
        for (const assetId of [...new Set(Array.isArray(req.body.assetIds) ? req.body.assetIds : [])].slice(0, 20)) {
          if (db.prepare("SELECT id FROM assets WHERE id=? AND status='active'").get(String(assetId))) {
            db.prepare(`INSERT OR IGNORE INTO message_assets(message_id,asset_id,relation) VALUES(?,?,'attachment')`)
              .run(userMessageId, String(assetId));
          }
        }
      })();
      if (memoryEligible) {
        setImmediate(() => scribe.processChat(chatId, { force: true }).catch((error) => {
          console.error('[hermes-sync] Scribe failed:', error.message);
        }));
      }
      res.status(201).json({
        deduplicated: false,
        chatId,
        userMessageId,
        assistantMessageId,
        conversationMode,
        memoryEligible,
        memoryProcessingQueued: memoryEligible,
        assetIds: db.prepare('SELECT asset_id FROM message_assets WHERE message_id=? ORDER BY asset_id')
          .all(userMessageId).map((row) => row.asset_id)
      });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/hermes/context', async (req, res, next) => {
    try {
      const query = String(req.body.query || '').trim();
      if (!query) return res.status(400).json({ error: 'query_is_required' });
      const conversationMode = normalizeConversationMode(req.body.conversationMode);
      if (conversationMode !== 'companion') {
        return res.json({
          continuityId: blueprint.continuityId,
          bGpeVersion: blueprint.version,
          conversationMode,
          context: '',
          memories: [],
          aboutDiaryMemories: [],
          diaryMemories: [],
          personalTheoryMemories: [],
          retrievedDiaryIds: [],
          retrievedDiaryMemoryIds: [],
          retrievedTheoryUnitIds: [],
          states: [],
          learnedPersona: []
        });
      }
      res.json({
        continuityId: blueprint.continuityId,
        bGpeVersion: blueprint.version,
        conversationMode,
        ...(await promptBuilder.buildHermesContext(query))
      });
    } catch (error) { next(error); }
  });

  async function chat(body) {
    const message = String(body.message || '').trim();
    if (!message) {
      const error = new Error('message is required');
      error.statusCode = 400;
      throw error;
    }
    const chatId = ensureChat(body.chatId);
    const userMessageId = saveMessage(chatId, 'user', message);
    const context = await promptBuilder.build(message);
    if (!llm.enabled) {
      return { chatId, userMessageId, reply: null, status: 'llm_disabled', context };
    }
    const history = db.prepare(`
      SELECT role, content FROM messages WHERE chat_id=? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 20
    `).all(chatId).reverse();
    const reply = await llm.complete([
      { role: 'system', content: context.system },
      ...history
    ], { temperature: 0.7, maxTokens: 2500 });
    const assistantMessageId = saveMessage(chatId, 'assistant', reply);
    if (body.processMemory) await scribe.processChat(chatId, { force: true });
    return { chatId, userMessageId, assistantMessageId, reply, status: 'completed', context: { memories: context.memories } };
  }

  app.post('/api/v1/chat', async (req, res, next) => {
    try {
      const result = await chat(req.body);
      res.status(result.status === 'llm_disabled' ? 202 : 200).json(result);
    } catch (error) { next(error); }
  });

  app.post('/api/v1/chat/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      send('ready', { transport: 'sse', note: 'Provider token streaming is reserved for the server deployment phase.' });
      const result = await chat(req.body);
      if (result.reply) send('delta', { text: result.reply });
      send('done', result);
    } catch (error) {
      send('error', { error: error.message });
    } finally {
      res.end();
    }
  });

  app.post('/api/v1/context/preview', async (req, res, next) => {
    try {
      const message = String(req.body.message || '').trim();
      if (!message) return res.status(400).json({ error: 'message_is_required' });
      res.json(await promptBuilder.build(message));
    } catch (error) { next(error); }
  });

  app.post('/api/v1/memories/ingest', async (req, res, next) => {
    try {
      const id = scribe.insertFragment(req.body, {
        chatId: req.body.sourceChatId,
        messageIds: req.body.sourceMessageIds,
        sourceDate: req.body.sourceDate
      });
      archivist.lightweightCycle();
      const vectors = await vectorStore.flushPending();
      res.status(201).json({ id, vectors });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/memories/search', async (req, res, next) => {
    try {
      res.json({ results: await librarian.searchHybrid(req.query.q || '', Math.min(Number(req.query.limit) || 12, 50)) });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/memories/:id/source', (req, res) => {
    const traced = librarian.traceFragment(Number(req.params.id));
    if (!traced) return res.status(404).json({ error: 'memory_not_found' });
    res.json(traced);
  });

  app.post('/api/v1/memories/:id/correct', async (req, res, next) => {
    try {
      const fragment = db.prepare('SELECT * FROM memory_fragments WHERE id=?').get(req.params.id);
      if (!fragment) return res.status(404).json({ error: 'memory_not_found' });
      const correctText = String(req.body.correctText || '').trim();
      const reason = String(req.body.reason || '').trim();
      if (!correctText) return res.status(400).json({ error: 'correctText_is_required' });
      if (correctText === fragment.content) return res.status(400).json({ error: 'correction_does_not_change_memory' });
      const sourceMessageId = req.body.sourceMessageId == null ? null : Number(req.body.sourceMessageId);
      let correctionId;
      db.transaction(() => {
        const correction = db.prepare(`
          INSERT INTO corrections (
            target_type, target_id, wrong_text, correct_text, reason, source_message_id
          ) VALUES ('memory_fragment', ?, ?, ?, ?, ?)
        `).run(fragment.id, fragment.content, correctText, reason, sourceMessageId);
        correctionId = Number(correction.lastInsertRowid);
        db.prepare(`
          UPDATE memory_fragments
          SET content=?, confidence=?, write_state='active', status='active', updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(correctText, Math.min(Number(req.body.confidence) || fragment.confidence, 1), fragment.id);
      })();
      vectorStore.enqueueUpsert(fragment.id);
      const vectors = await vectorStore.flushPending();
      res.json({ id: fragment.id, correctionId, content: correctText, vectors });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/pipeline/scribe', async (req, res, next) => {
    try { res.json(await scribe.processChat(req.body.chatId, { force: true })); } catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/archivist', async (req, res, next) => {
    try { res.json(req.body.deep ? await archivist.deepCycle() : archivist.lightweightCycle()); } catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/tick', async (req, res, next) => {
    try { res.json(await scheduler.tick()); } catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/vectors', async (req, res, next) => {
    try {
      const rebuild = req.body.reindexAll
        ? await vectorStore.rebuildAll()
        : { removed: 0, queued: 0 };
      res.json({ ...rebuild, ...(await vectorStore.flushPending({ limit: req.body.limit })) });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/diary/search', async (req, res, next) => {
    try { res.json({ results: await diaryStore.search(req.query.q || '', Math.min(Number(req.query.limit) || 3, 8)) }); }
    catch (error) { next(error); }
  });
  app.get('/api/v1/diary/recall', async (req, res, next) => {
    try {
      const query = String(req.query.q || '').trim();
      if (!query) return res.status(400).json({ error: 'query_is_required' });
      const [memories, excerpts] = await Promise.all([
        aboutDiaryMemoryStore.search(query, Math.min(Number(req.query.limit) || 3, 8)),
        diaryStore.search(query, Math.min(Number(req.query.excerptLimit) || 3, 8))
      ]);
      res.json({ displayName: '关于日记的记忆', memories, excerpts });
    } catch (error) { next(error); }
  });
  app.get('/api/v1/diary/memories/:id', (req, res) => {
    const memory = aboutDiaryMemoryStore.get(req.params.id, { includeShadow: req.query.includeShadow === 'true' });
    if (!memory) return res.status(404).json({ error: 'about_diary_memory_not_found' });
    res.json({ memory });
  });
  app.get('/api/v1/diary/documents', (req, res) => res.json({ documents: diaryStore.status() }));
  app.get('/api/v1/diary/entries/:id', (req, res) => {
    const entry = diaryStore.entry(req.params.id);
    if (!entry) return res.status(404).json({ error: 'diary_entry_not_found' });
    res.json({ entry });
  });
  app.post('/api/v1/pipeline/assets/vectors', async (req, res, next) => {
    try {
      const queued = req.body.reindexAll ? assetVectorStore.reindexAll() : 0;
      res.json({ queued, ...(await assetVectorStore.flushPending({ limit: req.body.limit })) });
    } catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/assets/documents/vectors', async (req, res, next) => {
    try {
      const queued = req.body.reindexAll ? assetDocumentVectorStore.reindexAll() : 0;
      res.json({ queued, ...(await assetDocumentVectorStore.flushPending({ limit: req.body.limit })) });
    } catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/diary/vectors', async (req, res, next) => {
    try {
      const queued = req.body.reindexAll ? diaryVectorStore.reindexAll() : 0;
      res.json({ queued, ...(await diaryVectorStore.flushPending({ limit: req.body.limit })) });
    } catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/diary/memories/prepare', (req, res, next) => {
    try {
      const documentId = String(req.body.documentId || '').trim();
      if (!documentId) return res.status(400).json({ error: 'documentId_is_required' });
      const queued = diaryMemoryCurator.ensureJobs(documentId);
      const runId = diaryMemoryCurator.createRun(documentId, req.body.mode === 'active' ? 'active' : 'shadow');
      res.status(201).json({ runId, documentId, queued, mode: req.body.mode === 'active' ? 'active' : 'shadow' });
    } catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/diary/memories/batch', async (req, res, next) => {
    try { res.json(await diaryMemoryCurator.processBatch({ documentId: req.body.documentId, runId: req.body.runId, mode: req.body.mode })); }
    catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/diary/memories/patterns', async (req, res, next) => {
    try { res.json(await diaryMemoryCurator.consolidatePatterns({ documentId: req.body.documentId, runId: req.body.runId, mode: req.body.mode })); }
    catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/diary/memories/activate', (req, res, next) => {
    try { res.json(aboutDiaryMemoryStore.activateRun(req.body.runId)); } catch (error) { next(error); }
  });
  app.post('/api/v1/pipeline/diary/memories/vectors', async (req, res, next) => {
    try {
      const queued = req.body.reindexAll ? diaryMemoryVectorStore.reindexAll() : 0;
      res.json({ queued, ...(await diaryMemoryVectorStore.flushPending({ limit: req.body.limit })) });
    } catch (error) { next(error); }
  });
  app.get('/api/v1/chroma/status', async (req, res) => {
    res.json({ ...vectorStore.status(), heartbeat: await vectorStore.heartbeat() });
  });

  app.post('/api/v1/states', (req, res) => {
    const content = String(req.body.content || '').trim();
    const expiresAt = new Date(req.body.expiresAt);
    if (!content || Number.isNaN(expiresAt.getTime())) return res.status(400).json({ error: 'content_and_valid_expiresAt_are_required' });
    const result = db.prepare('INSERT INTO current_states(content,expires_at) VALUES(?,?)').run(content, expiresAt.toISOString());
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });
  app.patch('/api/v1/states/:id', (req, res) => {
    const status = req.body.status;
    if (!['resolved', 'expired'].includes(status)) return res.status(400).json({ error: 'status_must_be_resolved_or_expired' });
    const result = db.prepare(`UPDATE current_states SET status=?, resolution=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(status, String(req.body.resolution || ''), req.params.id);
    res.status(result.changes ? 200 : 404).json(result.changes ? { id: Number(req.params.id), status } : { error: 'state_not_found' });
  });

  app.get('/api/v1/universe', (req, res) => {
    const categoryLabels = { person: 'Social', place: 'Places', event: 'Events', hobby: 'Hobbies', project: 'Projects' };
    const categoryColors = { person: '#ff9966', place: '#6699ff', event: '#66cc99', hobby: '#ffcc66', project: '#cc99ff' };
    const entities = db.prepare(`
      SELECT * FROM entities
      WHERE status IN ('seed','active') AND fragment_count > 0
      ORDER BY fragment_count DESC, name
    `).all();
    const constellations = entities.map((entity) => {
      const stars = db.prepare(`
        SELECT mf.id, mf.content AS title, mf.content, mf.emotional_weight, mf.confidence,
               mf.status AS lifecycle, mf.source_date AS date, fe.relation
        FROM fragment_entities fe JOIN memory_fragments mf ON mf.id=fe.fragment_id
        WHERE fe.entity_id=?
          AND mf.write_state='active' AND mf.status!='tombstone'
        ORDER BY mf.emotional_weight DESC, mf.created_at DESC LIMIT 40
      `).all(entity.id).map((star) => ({ ...star, title: star.title.slice(0, 60) }));
      const episodes = db.prepare(`SELECT id,title,content,importance,date(valid_from) AS date FROM episodes WHERE entity_id=? ORDER BY importance DESC LIMIT 8`).all(entity.id);
      return {
        id: `e${entity.id}`,
        label: entity.name,
        description: entity.overview,
        currentStatus: entity.current_status,
        judgment: entity.judgment,
        category: entity.category,
        galaxyLabel: categoryLabels[entity.category] || entity.category,
        color: categoryColors[entity.category] || '#94a3b8',
        fragmentCount: entity.fragment_count,
        stars,
        episodes
      };
    });
    res.json({
      core: [
        { id: 'user', name: config.userDisplayName, role: 'user', color: '#e8b96d' },
        { id: 'companion', name: config.companionDisplayName || blueprint.companionName, role: 'ai', color: '#6d9e8b' }
      ],
      constellations,
      totals: {
        entities: constellations.length,
        fragments: constellations.reduce((sum, item) => sum + item.stars.length, 0),
        episodes: constellations.reduce((sum, item) => sum + item.episodes.length, 0)
      }
    });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('*path', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((error, req, res, next) => {
    console.error('[api]', error.stack || error.message);
    const statusCode = error.statusCode || (error.type === 'entity.too.large' ? 413 : 500);
    res.status(statusCode).json({ error: error.message });
  });
  return app;
}

module.exports = { createApp };

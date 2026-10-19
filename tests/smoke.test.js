const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntime } = require('../src/server');

let runtime;
let server;
let baseUrl;
let assetTempDir;

before(async () => {
  assetTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-aa-assets-'));
  runtime = createRuntime({
    config: {
      databasePath: ':memory:',
      assetStoragePath: assetTempDir,
      assetMaxBytes: 1024,
      bGpeRoot: path.resolve(__dirname, '../blueprint'),
      autoStartScheduler: false,
      userDisplayName: 'User',
      companionDisplayName: '知伴',
      llm: { baseUrl: '', apiKey: '', model: '' },
      embedding: { baseUrl: '', apiKey: '', model: '', dimensions: 0 },
      chroma: { enabled: false, url: '' },
      assetChroma: { enabled: false, url: '' }
    }
  });
  await new Promise((resolve) => {
    server = runtime.app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  runtime.scheduler.stop();
  await new Promise((resolve) => server.close(resolve));
  runtime.db.close();
  fs.rmSync(assetTempDir, { recursive: true, force: true });
});

async function json(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

test('health exposes B-GPE continuity without an LLM', async () => {
  const { response, body } = await json('/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.version, '0.6.1');
  assert.equal(body.continuityId, 'companion-example-001');
  assert.equal(body.bGpeVersion, '1.0.0');
  assert.equal(body.llmConfigured, false);
});

test('browser entry point serves the clean constellation interface', async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="star-map"/);
  assert.doesNotMatch(html, /Clara|Draco|Sanctuary/);
});

test('B-GPE sources are synchronized as versioned persona sections', async () => {
  const { body } = await json('/api/v1/persona');
  const keys = body.sections.map((section) => section.section_key);
  assert.deepEqual(keys.slice(0, 4), [
    'identity.core',
    'user.curated',
    'memory.semantic',
    'memory.relationship'
  ]);
  assert.equal(body.sections.find((section) => section.section_key === 'identity.core').authority, 'core');
});

test('Hermes turn synchronization is idempotent and keeps both sides of the conversation', async () => {
  const payload = {
    sessionId: 'hermes-session-1',
    turnId: 'turn-1',
    userContent: 'Please remember that our garden project is called Moonseed.',
    assistantContent: 'I will keep Moonseed connected to our garden project.',
    platform: 'telegram',
    userId: 'owner-1'
  };
  const first = await json('/api/v1/hermes/turns', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.deduplicated, false);
  const duplicate = await json('/api/v1/hermes/turns', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.deduplicated, true);
  const transcript = await json(`/api/v1/chats/${first.body.chatId}/messages`);
  assert.deepEqual(transcript.body.messages.map((message) => message.role), ['user', 'assistant']);
  const metadata = JSON.parse(transcript.body.messages[0].metadata_json);
  assert.equal(metadata.platform, 'telegram');
  assert.equal(metadata.conversationMode, 'companion');
  assert.equal(metadata.memoryEligible, true);
});

test('ordinary Hermes mode keeps transcripts but blocks recall and Scribe eligibility', async () => {
  const turn = await json('/api/v1/hermes/turns', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'hermes-normal-session',
      turnId: 'normal-turn-1',
      userContent: '普通模式下查询一个技术问题。',
      assistantContent: '这是普通 Hermes 的技术回答。',
      conversationMode: 'normal',
      processMemory: true
    })
  });
  assert.equal(turn.response.status, 201);
  assert.equal(turn.body.conversationMode, 'normal');
  assert.equal(turn.body.memoryEligible, false);
  assert.equal(turn.body.memoryProcessingQueued, false);

  const transcript = await json(`/api/v1/chats/${turn.body.chatId}/messages`);
  assert.deepEqual(transcript.body.messages.map((message) => message.memory_processed), [1, 1]);
  for (const message of transcript.body.messages) {
    const metadata = JSON.parse(message.metadata_json);
    assert.equal(metadata.conversationMode, 'normal');
    assert.equal(metadata.memoryEligible, false);
  }

  const context = await json('/api/v1/hermes/context', {
    method: 'POST',
    body: JSON.stringify({ query: 'Moonseed', conversationMode: 'normal' })
  });
  assert.equal(context.response.status, 200);
  assert.equal(context.body.conversationMode, 'normal');
  assert.equal(context.body.context, '');
  assert.deepEqual(context.body.memories, []);
});

test('素材库保存、注释、消息关联、搜索和原件返还保持可追溯', async () => {
  const original = Buffer.from('small-test-photo');
  const upload = await fetch(`${baseUrl}/api/v1/assets?filename=${encodeURIComponent('晚霞.jpg')}&kind=photo&caption=${encodeURIComponent('散步时看到的云')}&sourcePlatform=weixin&sourceSessionId=session-photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: original
  });
  const uploaded = await upload.json();
  assert.equal(upload.status, 201);
  assert.equal(uploaded.asset.kind, 'photo');
  assert.equal(uploaded.asset.filename, '晚霞.jpg');

  const annotation = await json(`/api/v1/assets/${uploaded.asset.id}/annotations`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'vision',
      content: '橙色云层位于河岸建筑上方。',
      authority: 'model',
      confidence: 0.8,
      provider: 'test-vision'
    })
  });
  assert.equal(annotation.response.status, 201);
  assert.equal(annotation.body.memoryChanged, false);

  const turn = await json('/api/v1/hermes/turns', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'asset-session',
      turnId: 'asset-turn-1',
      userContent: '这是我散步时看到的晚霞。',
      assistantContent: '我看见了，也把原图保存好了。',
      platform: 'weixin',
      userId: 'owner-1',
      assetIds: [uploaded.asset.id],
      processMemory: false
    })
  });
  assert.equal(turn.response.status, 201);
  assert.deepEqual(turn.body.assetIds, [uploaded.asset.id]);

  const search = await json(`/api/v1/assets/search?q=${encodeURIComponent('河岸 橙色云层')}&kind=photo`);
  assert.equal(search.response.status, 200);
  assert.equal(search.body.assets[0].id, uploaded.asset.id);

  const detail = await json(`/api/v1/assets/${uploaded.asset.id}`);
  assert.equal(detail.body.messages[0].content, '这是我散步时看到的晚霞。');
  assert.equal(detail.body.annotations.some((item) => item.annotation_type === 'vision'), true);

  const downloaded = await fetch(`${baseUrl}/api/v1/assets/${uploaded.asset.id}/content`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original);
});

test('预留的语音转写注释不会自动改变聊天消息或记忆', async () => {
  const upload = await fetch(`${baseUrl}/api/v1/assets?filename=voice.silk&kind=audio`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/silk' },
    body: Buffer.from('test-voice')
  });
  const uploaded = await upload.json();
  const messagesBefore = runtime.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
  const fragmentsBefore = runtime.db.prepare('SELECT COUNT(*) AS count FROM memory_fragments').get().count;
  const result = await json(`/api/v1/assets/${uploaded.asset.id}/annotations`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'transcript',
      content: '未来的语音转写接口。',
      authority: 'model',
      confidence: 0.7,
      provider: 'reserved-test'
    })
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.memoryChanged, false);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, messagesBefore);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM memory_fragments').get().count, fragmentsBefore);
});

test('manual ingestion creates fragments, entities, search results, and star-map data', async () => {
  const ingest = await json('/api/v1/memories/ingest', {
    method: 'POST',
    body: JSON.stringify({
      type: 'preference',
      entity: 'Coffee',
      content: 'The user prefers washed Ethiopian coffee.',
      emotional_weight: 0.4,
      confidence: 0.95,
      entities: [{ name: 'Coffee', category: 'hobby', relation: 'preference' }]
    })
  });
  assert.equal(ingest.response.status, 201);
  const search = await json('/api/v1/memories/search?q=Ethiopian');
  assert.equal(search.response.status, 200);
  assert.ok(search.body.results.some((result) => result.content.includes('Ethiopian')));
  const universe = await json('/api/v1/universe');
  assert.equal(universe.body.totals.entities, 1);
  assert.equal(universe.body.constellations[0].label, 'Coffee');
  assert.equal(universe.body.constellations[0].stars.length, 1);
});

test('memory correction updates retrieval and preserves the old version in its trace', async () => {
  const ingest = await json('/api/v1/memories/ingest', {
    method: 'POST',
    body: JSON.stringify({
      type: 'preference',
      entity: 'Tea',
      content: 'The user prefers green tea.',
      confidence: 0.8,
      entities: [{ name: 'Tea', category: 'hobby', relation: 'preference' }]
    })
  });
  const corrected = await json(`/api/v1/memories/${ingest.body.id}/correct`, {
    method: 'POST',
    body: JSON.stringify({
      correctText: 'The user currently prefers oolong tea.',
      reason: 'The user explicitly corrected the earlier preference.',
      confidence: 0.95
    })
  });
  assert.equal(corrected.response.status, 200);
  const search = await json('/api/v1/memories/search?q=oolong');
  assert.ok(search.body.results.some((result) => result.id === ingest.body.id));
  const trace = await json(`/api/v1/memories/${ingest.body.id}/source`);
  assert.equal(trace.body.fragment.content, 'The user currently prefers oolong tea.');
  assert.equal(trace.body.corrections[0].wrong_text, 'The user prefers green tea.');
  assert.equal(trace.body.corrections[0].correct_text, 'The user currently prefers oolong tea.');
});

test('old frozen memories remain archived without losing their content', () => {
  const original = 'This archived memory must remain intact after ninety days.';
  const inserted = runtime.db.prepare(`
    INSERT INTO memory_fragments(
      type, entity, content, confidence, status, created_at, last_accessed_at
    ) VALUES(
      'reflection', 'Archive policy', ?, 0.9, 'frozen',
      datetime('now', '-100 days'), datetime('now', '-100 days')
    )
  `).run(original);
  const jobsBefore = runtime.db.prepare('SELECT COUNT(*) AS count FROM vector_index_jobs').get().count;

  const lifecycle = runtime.archivist.lightweightCycle();
  const fragment = runtime.db.prepare('SELECT status, content FROM memory_fragments WHERE id=?')
    .get(inserted.lastInsertRowid);
  const jobsAfter = runtime.db.prepare('SELECT COUNT(*) AS count FROM vector_index_jobs').get().count;

  assert.equal(fragment.status, 'frozen');
  assert.equal(fragment.content, original);
  assert.ok(lifecycle.archived >= 1);
  assert.equal(lifecycle.tombstoned, 0);
  assert.equal(jobsAfter, jobsBefore);
});

test('Hermes context returns dynamic memory without duplicating B-GPE core identity', async () => {
  const result = await json('/api/v1/hermes/context', {
    method: 'POST',
    body: JSON.stringify({ query: 'Ethiopian coffee' })
  });
  assert.equal(result.response.status, 200);
  assert.match(result.body.context, /washed Ethiopian coffee/);
  assert.doesNotMatch(result.body.context, /Core identity/);
  assert.equal(result.body.continuityId, 'companion-example-001');
});

test('long natural-language memory queries keep SQL bindings aligned', async () => {
  const result = await json('/api/v1/memories/search?q=Which%20kind%20of%20tea%20does%20the%20user%20prefer%3F');
  assert.equal(result.response.status, 200);
  assert.ok(Array.isArray(result.body.results));
});

test('persona learning stays a candidate until an explicit decision', async () => {
  let candidateId;
  for (let i = 0; i < 3; i += 1) {
    const created = await json('/api/v1/persona/candidates', {
      method: 'POST',
      body: JSON.stringify({
        target_section_key: 'self.learned',
        claim: 'I tend to celebrate an achievement before planning the next step.',
        reason: 'Repeated interaction pattern',
        confidence: 0.8,
        evidence: [`conversation-${i + 1}`]
      })
    });
    candidateId = created.body.id;
  }
  let persona = (await json('/api/v1/persona')).body;
  const candidate = persona.candidates.find((item) => item.id === candidateId);
  assert.equal(candidate.status, 'pending');
  assert.equal(persona.sections.some((section) => section.section_key === 'self.learned'), false);

  const approved = await json(`/api/v1/persona/candidates/${candidateId}`, {
    method: 'PATCH',
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(approved.body.status, 'approved');
  persona = (await json('/api/v1/persona')).body;
  assert.equal(persona.sections.find((section) => section.section_key === 'self.learned').authority, 'learned');
});

test('chat endpoint is usable in memory-only mode and preserves the message', async () => {
  const result = await json('/api/v1/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'Hello, remember this later.' })
  });
  assert.equal(result.response.status, 202);
  assert.equal(result.body.status, 'llm_disabled');
  assert.ok(result.body.chatId);
  const transcript = await json(`/api/v1/chats/${result.body.chatId}/messages`);
  assert.equal(transcript.body.messages.length, 1);
  assert.equal(transcript.body.messages[0].role, 'user');
});

test('reserved SSE chat interface completes in memory-only mode', async () => {
  const response = await fetch(`${baseUrl}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Keep the streaming contract stable.' })
  });
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(stream, /event: ready/);
  assert.match(stream, /event: done/);
  assert.match(stream, /"status":"llm_disabled"/);
});

test('core identity cannot be approved through runtime learning', async () => {
  const created = await json('/api/v1/persona/candidates', {
    method: 'POST',
    body: JSON.stringify({
      target_section_key: 'identity.core',
      claim: 'Replace the core identity.',
      reason: 'test'
    })
  });
  const decision = await json(`/api/v1/persona/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(decision.response.status, 409);
  assert.equal(decision.body.error, 'core_identity_must_be_changed_through_b_gpe');
});

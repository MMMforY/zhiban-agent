// Synthetic gardening fixtures for the public edition; no personal diary entries.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { initializeDatabase } = require('../src/db');
const { createAboutDiaryMemoryStore, importanceScore } = require('../src/about-diary-memory-store');
const { createDiaryMemoryCurator } = require('../src/memory/diary-memory-curator');
const { createPromptBuilder } = require('../src/prompt');

function fixture() {
  const db = initializeDatabase(':memory:');
  const vectorIds = [];
  const vectorStore = { enabled: false, search: async () => [], enqueueUpsert: (id) => vectorIds.push(id), enqueueDelete: () => {} };
  const store = createAboutDiaryMemoryStore({ db, vectorStore, config: { enabled: true, recallEnabled: true, maxResults: 3, emotionalPeakThreshold: 0.75 } });
  db.prepare("INSERT INTO diary_import_runs(id,document_id,source_sha256) VALUES('import-1','doc-1','hash-1')").run();
  db.prepare(`INSERT INTO diary_documents(id,import_run_id,source_sha256,filename,storage_name,size_bytes,character_count,entry_count,chunk_count)
    VALUES('doc-1','import-1','hash-1','diary.md','hash.md',100,100,3,3)`).run();
  const entries = [
    ['entry-1', '2022-01-01', 1, '今天我非常惊讶，因为园艺计划被突然打破。我想立刻停工，但最后先出去走了一圈。'],
    ['entry-2', '2022-03-01', 60, '这次种植实验让我再次意识到，耐心并不是拒绝园艺活动，而是能够试验如何回应。'],
    ['entry-3', '2022-06-01', 152, '半年后我仍然认为，耐心意味着在园艺活动中保持试验，同时承担试验的后果。']
  ];
  for (const [id, date, day, content] of entries) {
    db.prepare(`INSERT INTO diary_entries(id,document_id,cycle_id,cycle_day_original,cycle_day_normalized,raw_label,absolute_date,date_status,date_confidence,source_line_start,source_line_end,content,content_sha256)
      VALUES(?, 'doc-1',1,?,?,?,?,'inferred',0.95,?,?,?,?)`).run(id, day, day, `第${day}天`, date, day, day, content, `${id}-hash`);
    db.prepare(`INSERT INTO diary_chunks(id,entry_id,document_id,chunk_index,content,content_sha256,absolute_date,cycle_id,cycle_day,source_line_start,source_line_end)
      VALUES(?,?, 'doc-1',0,?,?,?,1,?,?,?)`).run(`chunk-${id}`, id, content, `${id}-chunk-hash`, date, day, day, day);
  }
  db.prepare("UPDATE diary_documents SET status='active' WHERE id='doc-1'").run();
  db.prepare("UPDATE diary_entries SET status='active' WHERE document_id='doc-1'").run();
  db.prepare("UPDATE diary_chunks SET status='active' WHERE document_id='doc-1'").run();
  db.prepare("INSERT INTO diary_memory_runs(id,document_id,mode,model) VALUES('run-1','doc-1','active','fake')").run();
  return { db, store, vectorIds };
}

test('情绪峰值即使只出现一次也成为有原文证据的关于日记的记忆', () => {
  const { db, store, vectorIds } = fixture();
  const result = store.insert({
    category: 'emotional_peak', title: '园艺计划被打破时的强烈惊讶',
    content: '2022年1月1日，用户因园艺计划突然被打破而非常惊讶，产生立刻停工的冲动，随后试验先外出行走。',
    emotional_valence: -0.9, emotional_intensity: 0.92, trajectory_impact: 0.5, originality: 0.2,
    recurrence: 0.1, user_emphasis: 0.1, confidence: 0.96, themes: ['anger_conflict', 'autonomy'],
    evidence: [{ entry_id: 'entry-1', quote: '我非常惊讶，因为园艺计划被突然打破' }, { entry_id: 'entry-1', quote: '我想立刻停工，但最后先出去走了一圈' }]
  }, { documentId: 'doc-1', runId: 'run-1', status: 'active', model: 'fake' });
  assert.equal(result.accepted, true);
  assert.ok(result.importance >= 0.85);
  assert.equal(vectorIds.length, 1);
  const memory = store.get(result.id);
  assert.equal(memory.memoryKind, '关于日记的记忆');
  assert.equal(memory.sources.length, 2);
  db.close();
});

test('低强度情绪不能伪装成情绪峰值，长期模式需要跨时间直接证据', () => {
  const { db, store } = fixture();
  const low = store.insert({ category: 'emotional_peak', title: '轻微烦躁', content: '用户当时略感烦躁。', emotional_intensity: 0.3,
    evidence: [{ entry_id: 'entry-1', quote: '今天我非常惊讶' }] }, { documentId: 'doc-1', runId: 'run-1', status: 'active' });
  assert.equal(low.accepted, false);
  assert.equal(low.reason, 'emotional_peak_below_threshold');
  const pattern = store.insert({ category: 'long_term_pattern', title: '园艺活动中的耐心',
    content: '2022年上半年，用户反复把耐心理解为园艺活动中的试验能力及对试验后果的承担，而非简单拒绝园艺活动。',
    emotional_intensity: 0.5, trajectory_impact: 0.8, originality: 0.8, recurrence: 0.9, confidence: 0.9,
    themes: ['autonomy', 'relationships'], evidence: [
      { entry_id: 'entry-1', quote: '我想立刻停工，但最后先出去走了一圈' },
      { entry_id: 'entry-2', quote: '耐心并不是拒绝园艺活动，而是能够试验如何回应' },
      { entry_id: 'entry-3', quote: '耐心意味着在园艺活动中保持试验，同时承担试验的后果' }
    ] }, { documentId: 'doc-1', runId: 'run-1', status: 'active' });
  assert.equal(pattern.accepted, true);
  assert.ok(pattern.importance > 0.6);
  db.close();
});

test('重要性同时考虑情绪、轨迹、原创性、重复与用户强调', () => {
  const ordinary = importanceScore({ emotional_intensity: 0.2, trajectory_impact: 0.2, originality: 0.2, recurrence: 0.2, user_emphasis: 0.2 });
  const intense = importanceScore({ category: 'emotional_peak', emotional_intensity: 0.95, trajectory_impact: 0.2, originality: 0.1, recurrence: 0, user_emphasis: 0 });
  assert.ok(intense > ordinary);
  assert.ok(intense >= 0.85);
});

test('整理器以影子模式处理日记，并保留情绪峰值的逐字证据', async () => {
  const { db, store } = fixture();
  const llm = { enabled: true, completeJson: async () => ({ memories: [{
    category: 'emotional_peak', title: '园艺计划破裂时的惊讶',
    content: '2022年1月1日，用户因园艺计划突然被打破而非常惊讶，并产生停工的冲动。',
    date_start: '2022-01-01', date_end: '2022-01-01', emotional_valence: -0.9,
    emotional_intensity: 0.92, trajectory_impact: 0.5, originality: 0.2, recurrence: 0.1,
    user_emphasis: 0.1, confidence: 0.96, themes: ['anger_conflict'],
    evidence: [{ entry_id: 'entry-1', quote: '我非常惊讶，因为园艺计划被突然打破' }]
  }] }) };
  const curator = createDiaryMemoryCurator({ db, llm, store, config: { extractionBatchEntries: 10, extractionMaxChars: 9000, emotionalPeakThreshold: 0.75 }, model: 'fake' });
  curator.ensureJobs('doc-1');
  const runId = curator.createRun('doc-1', 'shadow');
  const result = await curator.processBatch({ documentId: 'doc-1', runId, mode: 'shadow' });
  assert.equal(result.processedEntries, 3);
  assert.equal(result.accepted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM about_diary_memories WHERE run_id=? AND status='shadow'").get(runId).count, 1);
  assert.equal(curator.status('doc-1').jobs.done, 3);
  db.close();
});

test('外部整理API失败的日记条目可以显式重新排队，不能静默遗漏', () => {
  const { db, store } = fixture();
  const curator = createDiaryMemoryCurator({ db, llm: { enabled: true }, store, config: {}, model: 'fake' });
  curator.ensureJobs('doc-1');
  db.prepare("UPDATE diary_memory_extraction_jobs SET status='failed',attempts=3,last_error='temporary outage' WHERE document_id='doc-1'").run();
  const result = curator.retryFailed('doc-1', { resetAttempts: true });
  assert.equal(result.queued, 3);
  const state = db.prepare("SELECT status,attempts,last_error FROM diary_memory_extraction_jobs WHERE document_id='doc-1' LIMIT 1").get();
  assert.equal(state.status, 'pending');
  assert.equal(state.attempts, 0);
  assert.equal(state.last_error, '');
  db.close();
});

test('关于日记的记忆与普通记忆同在Hermes相关记忆区，并回传防回声ID', async () => {
  const { db, store } = fixture();
  const inserted = store.insert({
    category: 'emotional_peak', title: '园艺计划被打破时的强烈惊讶',
    content: '2022年1月1日，用户因园艺计划突然被打破而非常惊讶，随后试验先停工现场平复。',
    emotional_intensity: 0.92, trajectory_impact: 0.5, confidence: 0.96,
    themes: ['anger_conflict'], evidence: [{ entry_id: 'entry-1', quote: '园艺计划被突然打破' }]
  }, { documentId: 'doc-1', runId: 'run-1', status: 'active', model: 'fake' });
  assert.equal(inserted.accepted, true);
  const builder = createPromptBuilder({
    db,
    continuityId: 'companion-example-001',
    librarian: { searchHybrid: async () => [{ id: 'ordinary-1', content: '用户重视兑现园艺计划。', recallPermission: 'cite' }] },
    diaryStore: { search: async () => [] },
    aboutDiaryMemoryStore: { search: async () => [store.get(inserted.id)] }
  });
  const context = await builder.buildHermesContext('园艺计划突然被打破');
  const ordinaryPosition = context.context.indexOf('[memory:ordinary-1');
  const diaryPosition = context.context.indexOf(`[关于日记的记忆:${inserted.id}`);
  const evidenceHeading = context.context.indexOf('## Supporting diary evidence');
  assert.ok(ordinaryPosition > 0);
  assert.ok(diaryPosition > ordinaryPosition);
  assert.ok(diaryPosition < evidenceHeading);
  assert.deepEqual(context.retrievedDiaryMemoryIds, [inserted.id]);
  db.close();
});

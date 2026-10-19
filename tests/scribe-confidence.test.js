const assert = require('node:assert/strict');
const { test } = require('node:test');
const { initializeDatabase } = require('../src/db');
const { createLibrarian } = require('../src/memory/librarian');
const { classifyConfidence, createScribe } = require('../src/memory/scribe');

test('confidence policy has active, observed, and discarded tiers', () => {
  const policy = { active: 0.95, observed: 0.6 };
  assert.equal(classifyConfidence(0.95, policy), 'active');
  assert.equal(classifyConfidence(0.8, policy), 'observed');
  assert.equal(classifyConfidence(0.59, policy), 'discarded');
});

test('Scribe quarantines medium-confidence fragments and drops low-confidence fragments', async () => {
  const db = initializeDatabase(':memory:');
  let userMessageId;
  const enqueued = [];
  const vectorStore = {
    enabled: false,
    enqueueUpsert(id) { enqueued.push(id); },
    async search() { return []; }
  };
  const llm = {
    enabled: true,
    async completeJson() {
      return {
        fragments: [
          {
            type: 'preference',
            entity: 'Coffee',
            content: 'The user explicitly prefers washed coffee.',
            confidence: 0.97,
            memory_scope: 'user_fact',
            evidence_message_ids: [userMessageId]
          },
          {
            type: 'reflection',
            entity: 'Work',
            content: 'The user may be uncertain about changing jobs.',
            confidence: 0.8,
            memory_scope: 'user_fact',
            evidence_message_ids: [userMessageId]
          },
          {
            type: 'observation',
            entity: 'Cafe',
            content: 'The user will open a cafe.',
            confidence: 0.4,
            memory_scope: 'user_fact',
            evidence_message_ids: [userMessageId]
          }
        ],
        persona_candidates: []
      };
    }
  };
  const scribe = createScribe({
    db,
    llm,
    continuityId: 'companion-example-001',
    vectorStore,
    confidencePolicy: { active: 0.95, observed: 0.6 }
  });
  db.prepare(`INSERT INTO chats(id,title,last_message_at) VALUES('confidence-chat','test',CURRENT_TIMESTAMP)`).run();
  userMessageId = Number(db.prepare(`INSERT INTO messages(chat_id,role,content) VALUES('confidence-chat','user','Remember only supported facts.')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO messages(chat_id,role,content) VALUES('confidence-chat','assistant','Understood.')`).run();

  const result = await scribe.processChat('confidence-chat', { force: true });
  const rows = db.prepare(`SELECT id,content,write_state FROM memory_fragments ORDER BY id`).all();
  const librarian = createLibrarian(db, vectorStore);

  assert.equal(result.processed, 2);
  assert.equal(result.activeFragmentIds.length, 1);
  assert.equal(result.observedFragmentIds.length, 1);
  assert.equal(result.discardedFragmentCount, 1);
  assert.deepEqual(rows.map((row) => row.write_state), ['active', 'observed']);
  assert.deepEqual(JSON.parse(db.prepare(`SELECT source_message_ids FROM memory_fragments WHERE id=?`).get(rows[0].id).source_message_ids), [userMessageId]);
  assert.deepEqual(enqueued, [rows[0].id]);
  assert.equal(librarian.search('washed coffee').length, 1);
  assert.equal(librarian.search('changing jobs').length, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM schema_version WHERE version=3`).get().count, 1);

  db.close();
});

test('Scribe rejects assistant-recalled user facts but keeps a new assistant contribution', async () => {
  const db = initializeDatabase(':memory:');
  let assistantMessageId;
  let extractionTranscript = '';
  const llm = {
    enabled: true,
    async completeJson(messages) {
      extractionTranscript = messages.at(-1).content;
      return {
        fragments: [
          {
            type: 'event',
            entity: 'Lunch',
            content: 'The user ate braised beef yesterday.',
            confidence: 1,
            memory_scope: 'user_fact',
            evidence_message_ids: [assistantMessageId]
          },
          {
            type: 'reflection',
            entity: 'Memory stewardship',
            content: 'The assistant chose to preserve both sides of their shared history without duplicating recalled facts.',
            confidence: 0.97,
            memory_scope: 'assistant_contribution',
            evidence_message_ids: [assistantMessageId]
          }
        ],
        persona_candidates: []
      };
    }
  };
  const scribe = createScribe({
    db,
    llm,
    continuityId: 'companion-example-001',
    vectorStore: { enqueueUpsert() {} },
    confidencePolicy: { active: 0.95, observed: 0.6 }
  });
  db.prepare(`INSERT INTO chats(id,title,last_message_at) VALUES('echo-chat','test',CURRENT_TIMESTAMP)`).run();
  const userMessageId = Number(db.prepare(`
    INSERT INTO messages(chat_id,role,content) VALUES('echo-chat','user','What do you remember about me?')
  `).run().lastInsertRowid);
  assistantMessageId = Number(db.prepare(`
    INSERT INTO messages(chat_id,role,content) VALUES('echo-chat','assistant','You ate braised beef yesterday. I want to preserve both sides of our shared history without duplicating recalled facts.')
  `).run().lastInsertRowid);

  const result = await scribe.processChat('echo-chat', { force: true });

  assert.match(extractionTranscript, new RegExp(`message_id=${userMessageId}`));
  assert.match(extractionTranscript, /What do you remember about me/);
  assert.match(extractionTranscript, /braised beef/);
  assert.equal(result.unsupportedFragmentCount, 1);
  const fragments = db.prepare(`SELECT content,source_message_ids FROM memory_fragments`).all();
  assert.equal(fragments.length, 1);
  assert.match(fragments[0].content, /preserve both sides/);
  assert.deepEqual(JSON.parse(fragments[0].source_message_ids), [assistantMessageId]);
  assert.deepEqual(
    db.prepare(`SELECT memory_processed FROM messages ORDER BY id`).all().map((row) => row.memory_processed),
    [1, 1]
  );

  db.close();
});

test('Scribe accepts a shared creation only when both roles provide evidence', async () => {
  const db = initializeDatabase(':memory:');
  let userMessageId;
  let assistantMessageId;
  const llm = {
    enabled: true,
    async completeJson() {
      return {
        fragments: [{
          type: 'event',
          entity: 'Moonseed',
          content: 'Together they named the garden project Moonseed.',
          confidence: 0.98,
          memory_scope: 'shared_creation',
          evidence_message_ids: [userMessageId, assistantMessageId]
        }],
        persona_candidates: []
      };
    }
  };
  const scribe = createScribe({
    db,
    llm,
    continuityId: 'companion-example-001',
    vectorStore: { enqueueUpsert() {} },
    confidencePolicy: { active: 0.95, observed: 0.6 }
  });
  db.prepare(`INSERT INTO chats(id,title,last_message_at) VALUES('shared-chat','test',CURRENT_TIMESTAMP)`).run();
  userMessageId = Number(db.prepare(`
    INSERT INTO messages(chat_id,role,content) VALUES('shared-chat','user','Let us call our garden project Moonseed.')
  `).run().lastInsertRowid);
  assistantMessageId = Number(db.prepare(`
    INSERT INTO messages(chat_id,role,content) VALUES('shared-chat','assistant','Moonseed it is; that name belongs to what we are making together.')
  `).run().lastInsertRowid);

  const result = await scribe.processChat('shared-chat', { force: true });
  const fragment = db.prepare(`SELECT content,source_message_ids FROM memory_fragments`).get();

  assert.equal(result.activeFragmentIds.length, 1);
  assert.match(fragment.content, /Moonseed/);
  assert.deepEqual(JSON.parse(fragment.source_message_ids), [userMessageId, assistantMessageId]);

  db.close();
});

test('Scribe permanently ignores transcript-only ordinary-mode messages', async () => {
  const db = initializeDatabase(':memory:');
  let extractionTranscript = '';
  const llm = {
    enabled: true,
    async completeJson(messages) {
      extractionTranscript = messages.at(-1).content;
      return { fragments: [], persona_candidates: [] };
    }
  };
  const scribe = createScribe({
    db,
    llm,
    continuityId: 'companion-example-001',
    vectorStore: { enqueueUpsert() {} },
    confidencePolicy: { active: 0.95, observed: 0.6 }
  });
  db.prepare(`INSERT INTO chats(id,title,last_message_at) VALUES('mode-chat','test',CURRENT_TIMESTAMP)`).run();
  db.prepare(`INSERT INTO messages(chat_id,role,content,metadata_json) VALUES('mode-chat','user','ordinary secret',?)`)
    .run(JSON.stringify({ conversationMode: 'normal', memoryEligible: false }));
  db.prepare(`INSERT INTO messages(chat_id,role,content,metadata_json) VALUES('mode-chat','assistant','ordinary answer',?)`)
    .run(JSON.stringify({ conversationMode: 'normal', memoryEligible: false }));
  db.prepare(`INSERT INTO messages(chat_id,role,content,metadata_json) VALUES('mode-chat','user','companion memory',?)`)
    .run(JSON.stringify({ conversationMode: 'companion', memoryEligible: true }));
  db.prepare(`INSERT INTO messages(chat_id,role,content,metadata_json) VALUES('mode-chat','assistant','companion reply',?)`)
    .run(JSON.stringify({ conversationMode: 'companion', memoryEligible: true }));

  const result = await scribe.processChat('mode-chat', { force: true });

  assert.equal(result.processed, 2);
  assert.doesNotMatch(extractionTranscript, /ordinary secret|ordinary answer/);
  assert.match(extractionTranscript, /companion memory/);
  assert.deepEqual(
    db.prepare(`SELECT memory_processed FROM messages ORDER BY id`).all().map((row) => row.memory_processed),
    [0, 0, 1, 1]
  );
  const retry = await scribe.processChat('mode-chat', { force: true });
  assert.equal(retry.skipped, true);
  assert.equal(retry.reason, 'no_unprocessed_messages');

  db.close();
});

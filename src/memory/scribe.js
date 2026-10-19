const { randomUUID } = require('crypto');

const VALID_TYPES = new Set(['observation', 'preference', 'event', 'state', 'reflection']);
const VALID_CATEGORIES = new Set(['person', 'place', 'event', 'hobby', 'project']);
const VALID_MEMORY_SCOPES = new Set(['user_fact', 'assistant_contribution', 'shared_creation']);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeFragment(raw) {
  const content = String(raw?.content || '').trim().slice(0, 500);
  if (!content) return null;
  return {
    type: VALID_TYPES.has(raw.type) ? raw.type : 'observation',
    entity: String(raw.entity || '').trim().slice(0, 100),
    content,
    emotionalWeight: clamp(raw.emotional_weight, 0, 1, 0.3),
    confidence: clamp(raw.confidence, 0, 1, 0.7),
    entities: Array.isArray(raw.entities)
      ? raw.entities.map((entity) => ({
        name: String(entity?.name || '').trim().slice(0, 100),
        category: VALID_CATEGORIES.has(entity?.category) ? entity.category : 'person',
        relation: String(entity?.relation || '').trim().slice(0, 100)
      })).filter((entity) => entity.name)
      : []
  };
}

function normalizeConfidencePolicy(policy = {}) {
  const active = clamp(policy.active, 0, 1, 0.95);
  const observed = Math.min(active, clamp(policy.observed, 0, 1, 0.6));
  return { active, observed };
}

function classifyConfidence(value, policy = {}) {
  const thresholds = normalizeConfidencePolicy(policy);
  const confidence = clamp(value, 0, 1, 0.7);
  if (confidence >= thresholds.active) return 'active';
  if (confidence >= thresholds.observed) return 'observed';
  return 'discarded';
}

function scopedEvidence(raw, messageRoleById) {
  const scope = VALID_MEMORY_SCOPES.has(raw?.memory_scope) ? raw.memory_scope : '';
  const ids = Array.isArray(raw?.evidence_message_ids) ? raw.evidence_message_ids : [];
  const validIds = [...new Set(ids.map(Number).filter((id) => (
    Number.isInteger(id) && messageRoleById.has(id)
  )))];
  const roles = new Set(validIds.map((id) => messageRoleById.get(id)));
  const valid = scope === 'user_fact'
    ? roles.size === 1 && roles.has('user')
    : scope === 'assistant_contribution'
      ? roles.size === 1 && roles.has('assistant')
      : scope === 'shared_creation' && roles.has('user') && roles.has('assistant');
  return valid ? { scope, ids: validIds } : null;
}

function createScribe({ db, llm, continuityId, vectorStore, confidencePolicy = {} }) {
  const thresholds = normalizeConfidencePolicy(confidencePolicy);

  function insertFragment(fragment, source = {}, options = {}) {
    const normalized = normalizeFragment(fragment);
    if (!normalized) throw new Error('Memory fragment content is required');
    const writeState = options.writeState === 'observed' ? 'observed' : 'active';
    const sourceMessageIds = Array.isArray(source.messageIds) ? source.messageIds : [];
    const result = db.prepare(`
      INSERT INTO memory_fragments (
        type, entity, content, emotional_weight, confidence, write_state,
        source_chat_id, source_message_ids, source_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.type,
      normalized.entity,
      normalized.content,
      normalized.emotionalWeight,
      normalized.confidence,
      writeState,
      source.chatId || null,
      JSON.stringify(sourceMessageIds),
      source.sourceDate || new Date().toISOString()
    );
    const fragmentId = Number(result.lastInsertRowid);

    const upsertEntity = db.prepare(`
      INSERT INTO entities(name, category, status, fragment_count, first_mentioned_at, last_mentioned_at)
      VALUES (?, ?, 'seed', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(name) DO UPDATE SET last_mentioned_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      RETURNING id
    `);
    const link = db.prepare(`
      INSERT OR IGNORE INTO fragment_entities(fragment_id, entity_id, relation, confidence)
      VALUES (?, ?, ?, ?)
    `);
    const entities = [...normalized.entities];
    if (normalized.entity && !entities.some((entity) => entity.name === normalized.entity)) {
      entities.unshift({ name: normalized.entity, category: 'person', relation: '' });
    }
    for (const entity of entities) {
      const entityId = upsertEntity.get(entity.name, entity.category).id;
      link.run(fragmentId, entityId, entity.relation || null, normalized.confidence);
    }
    if (writeState === 'active') vectorStore?.enqueueUpsert(fragmentId);
    return fragmentId;
  }

  function addPersonaCandidate(candidate, sourceMessageIds = []) {
    const claim = String(candidate?.claim || '').trim().slice(0, 1000);
    if (!claim) return null;
    const target = String(candidate?.target_section_key || 'self.learned').trim().slice(0, 100);
    const existing = db.prepare(`
      SELECT * FROM persona_candidates
      WHERE continuity_id=? AND target_section_key=? AND claim=? AND status IN ('observing','pending')
      ORDER BY id DESC LIMIT 1
    `).get(continuityId, target, claim);
    if (existing) {
      const evidence = new Set(JSON.parse(existing.evidence_json || '[]'));
      sourceMessageIds.forEach((id) => evidence.add(id));
      const count = Math.max(existing.evidence_count + 1, evidence.size);
      const status = count >= 3 ? 'pending' : existing.status;
      db.prepare(`
        UPDATE persona_candidates
        SET evidence_json=?, evidence_count=?, confidence=?, status=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        JSON.stringify([...evidence]),
        count,
        clamp(candidate.confidence, 0, 1, Math.min(0.95, existing.confidence + 0.1)),
        status,
        existing.id
      );
      return existing.id;
    }
    const result = db.prepare(`
      INSERT INTO persona_candidates (
        continuity_id, target_section_key, claim, reason, evidence_json,
        evidence_count, confidence, status
      ) VALUES (?, ?, ?, ?, ?, 1, ?, 'observing')
    `).run(
      continuityId,
      target,
      claim,
      String(candidate?.reason || 'Observed in conversation').slice(0, 1000),
      JSON.stringify(sourceMessageIds),
      clamp(candidate?.confidence, 0, 1, 0.5)
    );
    return Number(result.lastInsertRowid);
  }

  async function processChat(chatId, { force = false } = {}) {
    const messages = db.prepare(`
      SELECT id, role, content, created_at, metadata_json FROM messages
      WHERE chat_id=? AND memory_processed=0 AND role IN ('user','assistant')
        AND COALESCE(json_extract(metadata_json, '$.memoryEligible'), 1)=1
      ORDER BY id LIMIT 100
    `).all(chatId);
    if (!messages.length) return { skipped: true, reason: 'no_unprocessed_messages' };
    if (!force && messages.length < 2) return { skipped: true, reason: 'insufficient_messages' };
    if (!llm.enabled) return { skipped: true, reason: 'llm_disabled' };

    const runId = db.prepare(`INSERT INTO pipeline_runs(component,status) VALUES('scribe','running')`).run().lastInsertRowid;
    const messageById = new Map(messages.map((message) => [message.id, message]));
    const messageRoleById = new Map(messages.map((message) => [message.id, message.role]));
    const transcript = messages
      .map((message) => {
        let retrievedDiaryIds = []; let retrievedDiaryMemoryIds = []; let retrievedTheoryUnitIds = [];
        try {
          const metadata = JSON.parse(message.metadata_json || '{}');
          retrievedDiaryIds = metadata.retrievedDiaryIds || [];
          retrievedDiaryMemoryIds = metadata.retrievedDiaryMemoryIds || [];
          retrievedTheoryUnitIds = metadata.retrievedTheoryUnitIds || [];
        } catch { /* ignore invalid legacy metadata */ }
        const marker = retrievedDiaryIds.length ? ` retrieved_diary_ids=${JSON.stringify(retrievedDiaryIds)}` : '';
        const memoryMarker = retrievedDiaryMemoryIds.length ? ` retrieved_diary_memory_ids=${JSON.stringify(retrievedDiaryMemoryIds)}` : '';
        const theoryMarker = retrievedTheoryUnitIds.length ? ` retrieved_theory_unit_ids=${JSON.stringify(retrievedTheoryUnitIds)}` : '';
        return `[message_id=${message.id} created_at=${message.created_at} role=${message.role}${marker}${memoryMarker}${theoryMarker}] ${message.content}`;
      })
      .join('\n');
    const system = `You are Scribe, a source-grounded memory extractor for one persistent AI companion.
Both people co-create this relationship, so user messages and assistant replies may contribute different kinds of memory. Classify the authority of every item with memory_scope:
- user_fact: information, experience, preference, or intention explicitly stated by the user. Evidence must contain user message IDs only. An assistant paraphrase or recollection can never establish a user fact.
- assistant_contribution: a genuinely new idea, judgment, choice, boundary, promise, creative contribution, or self-reflection authored by the assistant in this exchange. Evidence must contain assistant message IDs only. Do not use this scope to restate facts about the user or to record that the assistant recalled something.
- shared_creation: a concrete agreement, jointly developed insight, ritual, plan, or artifact created through both sides of this exchange. Evidence must contain at least one user and one assistant message ID. Simple question-answer pairs, acknowledgements, and paraphrases are not shared creations.
When the user asks what the assistant remembers, or the assistant summarizes retrieved memories, do not emit those recalled facts again. Extract only genuinely new contributions made in the current exchange.
If an assistant message has retrieved_diary_ids, any quotation, paraphrase, or conclusion sourced only from those diary excerpts is prior historical evidence, not a new event and not new support for a user fact or persona candidate. A genuinely new interpretation or explicit agreement created in the present exchange may still qualify under the normal role rules.
The same rule applies to retrieved_diary_memory_ids: “关于日记的记忆” is already stored autobiographical memory. Recalling or paraphrasing it must not duplicate it as a new memory. Only new present-tense interpretation, correction, or shared agreement may be extracted.
The same rule applies to retrieved_theory_unit_ids: a personal-theory route card is already stored sourced memory. Quoting or paraphrasing it must not create an ordinary memory fragment or new persona evidence. A new correction, present application, or jointly created extension may still qualify if supported by current messages.
Never infer diagnoses, permanent personality, or relationship commitments from one exchange.
Confidence means evidentiary certainty, not plausibility, and must be calibrated independently of any downstream write policy. Reserve 1.0 for a near-verbatim fact whose meaning and direction are explicit; use about 0.9 for a clear paraphrase; use lower values for ambiguity or inference. Check negation, direction of change, who acted, and whether a request is temporary.
Every fragment and persona candidate must include memory_scope and evidence_message_ids that obey the role rules above. If the evidence does not support the item, omit it.
Return JSON with:
{
  "fragments": [{"type":"observation|preference|event|state|reflection","entity":"primary entity","content":"third-person concise fact","emotional_weight":0.0,"confidence":0.0,"memory_scope":"user_fact|assistant_contribution|shared_creation","evidence_message_ids":[123],"entities":[{"name":"name","category":"person|place|event|hobby|project","relation":"optional"}]}],
  "persona_candidates": [{"target_section_key":"self.learned|relationship.learned|user.learned","claim":"candidate learning","reason":"evidence","confidence":0.0,"memory_scope":"user_fact|assistant_contribution|shared_creation","evidence_message_ids":[123]}]
}
Persona candidates must be cross-conversation hypotheses, not active personality changes. If evidence is weak, return none.`;
    try {
      const extracted = await llm.completeJson([
        { role: 'system', content: system },
        { role: 'user', content: transcript }
      ], { temperature: 0.1, maxTokens: 3000 });
      const messageIds = messages.map((message) => message.id);
      const fragmentIds = [];
      const activeFragmentIds = [];
      const observedFragmentIds = [];
      let discardedFragmentCount = 0;
      let unsupportedFragmentCount = 0;
      let unsupportedPersonaCandidateCount = 0;
      db.transaction(() => {
        for (const fragment of extracted.fragments || []) {
          const evidence = scopedEvidence(fragment, messageRoleById);
          if (!evidence) {
            unsupportedFragmentCount += 1;
            continue;
          }
          const fragmentEvidenceIds = evidence.ids;
          const writeState = classifyConfidence(fragment?.confidence, thresholds);
          if (writeState === 'discarded') {
            discardedFragmentCount += 1;
            continue;
          }
          const id = insertFragment(fragment, {
            chatId,
            messageIds: fragmentEvidenceIds,
            sourceDate: messageById.get(Math.max(...fragmentEvidenceIds))?.created_at
          }, { writeState });
          fragmentIds.push(id);
          if (writeState === 'active') activeFragmentIds.push(id);
          else observedFragmentIds.push(id);
        }
        for (const candidate of extracted.persona_candidates || []) {
          const evidence = scopedEvidence(candidate, messageRoleById);
          if (!evidence) {
            unsupportedPersonaCandidateCount += 1;
            continue;
          }
          addPersonaCandidate(candidate, evidence.ids);
        }
        db.prepare(`UPDATE messages SET memory_processed=1 WHERE id IN (${messageIds.map(() => '?').join(',')})`).run(...messageIds);
        db.prepare(`UPDATE pipeline_runs SET status='done', detail_json=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(JSON.stringify({
            chatId,
            messageIds,
            fragmentIds,
            activeFragmentIds,
            observedFragmentIds,
            discardedFragmentCount,
            unsupportedFragmentCount,
            unsupportedPersonaCandidateCount,
            confidenceThresholds: thresholds,
            marker: randomUUID()
          }), runId);
      })();
      return {
        processed: messages.length,
        fragmentIds,
        activeFragmentIds,
        observedFragmentIds,
        discardedFragmentCount,
        unsupportedFragmentCount,
        unsupportedPersonaCandidateCount
      };
    } catch (error) {
      db.prepare(`UPDATE pipeline_runs SET status='failed', detail_json=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(JSON.stringify({ error: error.message }), runId);
      throw error;
    }
  }

  return { processChat, insertFragment, addPersonaCandidate };
}

module.exports = { createScribe, normalizeFragment, normalizeConfidencePolicy, classifyConfidence, scopedEvidence };

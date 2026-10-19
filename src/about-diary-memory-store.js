const crypto = require('crypto');

const CATEGORIES = new Set(['life_event', 'theory_reflection', 'emotional_peak', 'long_term_pattern']);
const THEMES = new Set([
  'relationships', 'family', 'work', 'money', 'learning', 'creativity', 'autonomy', 'meaning',
  'body_sexuality', 'anxiety_fear', 'anger_conflict', 'sadness_loss', 'joy_achievement',
  'identity', 'technology_ai', 'literature_media'
]);

function clamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function importanceScore(input = {}) {
  const emotional = clamp(input.emotional_intensity);
  const trajectory = clamp(input.trajectory_impact);
  const originality = clamp(input.originality);
  const recurrence = clamp(input.recurrence);
  const emphasis = clamp(input.user_emphasis);
  let score = emotional * 0.30 + trajectory * 0.22 + originality * 0.18 + recurrence * 0.12 + emphasis * 0.18;
  if (input.category === 'emotional_peak' && emotional >= 0.75) score = Math.max(score, 0.62 + emotional * 0.28);
  if (input.category === 'long_term_pattern' && recurrence >= 0.6) score = Math.max(score, 0.62);
  return Math.round(Math.min(1, score) * 10000) / 10000;
}

function json(value, fallback = []) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function tokens(query) {
  return String(query || '').normalize('NFKC').replace(/["'()*:^~{}\[\]\\]/g, ' ')
    .match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 10) || [];
}

function publicMemory(row, sources = []) {
  return {
    id: row.id,
    memoryKind: '关于日记的记忆',
    category: row.category,
    title: row.title,
    content: row.content,
    temporalScope: row.temporal_scope,
    dateStart: row.date_start,
    dateEnd: row.date_end,
    emotionalValence: row.emotional_valence,
    emotionalIntensity: row.emotional_intensity,
    importance: row.importance_score,
    confidence: row.confidence,
    themes: json(row.themes_json),
    status: row.status,
    recallPermission: 'dated_autobiographical_memory',
    sourceKind: 'diary_memory',
    sources: sources.map((source) => ({
      entryId: source.entry_id,
      chunkId: source.chunk_id,
      quote: source.source_quote,
      date: source.absolute_date,
      cycle: `${source.cycle_id}/${source.cycle_day_normalized}`
    }))
  };
}

function createAboutDiaryMemoryStore({ db, vectorStore, config = {} }) {
  function insert(input, { documentId, runId, status = 'shadow', model = '' } = {}) {
    const category = CATEGORIES.has(input?.category) ? input.category : null;
    const title = String(input?.title || '').trim().slice(0, 200);
    const content = String(input?.content || '').trim().slice(0, 1600);
    const evidence = Array.isArray(input?.evidence) ? input.evidence.slice(0, 12) : [];
    if (!category || !title || !content || !documentId || !runId || !evidence.length) return { accepted: false, reason: 'missing_required_fields' };
    const validated = [];
    for (const item of evidence) {
      const entryId = String(item?.entry_id || '');
      const quote = String(item?.quote || '').trim().slice(0, 1000);
      const entry = db.prepare('SELECT * FROM diary_entries WHERE id=? AND document_id=?').get(entryId, documentId);
      if (!entry || quote.length < 4 || !entry.content.includes(quote)) continue;
      const chunk = db.prepare('SELECT id FROM diary_chunks WHERE entry_id=? AND instr(content,?)>0 ORDER BY chunk_index LIMIT 1').get(entryId, quote)
        || db.prepare('SELECT id FROM diary_chunks WHERE entry_id=? ORDER BY chunk_index LIMIT 1').get(entryId);
      validated.push({ entry, quote, chunkId: chunk?.id || null });
    }
    const uniqueEntries = [...new Set(validated.map((item) => item.entry.id))];
    if (!validated.length) return { accepted: false, reason: 'no_direct_quote_support' };
    const dates = validated.map((item) => item.entry.absolute_date).filter(Boolean).sort();
    if (category === 'long_term_pattern') {
      if (uniqueEntries.length < 3 || dates.length < 3) return { accepted: false, reason: 'pattern_requires_three_entries' };
      if ((new Date(dates.at(-1)) - new Date(dates[0])) / 86400000 < 30) return { accepted: false, reason: 'pattern_requires_30_day_span' };
    }
    const themes = [...new Set((Array.isArray(input.themes) ? input.themes : []).filter((theme) => THEMES.has(theme)))].slice(0, 8);
    const emotionalIntensity = clamp(input.emotional_intensity);
    const fields = {
      category,
      emotional_intensity: emotionalIntensity,
      trajectory_impact: clamp(input.trajectory_impact),
      originality: clamp(input.originality),
      recurrence: category === 'long_term_pattern' ? Math.max(0.6, clamp(input.recurrence)) : clamp(input.recurrence),
      user_emphasis: clamp(input.user_emphasis)
    };
    if (category === 'emotional_peak' && emotionalIntensity < Number(config.emotionalPeakThreshold || 0.75)) {
      return { accepted: false, reason: 'emotional_peak_below_threshold' };
    }
    const dateStart = String(input.date_start || dates[0] || '').slice(0, 10) || null;
    const dateEnd = String(input.date_end || dates.at(-1) || dateStart || '').slice(0, 10) || null;
    const digest = crypto.createHash('sha256').update(`${content}\0${dateStart || ''}`).digest('hex');
    const id = `diary-memory-${crypto.createHash('sha256').update(`${documentId}:${category}:${uniqueEntries.join(',')}:${digest}`).digest('hex').slice(0, 24)}`;
    const values = {
      id, document_id: documentId, run_id: runId, category, title, content, content_sha256: digest,
      temporal_scope: category === 'long_term_pattern' ? 'pattern' : (dateStart !== dateEnd ? 'period' : 'moment'),
      date_start: dateStart, date_end: dateEnd,
      emotional_valence: Math.max(-1, Math.min(1, Number(input.emotional_valence) || 0)),
      ...fields,
      importance_score: importanceScore(fields), confidence: clamp(input.confidence, 0.8),
      themes_json: JSON.stringify(themes), source_quotes_json: JSON.stringify(validated.map((item) => item.quote)),
      evidence_count: uniqueEntries.length, extraction_model: String(model || '').slice(0, 200), status
    };
    const result = db.transaction(() => {
      const prior = db.prepare('SELECT id,status FROM about_diary_memories WHERE document_id=? AND content_sha256=? AND date_start IS ? AND category=?')
        .get(documentId, digest, dateStart, category);
      if (prior) return { id: prior.id, deduplicated: true, status: prior.status };
      db.prepare(`INSERT INTO about_diary_memories(
        id,document_id,run_id,category,title,content,content_sha256,temporal_scope,date_start,date_end,
        emotional_valence,emotional_intensity,trajectory_impact,originality,recurrence,user_emphasis,
        importance_score,confidence,themes_json,source_quotes_json,evidence_count,extraction_model,status
      ) VALUES(@id,@document_id,@run_id,@category,@title,@content,@content_sha256,@temporal_scope,@date_start,@date_end,
        @emotional_valence,@emotional_intensity,@trajectory_impact,@originality,@recurrence,@user_emphasis,
        @importance_score,@confidence,@themes_json,@source_quotes_json,@evidence_count,@extraction_model,@status)`).run(values);
      const link = db.prepare('INSERT INTO diary_memory_sources(memory_id,entry_id,chunk_id,source_quote) VALUES(?,?,?,?)');
      validated.forEach((item) => link.run(id, item.entry.id, item.chunkId, item.quote));
      if (status === 'active') vectorStore.enqueueUpsert(id);
      return { id, deduplicated: false, status };
    })();
    return { accepted: true, ...result, importance: values.importance_score };
  }

  function activateRun(runId) {
    const ids = db.prepare("SELECT id FROM about_diary_memories WHERE run_id=? AND status='shadow'").all(String(runId)).map((row) => row.id);
    db.transaction(() => {
      db.prepare("UPDATE about_diary_memories SET status='active',updated_at=CURRENT_TIMESTAMP WHERE run_id=? AND status='shadow'").run(String(runId));
      ids.forEach((id) => vectorStore.enqueueUpsert(id));
      db.prepare("UPDATE diary_memory_runs SET mode='active',status='done',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(String(runId));
    })();
    return { runId: String(runId), activated: ids.length };
  }

  function sourcesFor(ids) {
    if (!ids.length) return new Map();
    const rows = db.prepare(`SELECT s.*,e.absolute_date,e.cycle_id,e.cycle_day_normalized FROM diary_memory_sources s
      JOIN diary_entries e ON e.id=s.entry_id WHERE s.memory_id IN (${ids.map(() => '?').join(',')}) ORDER BY e.absolute_date,s.entry_id`).all(...ids);
    const map = new Map(); rows.forEach((row) => { if (!map.has(row.memory_id)) map.set(row.memory_id, []); map.get(row.memory_id).push(row); }); return map;
  }

  async function search(query, limit = config.maxResults || 3, { includeShadow = false } = {}) {
    if (!config.recallEnabled || !String(query || '').trim()) return [];
    const capped = Math.max(1, Math.min(Number(limit) || 3, 10)); const scores = new Map();
    const statusSql = includeShadow ? "status IN ('active','shadow')" : "status='active'";
    const queryTokens = tokens(query);
    if (queryTokens.length) {
      const match = queryTokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
      try {
        db.prepare(`SELECT m.id FROM about_diary_memories_fts f JOIN about_diary_memories m ON m.id=f.memory_id
          WHERE about_diary_memories_fts MATCH ? AND m.${statusSql} ORDER BY bm25(about_diary_memories_fts) LIMIT 50`).all(match)
          .forEach((row, index) => scores.set(row.id, { score: 1 / (60 + index + 1), lexicalRank: index + 1 }));
      } catch { /* no lexical result */ }
    }
    if (!includeShadow) {
      (await vectorStore.search(query, Math.max(capped * 2, 8))).forEach((row, index) => {
        const current = scores.get(row.memoryId) || { score: 0 };
        scores.set(row.memoryId, { ...current, score: current.score + 1 / (60 + index + 1), distance: row.distance });
      });
    }
    const ids = [...scores.keys()];
    if (!ids.length) return [];
    const rows = db.prepare(`SELECT * FROM about_diary_memories WHERE id IN (${ids.map(() => '?').join(',')}) AND ${statusSql}`).all(...ids);
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.filter((id) => rowMap.has(id)).sort((a, b) => {
      const aScore = (scores.get(a)?.score || 0) + rowMap.get(a).importance_score * 0.006;
      const bScore = (scores.get(b)?.score || 0) + rowMap.get(b).importance_score * 0.006;
      return bScore - aScore;
    }).slice(0, capped);
    const sourceMap = sourcesFor(ordered);
    const touch = db.prepare('UPDATE about_diary_memories SET access_count=access_count+1,last_accessed_at=CURRENT_TIMESTAMP WHERE id=?');
    db.transaction(() => ordered.forEach((id) => touch.run(id)))();
    let chars = 0; const maxChars = Number(config.maxContextChars || 2400);
    return ordered.map((id) => publicMemory(rowMap.get(id), sourceMap.get(id) || [])).filter((memory) => {
      if (chars + memory.content.length > maxChars) return false; chars += memory.content.length; return true;
    });
  }

  function get(id, { includeShadow = false } = {}) {
    const row = db.prepare(`SELECT * FROM about_diary_memories WHERE id=? AND ${includeShadow ? "status IN ('active','shadow')" : "status='active'"}`).get(String(id));
    if (!row) return null; return publicMemory(row, sourcesFor([row.id]).get(row.id) || []);
  }

  function status() {
    const counts = Object.fromEntries(db.prepare('SELECT status,COUNT(*) count FROM about_diary_memories GROUP BY status').all().map((row) => [row.status, row.count]));
    const categories = Object.fromEntries(db.prepare('SELECT category,COUNT(*) count FROM about_diary_memories GROUP BY category').all().map((row) => [row.category, row.count]));
    return { displayName: '关于日记的记忆', enabled: Boolean(config.enabled), recallEnabled: Boolean(config.recallEnabled), counts, categories };
  }

  return { insert, activateRun, search, get, status, importanceScore };
}

module.exports = { createAboutDiaryMemoryStore, importanceScore, CATEGORIES, THEMES };

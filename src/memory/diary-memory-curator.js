const crypto = require('crypto');
const { THEMES } = require('../about-diary-memory-store');

function createDiaryMemoryCurator({ db, llm, store, config = {}, model = '' }) {
  function ensureJobs(documentId, { resetFailed = true } = {}) {
    const rows = db.prepare("SELECT id FROM diary_entries WHERE document_id=? AND status='active'").all(String(documentId));
    const insert = db.prepare(`INSERT OR IGNORE INTO diary_memory_extraction_jobs(entry_id,document_id) VALUES(?,?)`);
    db.transaction(() => {
      rows.forEach((row) => insert.run(row.id, String(documentId)));
      if (resetFailed) db.prepare("UPDATE diary_memory_extraction_jobs SET status='pending',last_error='',updated_at=CURRENT_TIMESTAMP WHERE document_id=? AND status='failed' AND attempts<3").run(String(documentId));
    })();
    return rows.length;
  }

  function createRun(documentId, mode = 'shadow') {
    const id = `diary-memory-run-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO diary_memory_runs(id,document_id,mode,model) VALUES(?,?,?,?)').run(id, String(documentId), mode, model);
    return id;
  }

  function retryFailed(documentId, { resetAttempts = false } = {}) {
    const result = db.prepare(`UPDATE diary_memory_extraction_jobs
      SET status='pending',attempts=CASE WHEN ? THEN 0 ELSE attempts END,last_error='',updated_at=CURRENT_TIMESTAMP
      WHERE document_id=? AND status='failed'`).run(resetAttempts ? 1 : 0, String(documentId));
    return { documentId: String(documentId), resetAttempts: Boolean(resetAttempts), queued: Number(result.changes || 0) };
  }

  function pickBatch(documentId) {
    const candidates = db.prepare(`SELECT j.entry_id,e.absolute_date,e.cycle_id,e.cycle_day_normalized,e.content
      FROM diary_memory_extraction_jobs j JOIN diary_entries e ON e.id=j.entry_id
      WHERE j.document_id=? AND j.status IN ('pending','failed') AND j.attempts<3
      ORDER BY e.source_line_start LIMIT ?`).all(String(documentId), Math.max(1, Number(config.extractionBatchEntries) || 20));
    const selected = []; let chars = 0; const maxChars = Math.max(2000, Number(config.extractionMaxChars) || 18000);
    for (const row of candidates) {
      if (selected.length && chars + row.content.length > maxChars) break;
      selected.push(row); chars += row.content.length;
    }
    return selected;
  }

  function prompt(entries) {
    const payload = entries.map((entry) => ({ entry_id: entry.entry_id, date: entry.absolute_date,
      cycle: `${entry.cycle_id}/${entry.cycle_day_normalized}`, text: entry.content }));
    return [
      { role: 'system', content: `你是“关于日记的记忆”整理器。日记不是外部资料，而是知伴关于用户过去的第一人称自传证据。
对每条日记，提炼值得知伴正式记住的内容。只允许以下类别：
- life_event：发生过并影响用户的生活事件；
- theory_reflection：用户原创或重要的思想、理论、价值判断、作品理解；
- emotional_peak：强烈愤怒、恐惧、绝望、欲望、羞耻、悲伤、狂喜、依恋等极端时刻。只要强度>=${Number(config.emotionalPeakThreshold || 0.75)}，即使只出现一次也必须保留；
本阶段禁止生成long_term_pattern，长期模式必须由跨时间证据单独生成。

普通但具有个人经验、想法或情绪的信息也可形成简洁记忆；只有纯日期标记、无意义重复或完全没有个人内容时才省略。
每条记忆必须：
1. 说明“在什么时间，用户经历/感受/思考了什么”；
2. 不把一次状态写成永久人格，不诊断；
3. evidence中的quote必须逐字出现在对应entry_id的原文中，禁止改写引文；
4. 对情绪峰值同时保存触发因素、当时想法、行动/冲动、深层需要或事后变化中原文确实支持的部分；不支持的字段不得臆测；
5. 性、生理、关系和第三方内容与其他记忆同等处理，不降权、不回避、不加敏感标签；
6. user_emphasis仅在原文明确表达“重要、永远、必须记住”等强调时提高；recurrence在单篇阶段通常较低。

主题只能从以下枚举选择：${[...THEMES].join(', ')}。
返回JSON：{"memories":[{"category":"life_event|theory_reflection|emotional_peak","title":"短标题","content":"第三人称、带时间边界的记忆","date_start":"YYYY-MM-DD或null","date_end":"YYYY-MM-DD或null","emotional_valence":-1.0,"emotional_intensity":0.0,"trajectory_impact":0.0,"originality":0.0,"recurrence":0.0,"user_emphasis":0.0,"confidence":0.0,"themes":["枚举主题"],"evidence":[{"entry_id":"原ID","quote":"逐字原文"}]}]}。` },
      { role: 'user', content: JSON.stringify(payload, null, 2) }
    ];
  }

  async function processBatch({ documentId, runId, mode = 'shadow' }) {
    if (!llm.enabled) return { skipped: true, reason: 'llm_disabled' };
    const entries = pickBatch(documentId);
    if (!entries.length) return { processedEntries: 0, accepted: 0, rejected: 0, complete: true };
    const ids = entries.map((entry) => entry.entry_id);
    const markProcessing = db.prepare("UPDATE diary_memory_extraction_jobs SET status='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE entry_id=?");
    db.transaction(() => ids.forEach((id) => markProcessing.run(id)))();
    try {
      const extracted = await llm.completeJson(prompt(entries), { temperature: 0.1, maxTokens: 6000 });
      const accepted = []; const rejected = [];
      for (const candidate of Array.isArray(extracted.memories) ? extracted.memories : []) {
        const result = store.insert(candidate, { documentId, runId, status: mode === 'active' ? 'active' : 'shadow', model });
        if (result.accepted) accepted.push(result); else rejected.push({ reason: result.reason, title: String(candidate?.title || '').slice(0, 80) });
      }
      const counts = new Map(ids.map((id) => [id, 0]));
      for (const candidate of Array.isArray(extracted.memories) ? extracted.memories : []) {
        for (const evidence of Array.isArray(candidate?.evidence) ? candidate.evidence : []) {
          if (counts.has(String(evidence?.entry_id))) counts.set(String(evidence.entry_id), counts.get(String(evidence.entry_id)) + 1);
        }
      }
      const done = db.prepare("UPDATE diary_memory_extraction_jobs SET status='done',memory_count=?,last_error='',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE entry_id=?");
      db.transaction(() => ids.forEach((id) => done.run(counts.get(id) || 0, id)))();
      return { processedEntries: entries.length, accepted: accepted.length, rejected: rejected.length, rejectedDetails: rejected.slice(0, 10), complete: false };
    } catch (error) {
      const failed = db.prepare("UPDATE diary_memory_extraction_jobs SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE entry_id=?");
      db.transaction(() => ids.forEach((id) => failed.run(error.message.slice(0, 2000), id)))();
      throw error;
    }
  }

  async function consolidatePatterns({ documentId, runId, mode = 'shadow', minMemories = 5, minSpanDays = 90 } = {}) {
    const rows = db.prepare(`SELECT m.* FROM about_diary_memories m WHERE m.document_id=? AND m.category!='long_term_pattern' AND m.status IN ('shadow','active')`).all(String(documentId));
    const groups = new Map();
    rows.forEach((row) => {
      let themes = []; try { themes = JSON.parse(row.themes_json || '[]'); } catch { themes = []; }
      themes.forEach((theme) => { if (!groups.has(theme)) groups.set(theme, []); groups.get(theme).push(row); });
    });
    const results = [];
    for (const [theme, memories] of groups) {
      const dated = memories.filter((row) => row.date_start).sort((a, b) => a.date_start.localeCompare(b.date_start));
      if (dated.length < minMemories) continue;
      const span = (new Date(dated.at(-1).date_start) - new Date(dated[0].date_start)) / 86400000;
      if (span < minSpanDays) continue;
      const selected = dated.length <= 30 ? dated : Array.from({ length: 30 }, (_, i) => dated[Math.round(i * (dated.length - 1) / 29)]);
      const sourceRows = db.prepare(`SELECT s.memory_id,s.entry_id,s.source_quote,e.absolute_date FROM diary_memory_sources s
        JOIN diary_entries e ON e.id=s.entry_id WHERE s.memory_id IN (${selected.map(() => '?').join(',')}) ORDER BY e.absolute_date`).all(...selected.map((row) => row.id));
      const evidenceByMemory = new Map(); sourceRows.forEach((row) => { if (!evidenceByMemory.has(row.memory_id)) evidenceByMemory.set(row.memory_id, []); evidenceByMemory.get(row.memory_id).push(row); });
      const payload = selected.map((row) => ({ memory_id: row.id, date: row.date_start, content: row.content,
        evidence: (evidenceByMemory.get(row.id) || []).slice(0, 2).map((source) => ({ entry_id: source.entry_id, quote: source.source_quote })) }));
      const extracted = await llm.completeJson([
        { role: 'system', content: `你负责从跨时间的“关于日记的记忆”中识别长期模式。主题是${theme}。
只有当至少3个不同日期、跨度至少30天的直接证据支持同一模式时才输出。描述变化轨迹、条件和反例空间，不得把模式写成永恒人格或诊断。evidence必须从输入中原样复制至少3个不同entry_id及其quote。返回JSON：{"pattern":null}或{"pattern":{"category":"long_term_pattern","title":"短标题","content":"带时间范围和条件的模式","date_start":"YYYY-MM-DD","date_end":"YYYY-MM-DD","emotional_valence":0.0,"emotional_intensity":0.0,"trajectory_impact":0.0,"originality":0.0,"recurrence":0.8,"user_emphasis":0.0,"confidence":0.0,"themes":["${theme}"],"evidence":[{"entry_id":"...","quote":"..."}]}}。` },
        { role: 'user', content: JSON.stringify(payload, null, 2) }
      ], { temperature: 0.1, maxTokens: 2500 });
      if (extracted.pattern) results.push({ theme, ...store.insert(extracted.pattern, { documentId, runId, status: mode === 'active' ? 'active' : 'shadow', model }) });
    }
    return { consideredThemes: groups.size, patterns: results.filter((item) => item.accepted).length, results };
  }

  function status(documentId) {
    const jobs = Object.fromEntries(db.prepare('SELECT status,COUNT(*) count FROM diary_memory_extraction_jobs WHERE document_id=? GROUP BY status').all(String(documentId)).map((row) => [row.status, row.count]));
    return { documentId: String(documentId), jobs, memories: store.status() };
  }

  return { ensureJobs, createRun, retryFailed, processBatch, consolidatePatterns, status };
}

module.exports = { createDiaryMemoryCurator };

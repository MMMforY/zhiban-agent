function ageInDays(dateString) {
  const value = new Date(`${dateString || ''}`.replace(' ', 'T'));
  if (Number.isNaN(value.getTime())) return 9999;
  return Math.max(0, (Date.now() - value.getTime()) / 86400000);
}

function recallPermission(row, channelCount) {
  const days = ageInDays(row.source_date || row.created_at);
  if (channelCount >= 2 && days < 30 && row.confidence >= 0.7) return 'cite';
  if (days <= 90 && row.confidence >= 0.5) return 'cautious';
  return 'associate_only';
}

function tokenizeQuery(query) {
  return String(query || '')
    .normalize('NFKC')
    .replace(/["'()*:^~{}\[\]\\]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function rrfMerge(channels, limit = 12) {
  const scores = new Map();
  const records = new Map();
  const channelHits = new Map();
  const k = 60;
  for (const [channel, rows] of Object.entries(channels)) {
    rows.forEach((row, index) => {
      const key = `${row.layer}:${row.id}`;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + index + 1));
      records.set(key, row);
      if (!channelHits.has(key)) channelHits.set(key, new Set());
      channelHits.get(key).add(channel);
      for (const prior of row.channels || []) channelHits.get(key).add(prior);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, score]) => {
      const row = records.get(key);
      const channelsForRow = [...channelHits.get(key)];
      return {
        ...row,
        score,
        channels: channelsForRow,
        recallPermission: recallPermission(row, channelsForRow.length)
      };
    });
}

function createLibrarian(db, vectorStore) {
  function search(query, limit = 12) {
    const tokens = tokenizeQuery(query);
    if (!tokens.length) return [];
    const ftsQuery = tokens.map((token) => `"${token.replace(/"/g, '')}"`).join(' OR ');
    let fts = [];
    try {
      fts = db.prepare(`
        SELECT mf.id, 'fragment' AS layer, mf.type, mf.entity, mf.content,
               mf.confidence, mf.emotional_weight, mf.source_date, mf.created_at,
               mf.source_chat_id, mf.source_message_ids, bm25(memory_fragments_fts) AS rank
        FROM memory_fragments_fts
        JOIN memory_fragments mf ON mf.id=memory_fragments_fts.rowid
        WHERE memory_fragments_fts MATCH ?
          AND mf.write_state='active'
          AND mf.status IN ('active','consolidated','cooling')
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, Math.max(limit * 2, 20));
    } catch {
      fts = [];
    }

    const likeTerms = tokens.slice(0, 5).map((token) => `%${token}%`);
    const where = likeTerms.map(() => '(mf.entity LIKE ? OR mf.content LIKE ?)').join(' OR ');
    const likeParams = likeTerms.flatMap((value) => [value, value]);
    const entity = db.prepare(`
      SELECT DISTINCT mf.id, 'fragment' AS layer, mf.type, mf.entity, mf.content,
             mf.confidence, mf.emotional_weight, mf.source_date, mf.created_at,
             mf.source_chat_id, mf.source_message_ids
      FROM memory_fragments mf
      LEFT JOIN fragment_entities fe ON fe.fragment_id=mf.id
      LEFT JOIN entities e ON e.id=fe.entity_id
      WHERE mf.write_state='active'
        AND mf.status IN ('active','consolidated','cooling')
        AND (${where}${where ? ' OR ' : ''}${likeTerms.map(() => 'e.name LIKE ?').join(' OR ')})
      ORDER BY mf.emotional_weight DESC, mf.created_at DESC LIMIT ?
    `).all(...likeParams, ...likeTerms, Math.max(limit * 2, 20));

    const episodeWhere = likeTerms.map(() => '(ep.title LIKE ? OR ep.content LIKE ?)').join(' OR ');
    const episodeParams = likeTerms.flatMap((value) => [value, value]);
    const episodes = db.prepare(`
      SELECT ep.id, 'episode' AS layer, 'episode' AS type,
             COALESCE(e.name, '') AS entity, ep.content, ep.importance AS confidence,
             ep.importance AS emotional_weight, ep.valid_from AS source_date,
             ep.created_at, NULL AS source_chat_id, ep.source_fragment_ids AS source_message_ids,
             ep.title
      FROM episodes ep LEFT JOIN entities e ON e.id=ep.entity_id
      WHERE ep.status IN ('active','mature') AND (${episodeWhere})
      ORDER BY ep.importance DESC, ep.created_at DESC LIMIT ?
    `).all(...episodeParams, Math.max(limit * 2, 20));

    const results = rrfMerge({ fts, entity, episode: episodes }, limit);
    const fragmentIds = results.filter((row) => row.layer === 'fragment').map((row) => row.id);
    const episodeIds = results.filter((row) => row.layer === 'episode').map((row) => row.id);
    db.transaction(() => {
      const touchFragment = db.prepare(`UPDATE memory_fragments SET access_count=access_count+1, last_accessed_at=CURRENT_TIMESTAMP WHERE id=?`);
      const touchEpisode = db.prepare(`UPDATE episodes SET access_count=access_count+1, last_accessed_at=CURRENT_TIMESTAMP WHERE id=?`);
      fragmentIds.forEach((id) => touchFragment.run(id));
      episodeIds.forEach((id) => touchEpisode.run(id));
    })();
    return results;
  }

  async function searchHybrid(query, limit = 12) {
    const lexical = search(query, Math.max(limit * 2, 20));
    if (!vectorStore?.enabled) return lexical.slice(0, limit);
    const vectorHits = await vectorStore.search(query, Math.max(limit * 2, 20));
    const ids = [...new Set(vectorHits.map((hit) => hit.fragmentId))];
    if (!ids.length) return lexical.slice(0, limit);
    const rows = db.prepare(`
      SELECT id, 'fragment' AS layer, type, entity, content, confidence,
             emotional_weight, source_date, created_at, source_chat_id,
             source_message_ids
      FROM memory_fragments
      WHERE id IN (${ids.map(() => '?').join(',')})
        AND write_state='active'
        AND status IN ('active','consolidated','cooling')
    `).all(...ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const semantic = vectorHits.map((hit) => {
      const row = byId.get(hit.fragmentId);
      return row ? { ...row, vectorDistance: hit.distance } : null;
    }).filter(Boolean);
    const results = rrfMerge({ lexical, semantic }, limit);
    const touch = db.prepare(`UPDATE memory_fragments SET access_count=access_count+1, last_accessed_at=CURRENT_TIMESTAMP WHERE id=?`);
    db.transaction(() => results.filter((row) => row.layer === 'fragment').forEach((row) => touch.run(row.id)))();
    return results;
  }

  function traceFragment(fragmentId) {
    const fragment = db.prepare('SELECT * FROM memory_fragments WHERE id=?').get(fragmentId);
    if (!fragment) return null;
    let ids = [];
    try { ids = JSON.parse(fragment.source_message_ids || '[]'); } catch { ids = []; }
    const messages = ids.length
      ? db.prepare(`SELECT id, chat_id, role, content, created_at FROM messages WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids)
      : [];
    const corrections = db.prepare(`
      SELECT id, wrong_text, correct_text, reason, source_message_id, created_at
      FROM corrections
      WHERE target_type='memory_fragment' AND target_id=?
      ORDER BY id
    `).all(fragmentId);
    return { fragment, messages, corrections };
  }

  return { search, searchHybrid, traceFragment };
}

module.exports = { createLibrarian, tokenizeQuery, rrfMerge, recallPermission };

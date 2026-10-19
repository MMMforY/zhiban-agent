function createArchivist({ db, llm, vectorStore }) {
  function lightweightCycle() {
    const now = new Date();
    const cooling = new Date(now.getTime() - 14 * 86400000).toISOString();
    const frozen = new Date(now.getTime() - 30 * 86400000).toISOString();
    const archiveCutoff = new Date(now.getTime() - 90 * 86400000).toISOString();
    const expiredStates = db.prepare(`
      UPDATE current_states SET status='expired', updated_at=CURRENT_TIMESTAMP
      WHERE status='active' AND expires_at <= CURRENT_TIMESTAMP
    `).run().changes;
    const cooled = db.prepare(`
      UPDATE memory_fragments SET status='cooling', lifecycle_updated_at=CURRENT_TIMESTAMP
      WHERE status='active' AND COALESCE(last_accessed_at, created_at) < ?
    `).run(cooling).changes;
    const froze = db.prepare(`
      UPDATE memory_fragments SET status='frozen', lifecycle_updated_at=CURRENT_TIMESTAMP
      WHERE status='cooling' AND COALESCE(last_accessed_at, created_at) < ?
    `).run(frozen).changes;
    // Frozen is the cold-archive state. Old memories remain source-traceable:
    // reaching 90 days never overwrites their content or deletes their vector.
    const archived = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM memory_fragments
      WHERE status='frozen' AND COALESCE(last_accessed_at, created_at) < ?
    `).get(archiveCutoff)?.count || 0);
    db.prepare(`
      UPDATE entities SET fragment_count=(
        SELECT COUNT(*) FROM fragment_entities fe
        JOIN memory_fragments mf ON mf.id=fe.fragment_id
        WHERE fe.entity_id=entities.id
          AND mf.write_state='active' AND mf.status != 'tombstone'
      ), status=CASE
        WHEN status='seed' AND (
          SELECT COUNT(*) FROM fragment_entities fe
          JOIN memory_fragments mf ON mf.id=fe.fragment_id
          WHERE fe.entity_id=entities.id
            AND mf.write_state='active' AND mf.status != 'tombstone'
        ) >= 2 THEN 'active'
        ELSE status END,
      updated_at=CURRENT_TIMESTAMP
    `).run();
    return { expiredStates, cooled, froze, archived, tombstoned: 0 };
  }

  async function deepCycle() {
    const runId = db.prepare(`INSERT INTO pipeline_runs(component,status) VALUES('archivist','running')`).run().lastInsertRowid;
    const lightweight = lightweightCycle();
    if (!llm.enabled) {
      db.prepare(`UPDATE pipeline_runs SET status='done', detail_json=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(JSON.stringify({ lightweight, deep: 'llm_disabled' }), runId);
      return { lightweight, skipped: true, reason: 'llm_disabled' };
    }
    const entities = db.prepare(`
      SELECT e.id, e.name, e.category FROM entities e
      WHERE e.status IN ('seed','active') AND (
        SELECT COUNT(*) FROM fragment_entities fe
        JOIN memory_fragments mf ON mf.id=fe.fragment_id
        WHERE fe.entity_id=e.id
          AND mf.write_state='active' AND mf.status='active'
      ) >= 4 LIMIT 10
    `).all();
    const consolidated = [];
    for (const entity of entities) {
      const fragments = db.prepare(`
        SELECT mf.id, mf.type, mf.content, mf.source_date, mf.emotional_weight
        FROM fragment_entities fe JOIN memory_fragments mf ON mf.id=fe.fragment_id
        WHERE fe.entity_id=?
          AND mf.write_state='active' AND mf.status='active'
        ORDER BY mf.source_date, mf.id LIMIT 30
      `).all(entity.id);
      const prompt = `Consolidate these source-grounded memory fragments about ${entity.name} into one coherent episode.
Do not invent details. Preserve corrections and dates. Return JSON:
{"title":"short title","content":"100-250 word narrative","overview":"objective overview","current_status":"latest known change","judgment":"companion's tentative impression, explicitly uncertain when evidence is weak","importance":0.0}`;
      const episode = await llm.completeJson([
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(fragments) }
      ], { temperature: 0.2, maxTokens: 1800 });
      const fragmentIds = fragments.map((fragment) => fragment.id);
      db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO episodes(title,content,entity_id,source_fragment_ids,importance,valid_from)
          VALUES(?,?,?,?,?,?)
        `).run(
          String(episode.title || entity.name).slice(0, 200),
          String(episode.content || '').slice(0, 5000),
          entity.id,
          JSON.stringify(fragmentIds),
          Math.max(0, Math.min(1, Number(episode.importance) || 0.5)),
          fragments[0]?.source_date || null
        );
        db.prepare(`
          UPDATE entities SET overview=?, current_status=?, judgment=?, status='active', updated_at=CURRENT_TIMESTAMP WHERE id=?
        `).run(
          String(episode.overview || '').slice(0, 2000),
          String(episode.current_status || '').slice(0, 1000),
          String(episode.judgment || '').slice(0, 1000),
          entity.id
        );
        db.prepare(`UPDATE memory_fragments SET status='consolidated', updated_at=CURRENT_TIMESTAMP WHERE id IN (${fragmentIds.map(() => '?').join(',')})`).run(...fragmentIds);
        consolidated.push({ entityId: entity.id, episodeId: Number(result.lastInsertRowid), fragmentIds });
      })();
    }
    db.prepare(`UPDATE pipeline_runs SET status='done', detail_json=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(JSON.stringify({ lightweight, consolidated }), runId);
    return { lightweight, consolidated };
  }

  return { lightweightCycle, deepCycle };
}

module.exports = { createArchivist };

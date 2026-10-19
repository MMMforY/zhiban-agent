const crypto = require('crypto');

const UNIT_TYPES = new Set(['segment', 'route_card']);

function parseJson(value, fallback = []) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function clamp(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(number, 2)) : fallback;
}

function publicUnit(row) {
  if (!row) return null;
  return {
    id: row.id,
    assetId: row.asset_id,
    unitType: row.unit_type,
    unitKey: row.unit_key,
    ordinal: row.ordinal,
    sectionId: row.section_id,
    sectionTitle: row.section_title,
    title: row.title,
    content: row.content,
    contentSha256: row.content_sha256,
    keywords: parseJson(row.keywords_json),
    evidence: parseJson(row.evidence_json),
    sourceLineStart: row.source_line_start,
    sourceLineEnd: row.source_line_end,
    baseRetrievalWeight: row.base_retrieval_weight,
    status: row.status,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    document: row.document_title ? {
      title: row.document_title,
      sourceType: row.source_type,
      author: row.document_author,
      authority: row.document_authority,
      temporalInterpretation: row.temporal_interpretation,
      startedAt: row.started_at,
      versionLabel: row.version_label,
      sourceSha256: row.source_sha256
    } : undefined
  };
}

function createAssetDocumentStore({ db, vectorStore, config = {} }) {
  function findBySourceHash(sourceSha256) {
    return db.prepare('SELECT * FROM asset_documents WHERE source_sha256=?').get(String(sourceSha256 || '').toLowerCase()) || null;
  }

  function importDocument(assetId, document = {}, units = []) {
    const id = String(assetId || '');
    if (!db.prepare("SELECT id FROM assets WHERE id=? AND status='active'").get(id)) {
      throw Object.assign(new Error('asset_not_found'), { statusCode: 404 });
    }
    const sourceSha256 = String(document.sourceSha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('invalid_document_source_sha256');
    const existing = findBySourceHash(sourceSha256);
    if (existing) return { deduplicated: true, assetId: existing.asset_id, unitCount: 0 };
    const title = String(document.title || '').trim();
    if (!title) throw new Error('document_title_is_required');
    if (!Array.isArray(units) || !units.length) throw new Error('document_units_are_required');

    const seen = new Set();
    const normalized = units.map((unit, index) => {
      const unitType = String(unit.unitType || '');
      if (!UNIT_TYPES.has(unitType)) throw new Error(`invalid_document_unit_type_${unitType}`);
      const unitId = String(unit.id || '');
      if (!unitId || seen.has(unitId)) throw new Error('document_unit_ids_must_be_unique');
      seen.add(unitId);
      const content = String(unit.content || '').trim();
      if (!content) throw new Error(`document_unit_content_is_required_${unitId}`);
      const contentSha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      if (unit.contentSha256 && String(unit.contentSha256).toLowerCase() !== contentSha256) {
        throw new Error(`document_unit_hash_mismatch_${unitId}`);
      }
      const evidence = Array.isArray(unit.evidence) ? unit.evidence : [];
      if (unitType === 'route_card' && !evidence.length) throw new Error(`route_card_evidence_is_required_${unitId}`);
      return {
        id: unitId,
        unitType,
        unitKey: String(unit.unitKey || unitId),
        ordinal: Number.isInteger(Number(unit.ordinal)) ? Number(unit.ordinal) : index,
        sectionId: String(unit.sectionId || ''),
        sectionTitle: String(unit.sectionTitle || ''),
        title: String(unit.title || ''),
        content,
        contentSha256,
        keywordsJson: JSON.stringify(Array.isArray(unit.keywords) ? unit.keywords : []),
        evidenceJson: JSON.stringify(evidence),
        sourceLineStart: Number.isInteger(Number(unit.sourceLineStart)) ? Number(unit.sourceLineStart) : null,
        sourceLineEnd: Number.isInteger(Number(unit.sourceLineEnd)) ? Number(unit.sourceLineEnd) : null,
        baseRetrievalWeight: clamp(unit.baseRetrievalWeight, 1)
      };
    });

    db.transaction(() => {
      db.prepare(`INSERT INTO asset_documents(
        asset_id,source_type,title,author,authority,temporal_interpretation,started_at,version_label,
        document_status,source_sha256,metadata_json,base_retrieval_weight,status,activated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'active',CURRENT_TIMESTAMP)`).run(
        id, String(document.sourceType || 'reference'), title, String(document.author || ''),
        String(document.authority || 'external_reference'), String(document.temporalInterpretation || 'source_at_document_version'),
        document.startedAt || null, String(document.versionLabel || ''), String(document.documentStatus || ''), sourceSha256,
        JSON.stringify(document.metadata || {}), clamp(document.baseRetrievalWeight, 1)
      );
      const insert = db.prepare(`INSERT INTO asset_document_units(
        id,asset_id,unit_type,unit_key,ordinal,section_id,section_title,title,content,content_sha256,
        keywords_json,evidence_json,source_line_start,source_line_end,base_retrieval_weight,status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active')`);
      for (const unit of normalized) {
        insert.run(unit.id,id,unit.unitType,unit.unitKey,unit.ordinal,unit.sectionId,unit.sectionTitle,
          unit.title,unit.content,unit.contentSha256,unit.keywordsJson,unit.evidenceJson,
          unit.sourceLineStart,unit.sourceLineEnd,unit.baseRetrievalWeight);
        vectorStore.enqueueUpsert(unit.id);
      }
    })();
    return {
      deduplicated: false,
      assetId: id,
      unitCount: normalized.length,
      segmentCount: normalized.filter((item) => item.unitType === 'segment').length,
      routeCardCount: normalized.filter((item) => item.unitType === 'route_card').length
    };
  }

  function rowForUnit(id) {
    return db.prepare(`SELECT u.*,d.title AS document_title,d.source_type,d.author AS document_author,
      d.authority AS document_authority,d.temporal_interpretation,d.started_at,d.version_label,d.source_sha256
      ,a.status AS asset_status,d.status AS document_record_status
      FROM asset_document_units u JOIN asset_documents d ON d.asset_id=u.asset_id JOIN assets a ON a.id=d.asset_id
      WHERE u.id=?`).get(String(id));
  }

  function get(assetId, options = {}) {
    const document = db.prepare(`SELECT d.*,a.filename,a.kind,a.caption,a.status AS asset_status
      FROM asset_documents d JOIN assets a ON a.id=d.asset_id WHERE d.asset_id=?`).get(String(assetId));
    if (!document || document.asset_status !== 'active' || document.status !== 'active') return null;
    const units = options.includeUnits === false ? [] : db.prepare(`SELECT * FROM asset_document_units
      WHERE asset_id=? AND status='active' ORDER BY CASE unit_type WHEN 'route_card' THEN 0 ELSE 1 END,ordinal,id`)
      .all(String(assetId)).map((row) => publicUnit({ ...row,
        document_title: document.title,source_type:document.source_type,document_author:document.author,
        document_authority:document.authority,temporal_interpretation:document.temporal_interpretation,
        started_at:document.started_at,version_label:document.version_label,source_sha256:document.source_sha256
      }));
    return {
      document: {
        assetId: document.asset_id, sourceType: document.source_type, title: document.title,
        author: document.author, authority: document.authority,
        temporalInterpretation: document.temporal_interpretation, startedAt: document.started_at,
        versionLabel: document.version_label, documentStatus: document.document_status,
        sourceSha256: document.source_sha256, metadata: parseJson(document.metadata_json, {}),
        status: document.status, createdAt: document.created_at, activatedAt: document.activated_at,
        filename: document.filename, contentPath: `/api/v1/assets/${document.asset_id}/content`
      },
      units
    };
  }

  function lexicalSearch(query, options = {}) {
    const text = String(query || '').trim();
    if (!text) return [];
    const escaped = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
    const bindings = [escaped, escaped, escaped];
    let typeSql = '';
    if (UNIT_TYPES.has(options.unitType)) { typeSql = ' AND u.unit_type=?'; bindings.push(options.unitType); }
    return db.prepare(`SELECT u.id FROM asset_document_units u JOIN asset_documents d ON d.asset_id=u.asset_id
      JOIN assets a ON a.id=d.asset_id
      WHERE u.status='active' AND d.status='active' AND a.status='active' AND (u.title LIKE ? ESCAPE '\\' OR u.content LIKE ? ESCAPE '\\'
        OR u.keywords_json LIKE ? ESCAPE '\\')${typeSql} ORDER BY u.base_retrieval_weight DESC,u.ordinal LIMIT ?`)
      .all(...bindings, Math.max(1, Math.min(Number(options.limit) || 30, 100))).map((row) => row.id);
  }

  async function search(query, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 8, 30));
    const lexicalIds = lexicalSearch(query, { ...options, limit: 50 });
    const semantic = await vectorStore.search(query, {
      limit: Math.max(limit, 8), unitType: options.unitType, maxDistance: options.maxDistance
    });
    const scores = new Map();
    lexicalIds.forEach((id, index) => scores.set(id, { score: 1 / (30 + index + 1), lexicalRank: index + 1 }));
    semantic.forEach((item, index) => {
      const current = scores.get(item.unitId) || { score: 0 };
      scores.set(item.unitId, { ...current, score: current.score + 1 / (30 + index + 1), distance: item.distance });
    });
    const ids = [...scores.entries()].sort((a,b) => b[1].score-a[1].score).map(([id]) => id).slice(0, limit);
    if (!ids.length) return [];
    const rows = ids.map(rowForUnit).filter((row) => row && row.status === 'active' && row.document_record_status === 'active' && row.asset_status === 'active');
    const touch = db.prepare('UPDATE asset_document_units SET access_count=access_count+1,last_accessed_at=CURRENT_TIMESTAMP WHERE id=?');
    db.transaction(() => rows.forEach((row) => touch.run(row.id)))();
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    return ids.filter((id) => rowMap.has(id)).map((id) => ({ ...publicUnit(rowMap.get(id)), match: scores.get(id) }));
  }

  async function searchRouteCards(query, limit) {
    if (!config.recallEnabled) return [];
    return search(query, {
      limit: Number(limit) || config.recallMaxResults || 1,
      unitType: 'route_card',
      maxDistance: config.recallMaxDistance
    });
  }

  function status() {
    const documents = Object.fromEntries(db.prepare(`SELECT status,COUNT(*) count FROM asset_documents GROUP BY status`)
      .all().map((row) => [row.status,row.count]));
    const units = Object.fromEntries(db.prepare(`SELECT unit_type,COUNT(*) count FROM asset_document_units WHERE status='active' GROUP BY unit_type`)
      .all().map((row) => [row.unit_type,row.count]));
    return { documents, units };
  }

  function archiveAsset(assetId) {
    const ids = db.prepare("SELECT id FROM asset_document_units WHERE asset_id=? AND status='active'").all(String(assetId));
    if (!ids.length && !db.prepare('SELECT asset_id FROM asset_documents WHERE asset_id=?').get(String(assetId))) return 0;
    db.transaction(() => {
      db.prepare("UPDATE asset_documents SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE asset_id=?").run(String(assetId));
      db.prepare("UPDATE asset_document_units SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE asset_id=?").run(String(assetId));
      ids.forEach((row) => vectorStore.enqueueDelete(row.id));
    })();
    return ids.length;
  }

  return { findBySourceHash, importDocument, get, search, searchRouteCards, archiveAsset, status };
}

module.exports = { createAssetDocumentStore };

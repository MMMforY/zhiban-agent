const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readJsonl(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); }
function ftsQuery(value) {
  return String(value || '').match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 8).map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ') || '';
}

function createDiaryStore({ db, storagePath, vectorStore, config = {} }) {
  fs.mkdirSync(storagePath, { recursive: true });

  function stageBundle(bundlePath) {
    const root = path.resolve(bundlePath); const manifest = readJson(path.join(root, 'manifest.json'));
    const original = fs.readFileSync(path.join(root, 'original.md'));
    if (hash(original) !== manifest.source.sha256) throw new Error('diary_source_hash_mismatch');
    const entries = readJsonl(path.join(root, 'entries.jsonl')); const chunks = readJsonl(path.join(root, 'chunks.jsonl'));
    if (entries.length !== manifest.counts.entries || chunks.length !== manifest.counts.chunks) throw new Error('diary_bundle_count_mismatch');
    const existing = db.prepare('SELECT * FROM diary_documents WHERE source_sha256=?').get(manifest.source.sha256);
    if (existing) return { deduplicated: true, documentId: existing.id, status: existing.status, entries: existing.entry_count, chunks: existing.chunk_count };
    const storageName = `${manifest.source.sha256}.md`; const destination = path.join(storagePath, storageName);
    fs.writeFileSync(destination, original, { flag: 'wx' });
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO diary_import_runs(id,document_id,source_sha256,manifest_json) VALUES(?,?,?,?)')
          .run(manifest.import_id, manifest.document_id, manifest.source.sha256, JSON.stringify(manifest));
        db.prepare(`INSERT INTO diary_documents(id,import_run_id,source_sha256,filename,storage_name,size_bytes,character_count,entry_count,chunk_count,authority,base_retrieval_weight)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(manifest.document_id, manifest.import_id, manifest.source.sha256, manifest.source.filename, storageName,
          manifest.source.size_bytes, manifest.source.characters, entries.length, chunks.length, manifest.policy.authority, manifest.policy.base_retrieval_weight);
        const insertEntry = db.prepare(`INSERT INTO diary_entries(id,document_id,cycle_id,cycle_day_original,cycle_day_normalized,raw_label,absolute_date,date_status,date_confidence,date_evidence_json,source_line_start,source_line_end,content,content_sha256,base_retrieval_weight,resolution_status,anomalies_json)
          VALUES(@id,@document_id,@cycle_id,@cycle_day_original,@cycle_day_normalized,@raw_label,@absolute_date,@date_status,@date_confidence,@date_evidence_json,@source_line_start,@source_line_end,@content,@content_sha256,@base_retrieval_weight,@resolution_status,@anomalies_json)`);
        entries.forEach((row) => insertEntry.run(row));
        const insertChunk = db.prepare(`INSERT INTO diary_chunks(id,entry_id,document_id,chunk_index,content,content_sha256,absolute_date,cycle_id,cycle_day,source_line_start,source_line_end,base_retrieval_weight)
          VALUES(@id,@entry_id,@document_id,@chunk_index,@content,@content_sha256,@absolute_date,@cycle_id,@cycle_day,@source_line_start,@source_line_end,@base_retrieval_weight)`);
        chunks.forEach((row) => insertChunk.run(row));
      })();
    } catch (error) { if (fs.existsSync(destination)) fs.rmSync(destination); throw error; }
    return { deduplicated: false, documentId: manifest.document_id, status: 'staged', entries: entries.length, chunks: chunks.length };
  }

  function activate(documentId) {
    const row = db.prepare('SELECT * FROM diary_documents WHERE id=?').get(String(documentId));
    if (!row) throw new Error('diary_document_not_found');
    db.transaction(() => {
      db.prepare("UPDATE diary_documents SET status='active',activated_at=COALESCE(activated_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      db.prepare("UPDATE diary_entries SET status='active',updated_at=CURRENT_TIMESTAMP WHERE document_id=?").run(row.id);
      db.prepare("UPDATE diary_chunks SET status='active',updated_at=CURRENT_TIMESTAMP WHERE document_id=?").run(row.id);
      db.prepare("UPDATE diary_import_runs SET status='active',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(row.import_run_id);
      db.prepare(`INSERT INTO diary_vector_jobs(chunk_id,operation,status) SELECT id,'upsert','pending' FROM diary_chunks WHERE document_id=?
        ON CONFLICT(chunk_id) DO UPDATE SET operation='upsert',status='pending',attempts=0,last_error='',updated_at=CURRENT_TIMESTAMP,completed_at=NULL`).run(row.id);
    })();
    return status(row.id);
  }

  function archive(documentId) {
    const row = db.prepare('SELECT * FROM diary_documents WHERE id=?').get(String(documentId)); if (!row) return null;
    db.transaction(() => {
      db.prepare("UPDATE diary_documents SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      db.prepare("UPDATE diary_entries SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE document_id=?").run(row.id);
      db.prepare("UPDATE diary_chunks SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE document_id=?").run(row.id);
      db.prepare(`INSERT INTO diary_vector_jobs(chunk_id,operation,status) SELECT id,'delete','pending' FROM diary_chunks WHERE document_id=?
        ON CONFLICT(chunk_id) DO UPDATE SET operation='delete',status='pending',attempts=0,last_error='',updated_at=CURRENT_TIMESTAMP,completed_at=NULL`).run(row.id);
    })(); return status(row.id);
  }

  function status(documentId) {
    const where = documentId ? 'WHERE d.id=?' : ''; const args = documentId ? [String(documentId)] : [];
    return db.prepare(`SELECT d.*, (SELECT COUNT(*) FROM diary_entries e WHERE e.document_id=d.id) actual_entries,
      (SELECT COUNT(*) FROM diary_chunks c WHERE c.document_id=d.id) actual_chunks FROM diary_documents d ${where} ORDER BY d.created_at DESC`).all(...args);
  }

  async function search(query, limit = config.maxResults || 3) {
    if (!config.recallEnabled || !String(query || '').trim()) return [];
    const capped = Math.max(1, Math.min(Number(limit) || 3, 8)); const scores = new Map();
    const dateMatch = String(query).match(/((?:19|20)\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?/);
    if (dateMatch) {
      const date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
      db.prepare("SELECT id FROM diary_chunks WHERE status='active' AND absolute_date=? ORDER BY chunk_index LIMIT 20").all(date)
        .forEach((row, i) => scores.set(row.id, { score: 2 / (60 + i + 1), dateRank: i + 1 }));
    }
    const match = ftsQuery(query);
    if (match) {
      try { db.prepare(`SELECT c.id FROM diary_chunks_fts f JOIN diary_chunks c ON c.id=f.chunk_id WHERE diary_chunks_fts MATCH ? AND c.status='active' ORDER BY bm25(diary_chunks_fts) LIMIT 50`).all(match)
        .forEach((row, i) => { const s = scores.get(row.id) || { score: 0 }; scores.set(row.id, { ...s, score: s.score + 1 / (60 + i + 1), lexicalRank: i + 1 }); }); } catch (_) { /* Unicode FTS may yield no tokens. */ }
    }
    (await vectorStore.search(query, Math.max(capped, 8))).forEach((row, i) => { const s = scores.get(row.chunkId) || { score: 0 }; scores.set(row.chunkId, { ...s, score: s.score + 1 / (60 + i + 1), distance: row.distance }); });
    const ids = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).map(([id]) => id).slice(0, capped);
    if (!ids.length) return [];
    const rows = db.prepare(`SELECT c.*,e.raw_label,e.date_confidence FROM diary_chunks c JOIN diary_entries e ON e.id=c.entry_id WHERE c.id IN (${ids.map(() => '?').join(',')}) AND c.status='active'`).all(...ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const result = ids.filter((id) => byId.has(id)).map((id) => ({ ...byId.get(id), match: scores.get(id), sourceKind: 'diary', recallPermission: 'historical_self_report' }));
    const touch = db.prepare('UPDATE diary_chunks SET access_count=access_count+1,last_accessed_at=CURRENT_TIMESTAMP WHERE id=?'); db.transaction(() => result.forEach((row) => touch.run(row.id)))();
    let chars = 0; const maxChars = Number(config.maxContextChars || 2500);
    return result.filter((row) => { if (chars + row.content.length > maxChars) return false; chars += row.content.length; return true; });
  }

  function entry(id) { return db.prepare("SELECT * FROM diary_entries WHERE id=? AND status='active'").get(String(id)) || null; }
  return { stageBundle, activate, archive, status, search, entry, storagePath };
}

module.exports = { createDiaryStore };

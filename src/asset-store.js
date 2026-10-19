const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KINDS = new Set(['photo', 'document', 'audio', 'other']);
const ANNOTATION_TYPES = new Set(['user_caption', 'vision', 'ocr', 'transcript', 'manual_note']);
const AUTHORITIES = new Set(['user', 'model', 'system']);

function safeFilename(value) {
  const base = path.basename(String(value || 'asset.bin')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return (base || 'asset.bin').slice(0, 240);
}

function safeExtension(filename) {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin';
}

function publicAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.blob_sha256,
    caption: row.caption,
    sourcePlatform: row.source_platform,
    sourceSessionId: row.source_session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentPath: `/api/v1/assets/${row.id}/content`
  };
}

function createAssetStore({ db, storagePath, maxBytes, vectorStore }) {
  fs.mkdirSync(storagePath, { recursive: true });

  function row(id) {
    return db.prepare(`
      SELECT a.*,b.mime_type,b.size_bytes,b.storage_name FROM assets a
      JOIN asset_blobs b ON b.sha256=a.blob_sha256 WHERE a.id=?
    `).get(String(id));
  }

  function ingest(buffer, metadata = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error('asset_content_is_required'), { statusCode: 400 });
    if (buffer.length > maxBytes) throw Object.assign(new Error(`asset_too_large_max_${maxBytes}_bytes`), { statusCode: 413 });
    const filename = safeFilename(metadata.filename);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const mimeType = String(metadata.mimeType || 'application/octet-stream').slice(0, 200);
    const storageName = `${sha256}${safeExtension(filename)}`;
    const destination = path.join(storagePath, storageName);
    const existingBlob = db.prepare('SELECT sha256 FROM asset_blobs WHERE sha256=?').get(sha256);
    if (!existingBlob) {
      fs.writeFileSync(destination, buffer, { flag: 'wx' });
      try {
        db.prepare('INSERT INTO asset_blobs(sha256,storage_name,size_bytes,mime_type) VALUES(?,?,?,?)')
          .run(sha256, storageName, buffer.length, mimeType);
      } catch (error) {
        if (fs.existsSync(destination)) fs.rmSync(destination);
        throw error;
      }
    }
    const id = crypto.randomUUID();
    const kind = KINDS.has(metadata.kind) ? metadata.kind : 'other';
    const caption = String(metadata.caption || '').trim().slice(0, 10000);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO assets(id,blob_sha256,kind,filename,caption,source_platform,source_session_id)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        id, sha256, kind, filename, caption,
        String(metadata.sourcePlatform || '').slice(0, 100),
        String(metadata.sourceSessionId || '').slice(0, 500)
      );
      if (caption) db.prepare(`
        INSERT INTO asset_annotations(asset_id,annotation_type,content,authority,confidence)
        VALUES(?, 'user_caption', ?, 'user', 1.0)
      `).run(id, caption);
    })();
    vectorStore.enqueueUpsert(id);
    return publicAsset(row(id));
  }

  function get(id) {
    const assetRow = row(id);
    if (!assetRow || assetRow.status !== 'active') return null;
    return {
      asset: publicAsset(assetRow),
      annotations: db.prepare('SELECT * FROM asset_annotations WHERE asset_id=? ORDER BY id').all(String(id)),
      messages: db.prepare(`
        SELECT m.id,m.chat_id,m.role,m.content,m.created_at,ma.relation
        FROM message_assets ma JOIN messages m ON m.id=ma.message_id WHERE ma.asset_id=? ORDER BY m.id
      `).all(String(id))
    };
  }

  function content(id) {
    const assetRow = row(id);
    if (!assetRow || assetRow.status !== 'active') return null;
    const root = path.resolve(storagePath);
    const filePath = path.resolve(root, assetRow.storage_name);
    if (!(filePath === root || filePath.startsWith(`${root}${path.sep}`)) || !fs.existsSync(filePath)) return null;
    return { asset: publicAsset(assetRow), filePath };
  }

  function link(id, messageId, relation = 'attachment') {
    const assetRow = row(id);
    if (!assetRow || assetRow.status !== 'active') return null;
    if (!db.prepare('SELECT id FROM messages WHERE id=?').get(Number(messageId))) {
      throw Object.assign(new Error('message_not_found'), { statusCode: 404 });
    }
    db.prepare(`INSERT OR IGNORE INTO message_assets(message_id,asset_id,relation) VALUES(?,?,?)`)
      .run(Number(messageId), String(id), String(relation || 'attachment').slice(0, 100));
    return { assetId: String(id), messageId: Number(messageId), relation };
  }

  function addAnnotation(id, input = {}) {
    if (!row(id)) return null;
    const type = String(input.type || 'manual_note');
    const authority = String(input.authority || 'model');
    const contentValue = String(input.content || '').trim().slice(0, 100000);
    if (!ANNOTATION_TYPES.has(type)) throw Object.assign(new Error('invalid_annotation_type'), { statusCode: 400 });
    if (!AUTHORITIES.has(authority)) throw Object.assign(new Error('invalid_annotation_authority'), { statusCode: 400 });
    if (!contentValue) throw Object.assign(new Error('annotation_content_is_required'), { statusCode: 400 });
    const requestedConfidence = Number(input.confidence ?? 0.7);
    if (!Number.isFinite(requestedConfidence)) {
      throw Object.assign(new Error('invalid_annotation_confidence'), { statusCode: 400 });
    }
    const confidence = Math.max(0, Math.min(requestedConfidence, 1));
    const result = db.prepare(`
      INSERT INTO asset_annotations(asset_id,annotation_type,content,authority,confidence,provider,model)
      VALUES(?,?,?,?,?,?,?)
    `).run(
      String(id), type, contentValue, authority, confidence,
      String(input.provider || '').slice(0, 200), String(input.model || '').slice(0, 200)
    );
    vectorStore.enqueueUpsert(String(id));
    return db.prepare('SELECT * FROM asset_annotations WHERE id=?').get(result.lastInsertRowid);
  }

  function lexicalSearch(query, kind, limit = 50) {
    const terms = String(query || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
    const clauses = ["a.status='active'"];
    const bindings = [];
    if (KINDS.has(kind)) { clauses.push('a.kind=?'); bindings.push(kind); }
    for (const term of terms) {
      const escaped = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push(`(a.filename LIKE ? ESCAPE '\\' OR a.caption LIKE ? ESCAPE '\\' OR EXISTS(
        SELECT 1 FROM asset_annotations aa WHERE aa.asset_id=a.id AND aa.content LIKE ? ESCAPE '\\'
      ))`);
      bindings.push(escaped, escaped, escaped);
    }
    return db.prepare(`
      SELECT a.*,b.mime_type,b.size_bytes,b.storage_name FROM assets a
      JOIN asset_blobs b ON b.sha256=a.blob_sha256
      WHERE ${clauses.join(' AND ')} ORDER BY a.created_at DESC LIMIT ?
    `).all(...bindings, Math.max(1, Math.min(Number(limit) || 50, 100)));
  }

  async function search({ query = '', kind = '', limit = 20 } = {}) {
    const capped = Math.max(1, Math.min(Number(limit) || 20, 50));
    const lexical = lexicalSearch(query, kind, 100);
    if (!String(query || '').trim()) return lexical.slice(0, capped).map(publicAsset);
    const semantic = await vectorStore.search(query, Math.max(capped, 8));
    const scores = new Map();
    lexical.forEach((item, index) => scores.set(item.id, { score: 1 / (60 + index + 1), lexicalRank: index + 1 }));
    semantic.forEach((item, index) => {
      const current = scores.get(item.assetId) || { score: 0 };
      scores.set(item.assetId, { ...current, score: current.score + 1 / (60 + index + 1), distance: item.distance });
    });
    const ids = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).map(([id]) => id);
    if (!ids.length) return [];
    const rows = db.prepare(`
      SELECT a.*,b.mime_type,b.size_bytes,b.storage_name FROM assets a
      JOIN asset_blobs b ON b.sha256=a.blob_sha256
      WHERE a.id IN (${ids.map(() => '?').join(',')}) AND a.status='active'
    `).all(...ids);
    const rowMap = new Map(rows.filter((item) => !KINDS.has(kind) || item.kind === kind).map((item) => [item.id, item]));
    return ids.filter((id) => rowMap.has(id)).slice(0, capped).map((id) => ({
      ...publicAsset(rowMap.get(id)),
      match: scores.get(id)
    }));
  }

  function remove(id) {
    const assetRow = row(id);
    if (!assetRow || assetRow.status !== 'active') return false;
    db.prepare("UPDATE assets SET status='deleted',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(id));
    vectorStore.enqueueDelete(String(id));
    return true;
  }

  return { ingest, get, content, link, addAnnotation, search, remove, storagePath, maxBytes };
}

module.exports = { createAssetStore };

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function addTransactionHelper(db) {
  db.transaction = (work) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work(...args);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return db;
}

function initializeDatabase(databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = addTransactionHelper(new DatabaseSync(databasePath));
  db.exec('PRAGMA foreign_keys = ON');
  if (databasePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS runtime_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New conversation',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_message_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      memory_processed INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_unprocessed ON messages(memory_processed, id);

    CREATE TABLE IF NOT EXISTS external_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      external_session_id TEXT NOT NULL,
      external_turn_id TEXT NOT NULL,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      assistant_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      platform TEXT NOT NULL DEFAULT '',
      external_user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, external_session_id, external_turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_external_turns_chat ON external_turns(chat_id, id);

    CREATE TABLE IF NOT EXISTS persona_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      continuity_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      section_type TEXT NOT NULL CHECK(section_type IN ('identity_anchor','relationship_model','user_model','self_model')),
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      authority TEXT NOT NULL CHECK(authority IN ('core','curated','learned')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','rejected')),
      source_path TEXT,
      source_version TEXT,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 1.0,
      supersedes_id INTEGER REFERENCES persona_sections(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_active_key
      ON persona_sections(continuity_id, section_key) WHERE status='active';

    CREATE TABLE IF NOT EXISTS persona_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      continuity_id TEXT NOT NULL,
      target_section_key TEXT NOT NULL,
      claim TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      evidence_count INTEGER NOT NULL DEFAULT 1,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'observing' CHECK(status IN ('observing','pending','approved','rejected')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'person',
      overview TEXT NOT NULL DEFAULT '',
      current_status TEXT NOT NULL DEFAULT '',
      judgment TEXT NOT NULL DEFAULT '',
      aliases_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('seed','active','merged','archived')),
      fragment_count INTEGER NOT NULL DEFAULT 0,
      first_mentioned_at TEXT,
      last_mentioned_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory_fragments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('observation','preference','event','state','reflection')),
      entity TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      emotional_weight REAL NOT NULL DEFAULT 0.3,
      confidence REAL NOT NULL DEFAULT 0.7,
      write_state TEXT NOT NULL DEFAULT 'active' CHECK(write_state IN ('active','observed')),
      source_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      source_message_ids TEXT NOT NULL DEFAULT '[]',
      source_date TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','consolidated','cooling','frozen','tombstone')),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      lifecycle_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_fragments_status ON memory_fragments(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_fragments_entity ON memory_fragments(entity);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fragments_fts USING fts5(
      content,
      entity,
      type,
      content='memory_fragments',
      content_rowid='id',
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS memory_fragments_ai AFTER INSERT ON memory_fragments BEGIN
      INSERT INTO memory_fragments_fts(rowid, content, entity, type)
      VALUES (new.id, new.content, new.entity, new.type);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fragments_ad AFTER DELETE ON memory_fragments BEGIN
      INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, content, entity, type)
      VALUES ('delete', old.id, old.content, old.entity, old.type);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fragments_au AFTER UPDATE ON memory_fragments BEGIN
      INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, content, entity, type)
      VALUES ('delete', old.id, old.content, old.entity, old.type);
      INSERT INTO memory_fragments_fts(rowid, content, entity, type)
      VALUES (new.id, new.content, new.entity, new.type);
    END;

    CREATE TABLE IF NOT EXISTS fragment_entities (
      fragment_id INTEGER NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      PRIMARY KEY(fragment_id, entity_id)
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      source_fragment_ids TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','mature','archived')),
      valid_from TEXT,
      valid_to TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_entity ON episodes(entity_id, created_at);

    CREATE TABLE IF NOT EXISTS sagas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      episode_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'experimental',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS current_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','resolved','expired')),
      resolution TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER,
      wrong_text TEXT,
      correct_text TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      component TEXT NOT NULL,
      status TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS vector_index_jobs (
      object_type TEXT NOT NULL CHECK(object_type IN ('fragment')),
      object_id INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      PRIMARY KEY(object_type, object_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vector_jobs_status ON vector_index_jobs(status, updated_at);

    CREATE TABLE IF NOT EXISTS asset_blobs (
      sha256 TEXT PRIMARY KEY,
      storage_name TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      blob_sha256 TEXT NOT NULL REFERENCES asset_blobs(sha256),
      kind TEXT NOT NULL CHECK(kind IN ('photo','document','audio','other')),
      filename TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      source_platform TEXT NOT NULL DEFAULT '',
      source_session_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_blob ON assets(blob_sha256);
    CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS message_assets (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'attachment',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(message_id, asset_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_assets_asset ON message_assets(asset_id, message_id);

    CREATE TABLE IF NOT EXISTS asset_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      annotation_type TEXT NOT NULL
        CHECK(annotation_type IN ('user_caption','vision','ocr','transcript','manual_note')),
      content TEXT NOT NULL,
      authority TEXT NOT NULL DEFAULT 'model' CHECK(authority IN ('user','model','system')),
      confidence REAL NOT NULL DEFAULT 0.7,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_asset_annotations_asset ON asset_annotations(asset_id, id);

    CREATE TABLE IF NOT EXISTS asset_vector_jobs (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_asset_vector_jobs_status ON asset_vector_jobs(status, updated_at);

    CREATE TABLE IF NOT EXISTS asset_documents (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL DEFAULT 'reference',
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      authority TEXT NOT NULL DEFAULT 'external_reference',
      temporal_interpretation TEXT NOT NULL DEFAULT 'source_at_document_version',
      started_at TEXT,
      version_label TEXT NOT NULL DEFAULT '',
      document_status TEXT NOT NULL DEFAULT '',
      source_sha256 TEXT NOT NULL UNIQUE,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      base_retrieval_weight REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','active','archived')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      activated_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_asset_documents_type
      ON asset_documents(status,source_type,updated_at);

    CREATE TABLE IF NOT EXISTS asset_document_units (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES asset_documents(asset_id) ON DELETE CASCADE,
      unit_type TEXT NOT NULL CHECK(unit_type IN ('segment','route_card')),
      unit_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      section_id TEXT NOT NULL DEFAULT '',
      section_title TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      keywords_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      source_line_start INTEGER,
      source_line_end INTEGER,
      base_retrieval_weight REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','active','archived')),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(asset_id,unit_type,unit_key)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_document_units_recall
      ON asset_document_units(status,unit_type,asset_id,ordinal);

    CREATE VIRTUAL TABLE IF NOT EXISTS asset_document_units_fts USING fts5(
      unit_id UNINDEXED,
      title,
      content,
      keywords,
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS asset_document_units_ai AFTER INSERT ON asset_document_units BEGIN
      INSERT INTO asset_document_units_fts(unit_id,title,content,keywords)
      VALUES(new.id,new.title,new.content,new.keywords_json);
    END;
    CREATE TRIGGER IF NOT EXISTS asset_document_units_ad AFTER DELETE ON asset_document_units BEGIN
      DELETE FROM asset_document_units_fts WHERE unit_id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS asset_document_units_au AFTER UPDATE ON asset_document_units BEGIN
      DELETE FROM asset_document_units_fts WHERE unit_id=old.id;
      INSERT INTO asset_document_units_fts(unit_id,title,content,keywords)
      VALUES(new.id,new.title,new.content,new.keywords_json);
    END;

    CREATE TABLE IF NOT EXISTS asset_document_vector_jobs (
      unit_id TEXT PRIMARY KEY REFERENCES asset_document_units(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_asset_document_vector_jobs_status
      ON asset_document_vector_jobs(status,updated_at);

    CREATE TABLE IF NOT EXISTS diary_import_runs (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged'
        CHECK(status IN ('staged','active','archived','failed')),
      manifest_json TEXT NOT NULL DEFAULT '{}',
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS diary_documents (
      id TEXT PRIMARY KEY,
      import_run_id TEXT NOT NULL REFERENCES diary_import_runs(id),
      source_sha256 TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      storage_name TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      character_count INTEGER NOT NULL,
      entry_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      authority TEXT NOT NULL DEFAULT 'user_first_person',
      base_retrieval_weight REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'staged'
        CHECK(status IN ('staged','active','archived')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      activated_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_diary_documents_status
      ON diary_documents(status, created_at);

    CREATE TABLE IF NOT EXISTS diary_entries (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES diary_documents(id) ON DELETE CASCADE,
      cycle_id INTEGER NOT NULL,
      cycle_day_original INTEGER NOT NULL,
      cycle_day_normalized INTEGER NOT NULL,
      raw_label TEXT NOT NULL,
      absolute_date TEXT,
      date_status TEXT NOT NULL,
      date_confidence REAL NOT NULL,
      date_evidence_json TEXT NOT NULL DEFAULT '[]',
      source_line_start INTEGER NOT NULL,
      source_line_end INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      base_retrieval_weight REAL NOT NULL DEFAULT 1.0,
      resolution_status TEXT NOT NULL DEFAULT 'clean',
      anomalies_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'staged'
        CHECK(status IN ('staged','active','archived')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(document_id, cycle_id, source_line_start)
    );
    CREATE INDEX IF NOT EXISTS idx_diary_entries_date
      ON diary_entries(status, absolute_date, cycle_id, cycle_day_normalized);
    CREATE INDEX IF NOT EXISTS idx_diary_entries_document
      ON diary_entries(document_id, status, source_line_start);

    CREATE TABLE IF NOT EXISTS diary_chunks (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES diary_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      absolute_date TEXT,
      cycle_id INTEGER NOT NULL,
      cycle_day INTEGER NOT NULL,
      source_line_start INTEGER NOT NULL,
      source_line_end INTEGER NOT NULL,
      base_retrieval_weight REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'staged'
        CHECK(status IN ('staged','active','archived')),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entry_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_diary_chunks_document
      ON diary_chunks(document_id, status, absolute_date);

    CREATE VIRTUAL TABLE IF NOT EXISTS diary_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      content,
      absolute_date,
      cycle_label,
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS diary_chunks_ai AFTER INSERT ON diary_chunks BEGIN
      INSERT INTO diary_chunks_fts(chunk_id, content, absolute_date, cycle_label)
      VALUES (
        new.id,
        new.content,
        COALESCE(new.absolute_date, ''),
        'cycle-' || new.cycle_id || '-day-' || new.cycle_day
      );
    END;
    CREATE TRIGGER IF NOT EXISTS diary_chunks_ad AFTER DELETE ON diary_chunks BEGIN
      DELETE FROM diary_chunks_fts WHERE chunk_id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS diary_chunks_au AFTER UPDATE ON diary_chunks BEGIN
      DELETE FROM diary_chunks_fts WHERE chunk_id=old.id;
      INSERT INTO diary_chunks_fts(chunk_id, content, absolute_date, cycle_label)
      VALUES (
        new.id,
        new.content,
        COALESCE(new.absolute_date, ''),
        'cycle-' || new.cycle_id || '-day-' || new.cycle_day
      );
    END;

    CREATE TABLE IF NOT EXISTS diary_vector_jobs (
      chunk_id TEXT PRIMARY KEY REFERENCES diary_chunks(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_diary_vector_jobs_status
      ON diary_vector_jobs(status, updated_at);

    CREATE TABLE IF NOT EXISTS diary_memory_runs (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES diary_documents(id),
      mode TEXT NOT NULL DEFAULT 'shadow' CHECK(mode IN ('shadow','active')),
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed')),
      model TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS about_diary_memories (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES diary_documents(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES diary_memory_runs(id),
      memory_kind TEXT NOT NULL DEFAULT '关于日记的记忆',
      category TEXT NOT NULL CHECK(category IN ('life_event','theory_reflection','emotional_peak','long_term_pattern')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      temporal_scope TEXT NOT NULL DEFAULT 'moment' CHECK(temporal_scope IN ('moment','period','pattern')),
      date_start TEXT,
      date_end TEXT,
      emotional_valence REAL NOT NULL DEFAULT 0.0 CHECK(emotional_valence BETWEEN -1.0 AND 1.0),
      emotional_intensity REAL NOT NULL DEFAULT 0.0 CHECK(emotional_intensity BETWEEN 0.0 AND 1.0),
      trajectory_impact REAL NOT NULL DEFAULT 0.0 CHECK(trajectory_impact BETWEEN 0.0 AND 1.0),
      originality REAL NOT NULL DEFAULT 0.0 CHECK(originality BETWEEN 0.0 AND 1.0),
      recurrence REAL NOT NULL DEFAULT 0.0 CHECK(recurrence BETWEEN 0.0 AND 1.0),
      user_emphasis REAL NOT NULL DEFAULT 0.0 CHECK(user_emphasis BETWEEN 0.0 AND 1.0),
      importance_score REAL NOT NULL DEFAULT 0.0 CHECK(importance_score BETWEEN 0.0 AND 1.0),
      confidence REAL NOT NULL DEFAULT 0.8 CHECK(confidence BETWEEN 0.0 AND 1.0),
      themes_json TEXT NOT NULL DEFAULT '[]',
      source_quotes_json TEXT NOT NULL DEFAULT '[]',
      evidence_count INTEGER NOT NULL DEFAULT 1,
      extraction_model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'shadow' CHECK(status IN ('shadow','active','archived')),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(document_id, content_sha256, date_start, category)
    );
    CREATE INDEX IF NOT EXISTS idx_about_diary_memories_recall
      ON about_diary_memories(status, importance_score DESC, date_start);
    CREATE INDEX IF NOT EXISTS idx_about_diary_memories_category
      ON about_diary_memories(category, status, emotional_intensity DESC);

    CREATE TABLE IF NOT EXISTS diary_memory_sources (
      memory_id TEXT NOT NULL REFERENCES about_diary_memories(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
      chunk_id TEXT REFERENCES diary_chunks(id) ON DELETE SET NULL,
      source_quote TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'direct_evidence',
      PRIMARY KEY(memory_id, entry_id, source_quote)
    );
    CREATE INDEX IF NOT EXISTS idx_diary_memory_sources_entry ON diary_memory_sources(entry_id, memory_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS about_diary_memories_fts USING fts5(
      memory_id UNINDEXED,
      title,
      content,
      themes,
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS about_diary_memories_ai AFTER INSERT ON about_diary_memories BEGIN
      INSERT INTO about_diary_memories_fts(memory_id,title,content,themes)
      VALUES(new.id,new.title,new.content,new.themes_json);
    END;
    CREATE TRIGGER IF NOT EXISTS about_diary_memories_ad AFTER DELETE ON about_diary_memories BEGIN
      DELETE FROM about_diary_memories_fts WHERE memory_id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS about_diary_memories_au AFTER UPDATE ON about_diary_memories BEGIN
      DELETE FROM about_diary_memories_fts WHERE memory_id=old.id;
      INSERT INTO about_diary_memories_fts(memory_id,title,content,themes)
      VALUES(new.id,new.title,new.content,new.themes_json);
    END;

    CREATE TABLE IF NOT EXISTS diary_memory_vector_jobs (
      memory_id TEXT PRIMARY KEY REFERENCES about_diary_memories(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_diary_memory_vector_jobs_status
      ON diary_memory_vector_jobs(status, updated_at);

    CREATE TABLE IF NOT EXISTS diary_memory_extraction_jobs (
      entry_id TEXT PRIMARY KEY REFERENCES diary_entries(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES diary_documents(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      memory_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_diary_memory_extraction_jobs_status
      ON diary_memory_extraction_jobs(document_id,status,updated_at);

    INSERT OR IGNORE INTO schema_version(version, name) VALUES (1, 'clean B-GPE memory runtime');
    INSERT OR IGNORE INTO schema_version(version, name) VALUES (2, 'Hermes turn sync and Chroma vector queue');
    INSERT OR IGNORE INTO schema_version(version, name) VALUES (4, 'persistent media asset library');
    INSERT OR IGNORE INTO schema_version(version, name) VALUES (5, 'time-anchored diary archive and retrieval');
    INSERT OR IGNORE INTO schema_version(version, name) VALUES (6, '关于日记的记忆: autobiographical recall, emotional peaks, and provenance');
    INSERT OR IGNORE INTO schema_version(version, name) VALUES (7, 'typed asset documents and sourced personal theory memory');
  `);

  const correctionColumns = db.prepare('PRAGMA table_info(corrections)').all().map((column) => column.name);
  if (!correctionColumns.includes('reason')) {
    db.exec("ALTER TABLE corrections ADD COLUMN reason TEXT NOT NULL DEFAULT ''");
  }

  const fragmentColumns = db.prepare('PRAGMA table_info(memory_fragments)').all().map((column) => column.name);
  if (!fragmentColumns.includes('write_state')) {
    db.exec("ALTER TABLE memory_fragments ADD COLUMN write_state TEXT NOT NULL DEFAULT 'active' CHECK(write_state IN ('active','observed'))");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fragments_write_state
      ON memory_fragments(write_state, status, created_at);
    INSERT OR IGNORE INTO schema_version(version, name)
      VALUES (3, 'confidence-gated fragment write permissions');
  `);

  return db;
}

module.exports = { initializeDatabase };

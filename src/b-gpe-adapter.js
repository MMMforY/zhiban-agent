const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const SECTION_SOURCES = [
  {
    key: 'identity.core',
    type: 'identity_anchor',
    authority: 'core',
    path: 'dist/generic-system-prompt.md'
  },
  {
    key: 'user.curated',
    type: 'user_model',
    authority: 'curated',
    path: 'dist/generic-user-context.md'
  },
  {
    key: 'memory.semantic',
    type: 'user_model',
    authority: 'curated',
    path: 'memory/semantic.md'
  },
  {
    key: 'memory.relationship',
    type: 'relationship_model',
    authority: 'curated',
    path: 'memory/relationship-memory.md'
  }
];

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function readBlueprint(root) {
  const manifestPath = path.join(root, 'manifest.yaml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`B-GPE manifest not found: ${manifestPath}`);
  }
  const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8'));
  const continuityId = manifest?.agent?.continuity_id;
  const version = manifest?.blueprint?.version || manifest?.agent?.current_version;
  if (!continuityId || !version) {
    throw new Error('B-GPE manifest is missing continuity_id or version');
  }
  const sections = SECTION_SOURCES.map((definition) => {
    const absolutePath = path.join(root, definition.path);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`B-GPE runtime source not found: ${absolutePath}`);
    }
    const content = fs.readFileSync(absolutePath, 'utf8').trim();
    return { ...definition, content, contentHash: sha256(content) };
  });
  return {
    manifest,
    continuityId,
    version,
    name: manifest?.agent?.name || 'Companion',
    sections
  };
}

function syncBlueprint(db, root) {
  const blueprint = readBlueprint(root);
  const selectActive = db.prepare(`
    SELECT * FROM persona_sections
    WHERE continuity_id=? AND section_key=? AND status='active'
  `);
  const supersede = db.prepare(`
    UPDATE persona_sections SET status='superseded', updated_at=CURRENT_TIMESTAMP WHERE id=?
  `);
  const insert = db.prepare(`
    INSERT INTO persona_sections (
      continuity_id, section_key, section_type, content, content_hash,
      authority, source_path, source_version, confidence, supersedes_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?)
  `);

  const changed = [];
  db.transaction(() => {
    for (const section of blueprint.sections) {
      const existing = selectActive.get(blueprint.continuityId, section.key);
      if (existing?.content_hash === section.contentHash) continue;
      if (existing) supersede.run(existing.id);
      insert.run(
        blueprint.continuityId,
        section.key,
        section.type,
        section.content,
        section.contentHash,
        section.authority,
        section.path,
        blueprint.version,
        existing?.id || null
      );
      changed.push(section.key);
    }
    db.prepare(`
      INSERT INTO runtime_meta(key, value, updated_at) VALUES('b_gpe_version', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
    `).run(blueprint.version);
    db.prepare(`
      INSERT INTO runtime_meta(key, value, updated_at) VALUES('continuity_id', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
    `).run(blueprint.continuityId);
  })();

  return {
    continuityId: blueprint.continuityId,
    version: blueprint.version,
    companionName: blueprint.name,
    changed
  };
}

function getActivePersona(db, continuityId) {
  const sections = db.prepare(`
    SELECT id, section_key, section_type, content, authority, source_path,
           source_version, confidence, evidence_count, updated_at
    FROM persona_sections
    WHERE continuity_id=? AND status='active'
    ORDER BY CASE authority WHEN 'core' THEN 0 WHEN 'curated' THEN 1 ELSE 2 END, id
  `).all(continuityId);
  return sections;
}

function assemblePersona(sections) {
  return sections.map((section) => {
    const heading = section.section_key === 'identity.core'
      ? 'Core identity'
      : section.section_key;
    return `## ${heading}\n\n${section.content}`;
  }).join('\n\n');
}

module.exports = {
  SECTION_SOURCES,
  readBlueprint,
  syncBlueprint,
  getActivePersona,
  assemblePersona
};

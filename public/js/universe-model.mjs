const layerDefinitions = [
  { id: 'conversation', label: '普通对话记忆', unit: '条', status: 'active', mode: 'constellation' },
  { id: 'diary', label: '关于日记的记忆', unit: '条', status: 'pending', mode: 'entry' },
  { id: 'theory', label: '个人理论', unit: '张', status: 'pending', mode: 'entry' },
  { id: 'assets', label: '素材库', unit: '项', status: 'pending', mode: 'entry' },
  { id: 'observed', label: '隔离观察', unit: '条', status: 'quarantined', mode: 'summary' }
];

function optionalCount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeLayer(definition, supplied = {}) {
  const allowedStatuses = new Set(['active', 'available', 'pending', 'quarantined']);
  const status = allowedStatuses.has(supplied.status) ? supplied.status : definition.status;
  return Object.freeze({
    ...definition,
    label: typeof supplied.label === 'string' && supplied.label.trim() ? supplied.label.trim() : definition.label,
    unit: typeof supplied.unit === 'string' && supplied.unit.trim() ? supplied.unit.trim() : definition.unit,
    count: optionalCount(supplied.count),
    status,
    mode: typeof supplied.mode === 'string' && supplied.mode.trim() ? supplied.mode.trim() : definition.mode
  });
}

export function createUniversePresentation(universe = {}) {
  const totals = objectOrEmpty(universe.totals);
  const overview = objectOrEmpty(universe.overview);
  const suppliedLayers = Array.isArray(overview.layers) ? overview.layers : [];
  const suppliedById = new Map(
    suppliedLayers
      .filter((layer) => layer && typeof layer.id === 'string')
      .map((layer) => [layer.id, layer])
  );
  const layers = layerDefinitions.map((definition) => normalizeLayer(definition, suppliedById.get(definition.id)));
  const coverageInput = objectOrEmpty(overview.coverage);
  const coverage = Object.freeze({
    totalActive: optionalCount(coverageInput.totalActive),
    visualizedUnique: optionalCount(coverageInput.visualizedUnique),
    entityLinks: optionalCount(coverageInput.entityLinks) ?? optionalCount(totals.fragments),
    completeness: coverageInput.completeness === 'complete' ? 'complete' : 'partial'
  });
  const conversation = layers.find((layer) => layer.id === 'conversation');
  const conversationDisplay = conversation.count === null
    ? Object.freeze({ count: coverage.entityLinks, unit: '关联', note: '实体关联，非记忆总数' })
    : Object.freeze({
        count: conversation.count,
        unit: conversation.unit,
        note: coverage.visualizedUnique === null
          ? '星图只显示有实体关联的部分'
          : `${coverage.visualizedUnique} 条已显示`
      });

  return Object.freeze({
    layers,
    coverage,
    conversationDisplay,
    metrics: Object.freeze({
      entities: optionalCount(totals.entities),
      entityLinks: coverage.entityLinks,
      episodes: optionalCount(totals.episodes)
    })
  });
}

export function coverageMessage(presentation) {
  const { coverage } = presentation;
  if (coverage.totalActive !== null && coverage.visualizedUnique !== null) {
    const state = coverage.completeness === 'complete' ? '已完整显示' : '当前显示';
    const entityLinks = coverage.entityLinks === null ? '' : ` · ${coverage.entityLinks} 个实体关联`;
    return `${state} ${coverage.visualizedUnique} / ${coverage.totalActive} 条普通对话记忆${entityLinks}`;
  }
  if (coverage.totalActive !== null) {
    return `普通对话记忆共 ${coverage.totalActive} 条；星图只显示其中具有实体关联的部分。`;
  }
  return '当前仅展示 active 普通对话记忆的实体关联；不代表日记、理论、素材和隔离观察层。';
}

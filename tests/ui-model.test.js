const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

async function loadModel() {
  const modulePath = path.resolve(__dirname, '../public/js/universe-model.mjs');
  return import(pathToFileURL(modulePath).href);
}

test('legacy universe data is presented as entity links rather than a complete memory count', async () => {
  const { createUniversePresentation, coverageMessage } = await loadModel();
  const presentation = createUniversePresentation({
    totals: { entities: 34, fragments: 98, episodes: 7 }
  });

  assert.equal(presentation.layers.length, 5);
  assert.equal(presentation.conversationDisplay.count, 98);
  assert.equal(presentation.conversationDisplay.unit, '关联');
  assert.equal(presentation.layers.find((layer) => layer.id === 'diary').count, null);
  assert.equal(presentation.layers.find((layer) => layer.id === 'observed').status, 'quarantined');
  assert.match(coverageMessage(presentation), /不代表日记、理论、素材和隔离观察层/);
});

test('optional overview contract reports memory-layer counts and unique coverage without changing the canvas payload', async () => {
  const { createUniversePresentation, coverageMessage } = await loadModel();
  const presentation = createUniversePresentation({
    totals: { entities: 34, fragments: 98, episodes: 7 },
    overview: {
      layers: [
        { id: 'conversation', count: 64, status: 'active' },
        { id: 'diary', count: 2319, status: 'available' },
        { id: 'theory', count: 10, status: 'available' },
        { id: 'assets', count: 42, status: 'available' },
        { id: 'observed', count: 251, status: 'quarantined' }
      ],
      coverage: {
        totalActive: 64,
        visualizedUnique: 49,
        entityLinks: 98,
        completeness: 'partial'
      }
    }
  });

  assert.equal(presentation.conversationDisplay.count, 64);
  assert.equal(presentation.conversationDisplay.note, '49 条已显示');
  assert.equal(presentation.layers.find((layer) => layer.id === 'diary').count, 2319);
  assert.equal(presentation.layers.find((layer) => layer.id === 'observed').count, 251);
  assert.equal(presentation.metrics.entityLinks, 98);
  assert.equal(
    coverageMessage(presentation),
    '当前显示 49 / 64 条普通对话记忆 · 98 个实体关联'
  );
});

test('null, undefined, and blank counts remain unknown while explicit zero remains zero', async () => {
  const { createUniversePresentation } = await loadModel();
  const unknown = createUniversePresentation({
    totals: { entities: '', fragments: null },
    overview: {
      layers: [
        { id: 'conversation', count: '   ' },
        { id: 'diary', count: null },
        { id: 'theory', count: undefined }
      ],
      coverage: { totalActive: null, visualizedUnique: '', entityLinks: null }
    }
  });

  assert.equal(unknown.layers.find((layer) => layer.id === 'conversation').count, null);
  assert.equal(unknown.layers.find((layer) => layer.id === 'diary').count, null);
  assert.equal(unknown.layers.find((layer) => layer.id === 'theory').count, null);
  assert.equal(unknown.conversationDisplay.count, null);
  assert.deepEqual(unknown.metrics, { entities: null, entityLinks: null, episodes: null });

  const empty = createUniversePresentation({
    totals: { entities: 0, fragments: '0', episodes: 0 },
    overview: { layers: [{ id: 'conversation', count: '0' }] }
  });
  assert.equal(empty.layers.find((layer) => layer.id === 'conversation').count, 0);
  assert.deepEqual(empty.metrics, { entities: 0, entityLinks: 0, episodes: 0 });
});

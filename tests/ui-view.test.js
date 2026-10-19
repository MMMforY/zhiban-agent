const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

async function loadView() {
  const modulePath = path.resolve(__dirname, '../public/js/constellation-view.mjs');
  return import(pathToFileURL(modulePath).href);
}

function createHarness({ reducedMotion = false } = {}) {
  let nextFrame = 1;
  const frames = new Map();
  const hostListeners = new Map();
  const documentListeners = new Map();
  const motionListeners = new Map();
  const context = {
    arc() {},
    beginPath() {},
    clearRect() {},
    createRadialGradient() { return { addColorStop() {} }; },
    fill() {},
    fillRect() {},
    fillText() {},
    lineTo() {},
    moveTo() {},
    restore() {},
    save() {},
    setTransform() {},
    stroke() {}
  };
  const canvasListeners = new Map();
  const canvas = {
    clientHeight: 600,
    clientWidth: 800,
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    style: {},
    addEventListener: (type, listener) => canvasListeners.set(type, listener),
    removeEventListener: (type) => canvasListeners.delete(type)
  };
  const motionQuery = {
    matches: reducedMotion,
    addEventListener: (type, listener) => motionListeners.set(type, listener),
    removeEventListener: (type) => motionListeners.delete(type)
  };
  const host = {
    devicePixelRatio: 1,
    matchMedia: () => motionQuery,
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    addEventListener: (type, listener) => hostListeners.set(type, listener),
    removeEventListener: (type) => hostListeners.delete(type)
  };
  const documentRef = {
    visibilityState: 'visible',
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    removeEventListener: (type) => documentListeners.delete(type)
  };

  return { canvas, documentListeners, documentRef, frames, host, hostListeners, motionListeners, motionQuery };
}

function populatedUniverse() {
  return {
    core: [{ id: 'user', name: 'User' }],
    constellations: [{
      id: 'entity-1',
      label: 'Project',
      category: 'project',
      fragmentCount: 1,
      stars: [{}],
      episodes: []
    }]
  };
}

test('constellation animation runs only while populated data is visible', async () => {
  const { createConstellationView } = await loadView();
  const harness = createHarness();
  const view = createConstellationView({
    canvas: harness.canvas,
    host: harness.host,
    documentRef: harness.documentRef
  });

  assert.equal(harness.frames.size, 0, 'initial empty view must remain static');
  view.setUniverse({ core: [], constellations: [] });
  assert.equal(harness.frames.size, 0, 'empty universe must remain static');

  view.setUniverse(populatedUniverse());
  assert.equal(harness.frames.size, 1, 'populated universe should animate while visible');

  harness.documentRef.visibilityState = 'hidden';
  harness.documentListeners.get('visibilitychange')();
  assert.equal(harness.frames.size, 0, 'background tab must cancel its pending frame');

  harness.documentRef.visibilityState = 'visible';
  harness.documentListeners.get('visibilitychange')();
  assert.equal(harness.frames.size, 1, 'visible populated tab should resume animation');

  view.clear();
  assert.equal(harness.frames.size, 0, 'cleared view must stop animation');
  view.destroy();
  assert.equal(harness.documentListeners.size, 0);
  assert.equal(harness.hostListeners.size, 0);
  assert.equal(harness.motionListeners.size, 0);
});

test('reduced-motion mode renders populated data without scheduling animation frames', async () => {
  const { createConstellationView } = await loadView();
  const harness = createHarness({ reducedMotion: true });
  const view = createConstellationView({
    canvas: harness.canvas,
    host: harness.host,
    documentRef: harness.documentRef
  });

  view.setUniverse(populatedUniverse());
  assert.equal(harness.frames.size, 0);

  harness.motionQuery.matches = false;
  harness.motionListeners.get('change')({ matches: false });
  assert.equal(harness.frames.size, 1, 'disabling reduced motion should start animation');

  harness.motionQuery.matches = true;
  harness.motionListeners.get('change')({ matches: true });
  assert.equal(harness.frames.size, 0, 'enabling reduced motion should cancel animation');
  view.destroy();
});

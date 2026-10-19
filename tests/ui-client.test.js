const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

async function loadClientModule() {
  const modulePath = path.resolve(__dirname, '../public/js/memory-api.mjs');
  return import(pathToFileURL(modulePath).href);
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

test('browser memory client keeps the token in its closure and sends it only to protected requests', async () => {
  const calls = [];
  const { createMemoryApi } = await loadClientModule();
  const api = createMemoryApi({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, url === '/health' ? { ok: true } : { constellations: [], core: [], totals: {} });
    }
  });

  api.setAccessToken('  private-token  ');
  await api.health();
  await api.universe();

  assert.equal(calls[0].url, '/health');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].url, '/api/v1/universe');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-token');
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(api.hasAccessToken(), true);

  api.clearAccessToken();
  assert.equal(api.hasAccessToken(), false);
});

test('browser memory client exposes a typed unauthorized error without persisting credentials', async () => {
  const { createMemoryApi, MemoryApiError } = await loadClientModule();
  const api = createMemoryApi({
    fetchImpl: async () => response(401, { error: 'unauthorized' })
  });

  await assert.rejects(
    api.universe(),
    (error) => error instanceof MemoryApiError && error.status === 401 && error.code === 'unauthorized'
  );
});

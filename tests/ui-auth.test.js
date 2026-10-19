const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRuntime } = require('../src/server');

function protectedConfig(assetPath) {
  return {
    databasePath: ':memory:',
    assetStoragePath: assetPath,
    assetMaxBytes: 1024,
    bGpeRoot: path.resolve(__dirname, '../blueprint'),
    authToken: 'ui-test-token',
    autoStartScheduler: false,
    userDisplayName: 'User',
    companionDisplayName: '知伴',
    llm: { baseUrl: '', apiKey: '', model: '' },
    embedding: { baseUrl: '', apiKey: '', model: '', dimensions: 0 },
    chroma: { enabled: false, url: '' },
    assetChroma: { enabled: false, url: '' }
  };
}

test('protected star map keeps UI public and requires bearer authorization for memory data', async (t) => {
  const assetPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-aa-ui-auth-assets-'));
  const runtime = createRuntime({ config: protectedConfig(assetPath) });
  const server = await new Promise((resolve) => {
    const instance = runtime.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    runtime.scheduler.stop();
    await new Promise((resolve) => server.close(resolve));
    runtime.db.close();
    fs.rmSync(assetPath, { recursive: true, force: true });
  });

  const page = await fetch(`${baseUrl}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /id="star-map"/);
  assert.match(html, /当前视图 · 普通对话记忆/);
  assert.match(html, /id="memory-layers"/);
  assert.match(html, /id="connection-dialog"/);
  assert.match(html, /并非只读 UI 凭证/);
  assert.match(html, /type="module" src="\/app\.js"/);

  const unauthorized = await fetch(`${baseUrl}/api/v1/universe`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/api/v1/universe`, {
    headers: { Authorization: 'Bearer ui-test-token' }
  });
  assert.equal(authorized.status, 200);
  assert.ok(Array.isArray((await authorized.json()).constellations));
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLlmClient } = require('../src/llm');
const { createRuntime } = require('../src/server');

test('unconfigured model stays disabled and non-loopback startup is rejected', () => {
  assert.equal(createLlmClient({}).enabled, false);
  assert.equal(createLlmClient({ baseUrl: 'http://localhost', model: 'test' }).enabled, false);
  assert.throws(() => createRuntime({ config: { host: '0.0.0.0' } }), /loopback/);
});

test('public runtime sends synthetic credentials only to the chosen model and serves no configuration files', async (t) => {
  const fakeKey = require('node:crypto').randomUUID();
  let receivedAuth;
  const upstream = http.createServer((req, res) => {
    receivedAuth = req.headers.authorization;
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic integration reply.' } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiban-public-'));
  const runtime = createRuntime({ config: {
    databasePath: ':memory:', assetStoragePath: temp, diaryStoragePath: temp,
    bGpeRoot: path.resolve(__dirname, '../blueprint'), autoStartScheduler: false,
    llm: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'synthetic', apiKey: fakeKey },
    chroma: { enabled: false }, assetChroma: { enabled: false }, assetDocumentChroma: { enabled: false },
    diaryChroma: { enabled: false }, diaryMemoryChroma: { enabled: false }
  } });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    runtime.scheduler.stop();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    runtime.db.close(); fs.rmSync(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/v1/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Synthetic test request.' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reply, 'Synthetic integration reply.');
  assert.equal(receivedAuth, `Bearer ${fakeKey}`);
  assert.ok(!JSON.stringify(body).includes(fakeKey));
  for (const route of ['/health', '/chat.html', '/chat.js', '/.env', '/src/config.js']) {
    const text = await (await fetch(base + route)).text();
    assert.ok(!text.includes(fakeKey));
    assert.ok(!text.includes('process.env.LLM_API_KEY'));
  }
});

test('self-configured local endpoint works without a key only when explicitly enabled; upstream body is not leaked', async (t) => {
  let requestHeaders;
  let fail = false;
  const server = http.createServer((req, res) => {
    requestHeaders = req.headers;
    req.resume();
    if (fail) { res.writeHead(401); return res.end('sensitive upstream error details'); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'A synthetic reply.' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createLlmClient({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', allowNoKey: true });
  assert.equal(await client.complete([{ role: 'user', content: 'synthetic input' }]), 'A synthetic reply.');
  assert.equal(requestHeaders.authorization, undefined);
  fail = true;
  await assert.rejects(client.complete([]), error => error.message === 'LLM request failed (401)');
});

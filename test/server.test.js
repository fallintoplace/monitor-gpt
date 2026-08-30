const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { LocalMemory } = require('../lib/memory');
const { createLocalServer, listen } = require('../lib/server');
const { MonitorRunner } = require('../lib/runner');
const { DEFAULT_SETTINGS } = require('../lib/config');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}) };
    if (options.token) headers['x-monitor-token'] = options.token;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

test('should serve state and accept a non-blocking analyze request', async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gpt-server-'));
  const memory = new LocalMemory(dataDirectory);
  const runner = new MonitorRunner({
    dataDirectory,
    settings: { ...DEFAULT_SETTINGS, sourceDisplayNumber: 1 },
    memory,
    capture: async () => ({ buffer: Buffer.from('image') }),
    requestOpenAI: async () => ({ text: 'done' })
  });
  runner.setDisplays([{ id: '1', captureNumber: 1, label: 'Main display', width: 10, height: 10 }]);
  const server = createLocalServer({ runner, memory, publicDirectory: path.join(__dirname, '..', 'public'), authToken: 'test-token' });
  const port = await listen(server, 0);
  const unauthorized = await request(port, '/api/state');
  assert.equal(unauthorized.status, 401);
  const state = await request(port, '/api/state', { token: 'test-token' });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).settings.model, 'gpt-5.6-luna');
  const result = await request(port, '/result');
  assert.equal(result.status, 200);
  assert.match(result.body, /Monitor GPT · Result/);
  const previousResult = await request(port, '/result?view=previous');
  assert.equal(previousResult.status, 200);
  const voice = await request(port, '/voice');
  assert.equal(voice.status, 200);
  assert.match(voice.body, /Monitor GPT · Voice/);
  const voiceMemory = await request(port, '/voice?view=memory');
  assert.equal(voiceMemory.status, 200);
  assert.match(voiceMemory.body, /voice\.js/);
  const combined = await request(port, '/voice?view=combined');
  assert.equal(combined.status, 200);
  assert.match(combined.body, /voice\.js/);
  const accepted = await request(port, '/api/analyze', { method: 'POST', body: {}, token: 'test-token' });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 15));
  server.close();
});

test('should refresh the display list before returning it', async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gpt-server-'));
  const memory = new LocalMemory(dataDirectory);
  let displays = [{ id: 'display-1', captureNumber: 1, label: 'Main display', width: 10, height: 10 }];
  const runner = new MonitorRunner({
    dataDirectory,
    settings: { ...DEFAULT_SETTINGS, sourceDisplayNumber: 1 },
    memory,
    getDisplays: () => displays,
    capture: async () => ({ buffer: Buffer.from('image') }),
    requestOpenAI: async () => ({ text: 'done' })
  });
  runner.setDisplays(displays);
  const server = createLocalServer({ runner, memory, publicDirectory: path.join(__dirname, '..', 'public'), authToken: 'test-token' });
  const port = await listen(server, 0);
  displays = [{ id: 'display-2', captureNumber: 1, label: 'External display 1', width: 20, height: 10 }];

  const response = await request(port, '/api/displays', { token: 'test-token' });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.displays, displays);
  assert.equal(body.settings.sourceDisplayId, 'display-1');
  server.close();
});

test('should report a conflict when an analysis is already running', async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gpt-server-'));
  const memory = new LocalMemory(dataDirectory);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const runner = new MonitorRunner({
    dataDirectory,
    settings: { ...DEFAULT_SETTINGS, sourceDisplayNumber: 1 },
    memory,
    capture: async () => ({ buffer: Buffer.from('image') }),
    requestOpenAI: async () => pending
  });
  runner.setDisplays([{ id: 'display-1', captureNumber: 1, label: 'Main display', width: 10, height: 10 }]);
  const server = createLocalServer({ runner, memory, publicDirectory: path.join(__dirname, '..', 'public'), authToken: 'test-token' });
  const port = await listen(server, 0);

  const first = await request(port, '/api/analyze', { method: 'POST', body: {}, token: 'test-token' });
  const second = await request(port, '/api/analyze', { method: 'POST', body: {}, token: 'test-token' });
  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  assert.deepEqual(JSON.parse(second.body), { accepted: false, reason: 'already-running' });
  release({ text: 'done' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  server.close();
});

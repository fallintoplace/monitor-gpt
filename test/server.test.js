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
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : {}
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
  const server = createLocalServer({ runner, memory, publicDirectory: path.join(__dirname, '..', 'public') });
  const port = await listen(server, 0);
  const state = await request(port, '/api/state');
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).settings.model, 'gpt-5.6-luna');
  const result = await request(port, '/result');
  assert.equal(result.status, 200);
  assert.match(result.body, /Monitor GPT · Result/);
  const accepted = await request(port, '/api/analyze', { method: 'POST', body: {} });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 15));
  server.close();
});

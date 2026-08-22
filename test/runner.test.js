const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_SETTINGS } = require('../lib/config');
const { LocalMemory } = require('../lib/memory');
const { MonitorRunner } = require('../lib/runner');

function makeRunner(options = {}) {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gpt-runner-'));
  const memory = new LocalMemory(dataDirectory, { maxEntries: 30 });
  let calls = 0;
  const runner = new MonitorRunner({
    dataDirectory,
    settings: { ...DEFAULT_SETTINGS, sourceDisplayNumber: 1, skipUnchanged: true },
    memory,
    capture: async () => ({ buffer: Buffer.from(options.image || 'same image') }),
    logger: { error: () => {} },
    requestOpenAI: async ({ payload }) => {
      calls += 1;
      if (options.requestOpenAI) return options.requestOpenAI({ payload, call: calls });
      return { text: options.answer || 'answer' };
    }
  });
  runner.setDisplays([
    { id: 'display-1', captureNumber: 1, label: 'Main display', width: 100, height: 100 },
    { id: 'display-2', captureNumber: 2, label: 'External display 1', width: 100, height: 100 }
  ]);
  return { runner, memory, getCalls: () => calls };
}

test('should publish capturing state before the API call', async () => {
  const { runner } = makeRunner();
  const states = [];
  runner.subscribe((state) => states.push(state.status));
  await runner.triggerAnalysis({ reason: 'test' });
  assert.ok(states.includes('capturing'));
  assert.ok(states.includes('analyzing'));
  assert.equal(states.at(-1), 'ready');
});

test('should skip an identical image when the analysis inputs are unchanged', async () => {
  const { runner, getCalls } = makeRunner();
  await runner.triggerAnalysis();
  await runner.triggerAnalysis();
  assert.equal(getCalls(), 1);
  assert.equal(runner.snapshot().result, 'answer');
});

test('should analyze again when the prompt changes even if the image is identical', async () => {
  const { runner, getCalls } = makeRunner();
  await runner.triggerAnalysis();
  runner.updateSettings({ prompt: 'A different question' });
  await runner.triggerAnalysis();
  assert.equal(getCalls(), 2);
});

test('should retry the same image after an API failure', async () => {
  let failures = 1;
  const { runner, getCalls } = makeRunner({
    requestOpenAI: async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('temporary failure');
      }
      return { text: 'recovered' };
    }
  });

  const first = await runner.triggerAnalysis();
  const second = await runner.triggerAnalysis();

  assert.match(first.error, /temporary failure/);
  assert.equal(second.answer, 'recovered');
  assert.equal(getCalls(), 2);
  assert.equal(runner.snapshot().result, 'recovered');
});

test('should analyze again when a one-off prompt override changes', async () => {
  const { runner, getCalls } = makeRunner();
  await runner.triggerAnalysis({ promptOverride: 'first question' });
  await runner.triggerAnalysis({ promptOverride: 'second question' });
  assert.equal(getCalls(), 2);
});

test('should fall back to a real display when a persisted display is missing', () => {
  const { runner } = makeRunner();
  runner.updateSettings({ sourceDisplayNumber: 99, resultDisplayId: 'missing' });
  runner.setDisplays([{ id: 'real-display', captureNumber: 1, label: 'Main display', width: 10, height: 10 }]);
  assert.equal(runner.snapshot().settings.sourceDisplayNumber, 1);
  assert.equal(runner.snapshot().settings.resultDisplayId, 'real-display');
});

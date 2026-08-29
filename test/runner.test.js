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
    requestOpenAI: async ({ payload, channel }) => {
      calls += 1;
      if (options.requestOpenAI) return options.requestOpenAI({ payload, channel, call: calls });
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

test('should route a completed voice transcript to a text-only answer', async () => {
  let voicePayload;
  const { runner } = makeRunner({
    requestOpenAI: async ({ payload, channel }) => {
      if (channel === 'voice') {
        voicePayload = payload;
        return { text: 'A mutex lets one thread enter a critical section at a time.' };
      }
      return { text: 'screen answer' };
    }
  });
  const voiceSession = {
    start: async () => ({ connected: true }),
    stop: () => {},
    sendAudio: () => true
  };
  runner.setApiKeyReady(true);
  runner.setVoiceSession(voiceSession);
  await runner.startVoice();
  runner.handleVoiceEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'voice-item-1',
    transcript: 'What is a mutex?'
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(runner.snapshot().voice.answer, 'A mutex lets one thread enter a critical section at a time.');
  assert.equal(runner.snapshot().voice.transcript, 'What is a mutex?');
  assert.equal(voicePayload.input[0].content.some((part) => part.type === 'input_image'), false);
  assert.match(voicePayload.input[0].content[0].text, /What is a mutex/);
});

test('should choose a third display for voice answers when it is available', () => {
  const { runner } = makeRunner();
  runner.setDisplays([
    { id: 'display-1', captureNumber: 1, label: 'Main display', width: 100, height: 100 },
    { id: 'display-2', captureNumber: 2, label: 'External display 1', width: 100, height: 100 },
    { id: 'display-3', captureNumber: 3, label: 'External display 2', width: 100, height: 100 }
  ]);
  runner.updateSettings({ sourceDisplayNumber: 3, resultDisplayId: 'display-2' });
  runner.setDisplays(runner.snapshot().displays);
  assert.equal(runner.snapshot().voiceResultDisplay.id, 'display-1');
});

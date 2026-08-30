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
    settings: { ...DEFAULT_SETTINGS, sourceDisplayNumber: 1, skipUnchanged: true, voiceScreenContextEnabled: false },
    memory,
    capture: options.capture || (async () => ({ buffer: Buffer.from(options.image || 'same image') })),
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

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
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

test('should analyze again when the screen answer language changes', async () => {
  const { runner, getCalls } = makeRunner();
  await runner.triggerAnalysis();
  runner.updateSettings({ screenAnswerLanguage: 'Spanish' });
  await runner.triggerAnalysis();
  assert.equal(getCalls(), 2);
});

test('should invalidate the unchanged-image cache when memory is cleared', async () => {
  const { runner, getCalls } = makeRunner();
  await runner.triggerAnalysis();
  runner.clearMemory();
  await runner.triggerAnalysis();
  assert.equal(getCalls(), 2);
  assert.equal(runner.snapshot().result, 'answer');
});

test('should invalidate the unchanged-image cache when the latest analysis is deleted', async () => {
  const { runner, getCalls } = makeRunner();
  await runner.triggerAnalysis();
  const id = runner.snapshot().resultHistory.at(-1).id;
  assert.equal(runner.deleteMemoryEntry(id), true);
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

test('should keep completed screen answers in chronological history', async () => {
  let answerNumber = 0;
  const { runner } = makeRunner({
    requestOpenAI: async () => ({ text: `answer ${++answerNumber}` })
  });

  await runner.triggerAnalysis({ promptOverride: 'first question' });
  await runner.triggerAnalysis({ promptOverride: 'second question' });

  assert.equal(runner.snapshot().result, 'answer 2');
  assert.deepEqual(runner.snapshot().resultHistory.map((entry) => entry.answer), ['answer 1', 'answer 2']);
});

test('should fall back to a real display when a persisted display is missing', () => {
  const { runner } = makeRunner();
  runner.updateSettings({ sourceDisplayNumber: 99, resultDisplayId: 'missing' });
  runner.setDisplays([{ id: 'real-display', captureNumber: 1, label: 'Main display', width: 10, height: 10 }]);
  assert.equal(runner.snapshot().settings.sourceDisplayNumber, 1);
  assert.equal(runner.snapshot().settings.resultDisplayId, 'real-display');
});

test('should preserve a missing stable source display until it returns', () => {
  const { runner } = makeRunner();
  runner.updateSettings({ sourceDisplayId: 'display-2' });
  runner.setDisplays([
    { id: 'display-1', captureNumber: 1, label: 'Main display', width: 100, height: 100 },
    { id: 'display-3', captureNumber: 2, label: 'External display 2', width: 100, height: 100 }
  ]);

  assert.equal(runner.snapshot().sourceDisplay, null);
  assert.equal(runner.snapshot().settings.sourceDisplayId, 'display-2');
  assert.equal(runner.snapshot().settings.sourceDisplayNumber, 2);

  runner.setDisplays([
    { id: 'display-1', captureNumber: 1, label: 'Main display', width: 100, height: 100 },
    { id: 'display-3', captureNumber: 2, label: 'External display 2', width: 100, height: 100 },
    { id: 'display-2', captureNumber: 3, label: 'External display 1', width: 100, height: 100 }
  ]);

  assert.equal(runner.snapshot().sourceDisplay.id, 'display-2');
  assert.equal(runner.snapshot().settings.sourceDisplayNumber, 3);
});

test('should keep the selected source display by stable id when display order changes', async () => {
  let captured;
  const { runner } = makeRunner({
    capture: async (options) => {
      captured = options;
      return { buffer: Buffer.from('different image') };
    }
  });
  runner.updateSettings({ sourceDisplayId: 'display-2' });
  runner.setDisplays([
    { id: 'display-2', captureNumber: 1, label: 'External display 1', width: 100, height: 100 },
    { id: 'display-1', captureNumber: 2, label: 'Main display', width: 100, height: 100 }
  ]);
  await runner.triggerAnalysis();
  assert.equal(runner.snapshot().sourceDisplay.id, 'display-2');
  assert.equal(captured.displayId, 'display-2');
  assert.equal(captured.displayNumber, 1);
});

test('should convert legacy display numbers to stable display ids', () => {
  const { runner } = makeRunner();
  runner.updateSettings({ resultDisplayId: '2', voiceResultDisplayId: '1', previousResultDisplayId: '2' });

  runner.setDisplays([
    { id: 'stable-main', captureNumber: 1, label: 'Main display', width: 100, height: 100 },
    { id: 'stable-external', captureNumber: 2, label: 'External display 1', width: 100, height: 100 }
  ]);

  assert.equal(runner.snapshot().settings.resultDisplayId, 'stable-external');
  assert.equal(runner.snapshot().settings.voiceResultDisplayId, 'stable-main');
  assert.equal(runner.snapshot().settings.previousResultDisplayId, 'stable-external');
});

test('should keep a missing stable source display unavailable during refresh', () => {
  let displays = [
    { id: 'display-1', captureNumber: 1, label: 'Main display', width: 100, height: 100 }
  ];
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gpt-runner-'));
  const memory = new LocalMemory(dataDirectory, { maxEntries: 30 });
  const runner = new MonitorRunner({
    dataDirectory,
    settings: { ...DEFAULT_SETTINGS, sourceDisplayNumber: 1 },
    memory,
    getDisplays: () => displays,
    capture: async () => ({ buffer: Buffer.from('image') }),
    requestOpenAI: async () => ({ text: 'answer' })
  });
  runner.setDisplays(displays);
  displays = [
    { id: 'display-2', captureNumber: 1, label: 'External display 1', width: 200, height: 100 }
  ];
  assert.deepEqual(runner.refreshDisplays(), displays);
  assert.equal(runner.snapshot().sourceDisplay, null);
  assert.equal(runner.snapshot().settings.sourceDisplayId, 'display-1');
});

test('should enable screen hotkeys only for hotkey trigger modes', () => {
  const { runner } = makeRunner();

  for (const [mode, enabled] of [
    ['click', false],
    ['hotkeys', true],
    ['click-hotkeys', true],
    ['auto', false]
  ]) {
    runner.updateSettings({ triggerMode: mode });
    assert.equal(runner.screenHotkeysEnabled(), enabled, `trigger mode ${mode}`);
  }
});

test('should route a completed voice transcript to a text-only answer', async () => {
  let voicePayload;
  let memoryPayload;
  const { runner } = makeRunner({
    requestOpenAI: async ({ payload, channel }) => {
      if (channel === 'voice') {
        voicePayload = payload;
        return { text: 'A mutex lets one thread enter a critical section at a time.' };
      }
      if (channel === 'voice-memory') memoryPayload = payload;
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
  assert.equal(runner.snapshot().voice.history.length, 1);
  assert.equal(runner.snapshot().voice.history[0].transcript, 'What is a mutex?');
  assert.equal(runner.snapshot().voiceMemory.answer, 'screen answer');
  assert.equal(runner.snapshot().voiceMemory.history.length, 1);
  assert.equal(voicePayload.input[0].content.some((part) => part.type === 'input_image'), false);
  assert.match(voicePayload.input[0].content[0].text, /What is a mutex/);
  assert.equal(memoryPayload.input[0].content.some((part) => part.type === 'input_image'), false);
});

test('should keep the baseline voice answer while creating a screen-context answer', async () => {
  let captured;
  const calls = [];
  const { runner, memory } = makeRunner({
    capture: async (options) => {
      captured = options;
      return { buffer: Buffer.from('combined image') };
    },
    requestOpenAI: async ({ payload, channel }) => {
      calls.push({ payload, channel });
      if (channel === 'voice-screen') return { text: 'combined answer' };
      return { text: 'baseline answer' };
    }
  });
  runner.updateSettings({ voiceMemoryEnabled: false, voiceScreenContextEnabled: true });
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
    item_id: 'voice-item-combined',
    transcript: 'Write tests for this exercise.'
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const state = runner.snapshot();
  const baselineCall = calls.find((call) => call.channel === 'voice');
  const combinedCall = calls.find((call) => call.channel === 'voice-screen');
  assert.equal(calls.length, 2);
  assert.equal(state.voice.answer, 'baseline answer');
  assert.equal(state.combined.answer, 'combined answer');
  assert.equal(state.combined.sourceLabel, 'Main display');
  assert.equal(state.combined.history.length, 1);
  assert.equal(captured.displayId, 'display-1');
  assert.equal(baselineCall.payload.input[0].content.some((part) => part.type === 'input_image'), false);
  assert.equal(combinedCall.payload.input[0].content.at(-1).type, 'input_image');
  assert.equal(memory.list()[0].combinedAnswer, 'combined answer');
});

test('should keep the baseline voice answer when the selected screen is unavailable', async () => {
  const { runner } = makeRunner({
    requestOpenAI: async ({ channel }) => ({ text: channel === 'voice' ? 'baseline answer' : 'unused' })
  });
  runner.updateSettings({ voiceMemoryEnabled: false, voiceScreenContextEnabled: true, sourceDisplayId: 'missing-display' });
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
    item_id: 'voice-item-missing-screen',
    transcript: 'What is CORS?'
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runner.snapshot().voice.answer, 'baseline answer');
  assert.match(runner.snapshot().combined.error, /No source display is available/);
  assert.equal(runner.snapshot().combined.history.length, 0);
});

test('should answer voice questions with and without the previous five turns', async () => {
  const calls = [];
  let answerNumber = 0;
  const { runner, memory } = makeRunner({
    requestOpenAI: async ({ payload, channel }) => {
      calls.push({ payload, channel });
      if (channel === 'voice') return { text: `baseline answer ${++answerNumber}` };
      return { text: `memory answer ${answerNumber}` };
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
    transcript: 'What is CORS?'
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  runner.handleVoiceEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'voice-item-2',
    transcript: 'What is idempotency?'
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = runner.snapshot();
  assert.equal(calls.filter((call) => call.channel === 'voice').length, 2);
  assert.equal(calls.filter((call) => call.channel === 'voice-memory').length, 2);
  assert.deepEqual(state.voice.history.map((entry) => entry.answer), ['baseline answer 1', 'baseline answer 2']);
  assert.deepEqual(state.voiceMemory.history.map((entry) => entry.answer), ['memory answer 1', 'memory answer 2']);
  const secondMemoryCall = calls
    .filter((call) => call.channel === 'voice-memory')
    .at(-1);
  const memoryText = secondMemoryCall.payload.input[0].content.map((part) => part.text || '').join('\n');
  assert.match(memoryText, /What is CORS/);
  assert.match(memoryText, /baseline answer 1/);
  assert.match(memoryText, /What is idempotency/);
  assert.equal(secondMemoryCall.payload.input[0].content.some((part) => part.type === 'input_image'), false);
  assert.equal(memory.list().filter((entry) => entry.kind === 'voice').length, 2);
  assert.equal(memory.list().at(-1).memoryAnswer, 'memory answer 2');
});

test('should keep the baseline voice window when voice memory comparison is disabled', async () => {
  const { runner, getCalls } = makeRunner();
  runner.updateSettings({ voiceMemoryEnabled: false });
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

  assert.equal(getCalls(), 1);
  assert.equal(runner.snapshot().voice.answer, 'answer');
  assert.equal(runner.snapshot().voiceMemory.status, 'disabled');
});

test('should show a memory-window error without hiding a successful baseline answer', async () => {
  const { runner } = makeRunner({
    requestOpenAI: async ({ channel }) => {
      if (channel === 'voice-memory') throw new Error('memory request failed');
      return { text: 'baseline answer' };
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

  assert.equal(runner.snapshot().voice.answer, 'baseline answer');
  assert.equal(runner.snapshot().voice.error, '');
  assert.match(runner.snapshot().voiceMemory.error, /memory request failed/);
});

test('should show translating while a voice answer is pending', async () => {
  let releaseAnswer;
  const pendingAnswer = new Promise((resolve) => {
    releaseAnswer = resolve;
  });
  const { runner } = makeRunner({
    requestOpenAI: async ({ channel }) => channel === 'voice' ? pendingAnswer : { text: 'screen answer' }
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
    transcript: 'What is idempotency?'
  });

  assert.equal(runner.snapshot().voice.status, 'translating');
  releaseAnswer({ text: 'Idempotency means repeating the same request has the same effect.' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runner.snapshot().voice.status, 'on');
});

test('should not persist a screen answer when memory is cleared during the request', async () => {
  let releaseAnswer;
  const pendingAnswer = new Promise((resolve) => { releaseAnswer = resolve; });
  const { runner, memory } = makeRunner({
    requestOpenAI: async () => pendingAnswer
  });

  const analysis = runner.triggerAnalysis({ promptOverride: 'pending question' });
  await flushPromises();
  runner.clearMemory();
  releaseAnswer({ text: 'late answer' });
  await analysis;

  assert.equal(memory.summary().count, 0);
});

test('should not persist a voice answer when memory is disabled during the request', async () => {
  let releaseAnswer;
  const pendingAnswer = new Promise((resolve) => { releaseAnswer = resolve; });
  const { runner, memory } = makeRunner({
    requestOpenAI: async ({ channel }) => channel === 'voice' ? pendingAnswer : { text: 'unused' }
  });
  runner.updateSettings({ voiceMemoryEnabled: false });
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
    item_id: 'voice-item-memory-race',
    transcript: 'What is CORS?'
  });
  await flushPromises();

  runner.updateSettings({ memoryEnabled: false });
  releaseAnswer({ text: 'CORS controls cross-origin browser requests.' });
  await flushPromises();
  await flushPromises();

  assert.equal(memory.list().length, 0);
});

test('should ignore an old voice answer after a non-graceful restart', async () => {
  let releaseOldAnswer;
  const oldAnswer = new Promise((resolve) => { releaseOldAnswer = resolve; });
  let voiceCalls = 0;
  const { runner } = makeRunner({
    requestOpenAI: async ({ channel }) => {
      if (channel !== 'voice') return { text: 'unused' };
      voiceCalls += 1;
      return voiceCalls === 1 ? oldAnswer : { text: 'new session answer' };
    }
  });
  runner.updateSettings({ voiceMemoryEnabled: false });
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
    item_id: 'voice-item-old-session',
    transcript: 'Old session question'
  });
  await flushPromises();

  await runner.stopVoice({ graceful: false });
  await runner.startVoice();
  releaseOldAnswer({ text: 'old session answer' });
  await flushPromises();
  await flushPromises();

  runner.handleVoiceEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'voice-item-new-session',
    transcript: 'New session question'
  });
  await flushPromises();
  await flushPromises();

  assert.equal(runner.snapshot().voice.answer, 'new session answer');
  assert.deepEqual(runner.snapshot().voice.history.map((entry) => entry.answer), ['new session answer']);
});

test('should only commit a voice buffer after audio was sent', async () => {
  const { runner } = makeRunner({
    requestOpenAI: async () => ({ text: 'unused' })
  });
  let commits = 0;
  const voiceSession = {
    start: async () => ({ connected: true }),
    stop: () => {},
    sendAudio: () => true,
    commit: () => {
      commits += 1;
      return true;
    }
  };
  runner.setApiKeyReady(true);
  runner.setVoiceSession(voiceSession);

  await runner.startVoice();
  assert.equal(runner.commitVoiceAudio(), false);
  assert.equal(runner.sendVoiceAudio(Buffer.from([1, 2, 3])), true);
  assert.equal(runner.commitVoiceAudio(), true);
  assert.equal(runner.commitVoiceAudio(), false);
  assert.equal(commits, 1);
});

test('should wait for a committed voice transcript before stopping', async () => {
  const { runner } = makeRunner({
    requestOpenAI: async () => ({ text: 'A mutex protects a critical section.' })
  });
  let commits = 0;
  let stops = 0;
  const voiceSession = {
    start: async () => ({ connected: true }),
    stop: () => { stops += 1; },
    sendAudio: () => true,
    commit: () => {
      commits += 1;
      return true;
    }
  };
  runner.setApiKeyReady(true);
  runner.setVoiceSession(voiceSession);
  await runner.startVoice();
  runner.sendVoiceAudio(Buffer.from([1, 2, 3]));

  const stopping = runner.stopVoice();
  assert.equal(commits, 1);
  assert.equal(stops, 0);
  runner.handleVoiceEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'voice-item-drain',
    transcript: 'What is a mutex?'
  });
  await stopping;

  assert.equal(stops, 1);
  assert.equal(runner.snapshot().voice.status, 'off');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runner.snapshot().voice.history.length, 1);
});

test('should report a rejected analysis request while another analysis is running', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { runner } = makeRunner({
    requestOpenAI: async () => pending
  });
  const active = runner.triggerAnalysis();
  const rejected = runner.requestAnalysis({ reason: 'button' });
  assert.deepEqual(rejected, { accepted: false, reason: 'already-running' });
  release({ text: 'answer' });
  await active;
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

test('should choose an unused display for combined answers when available', () => {
  const { runner } = makeRunner();
  runner.setDisplays([
    { id: 'display-1', captureNumber: 1, label: 'Main display', width: 100, height: 100 },
    { id: 'display-2', captureNumber: 2, label: 'External display 1', width: 100, height: 100 },
    { id: 'display-3', captureNumber: 3, label: 'External display 2', width: 100, height: 100 },
    { id: 'display-4', captureNumber: 4, label: 'External display 3', width: 100, height: 100 }
  ]);
  runner.updateSettings({ sourceDisplayNumber: 1, resultDisplayId: 'display-2', voiceResultDisplayId: 'display-3' });
  runner.setDisplays(runner.snapshot().displays);
  assert.equal(runner.snapshot().settings.combinedResultDisplayId, 'auto');
  assert.equal(runner.snapshot().combinedResultDisplay.id, 'display-4');
});

test('should choose an unused display for the previous screen answer', () => {
  const { runner } = makeRunner();
  runner.setDisplays([
    { id: 'display-1', captureNumber: 1, label: 'Main display', width: 100, height: 100 },
    { id: 'display-2', captureNumber: 2, label: 'External display 1', width: 100, height: 100 },
    { id: 'display-3', captureNumber: 3, label: 'External display 2', width: 100, height: 100 },
    { id: 'display-4', captureNumber: 4, label: 'External display 3', width: 100, height: 100 }
  ]);
  runner.updateSettings({ sourceDisplayNumber: 1, resultDisplayId: 'display-2', voiceResultDisplayId: 'display-3', previousResultDisplayId: '' });
  runner.setDisplays(runner.snapshot().displays);
  assert.equal(runner.snapshot().settings.previousResultDisplayId, 'display-4');
  assert.equal(runner.snapshot().previousResultDisplay.id, 'display-4');
});

test('should keep the previous answer window enabled when no display is free', () => {
  const { runner } = makeRunner();
  runner.updateSettings({ sourceDisplayNumber: 1, resultDisplayId: 'display-2', voiceResultDisplayId: 'display-1', previousResultDisplayId: '' });
  runner.setDisplays(runner.snapshot().displays);
  assert.equal(runner.snapshot().settings.previousResultDisplayId, 'auto');
  assert.equal(runner.snapshot().previousResultDisplay, null);
});

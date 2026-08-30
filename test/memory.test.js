const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalMemory } = require('../lib/memory');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gpt-memory-'));
}

test('should keep only the configured number of old answers', () => {
  const memory = new LocalMemory(tempDirectory(), { maxEntries: 2 });
  memory.addAnalysis({ prompt: 'one', answer: 'answer one' });
  memory.addAnalysis({ prompt: 'two', answer: 'answer two' });
  memory.addAnalysis({ prompt: 'three', answer: 'answer three' });
  assert.equal(memory.summary().count, 2);
  assert.match(memory.getContext(2), /answer two/);
  assert.match(memory.getContext(2), /answer three/);
  assert.doesNotMatch(memory.getContext(2), /answer one/);
});

test('should send no previous answers when the context limit is zero', () => {
  const memory = new LocalMemory(tempDirectory(), { maxEntries: 30 });
  memory.addAnalysis({ prompt: 'one', answer: 'private old answer' });

  assert.equal(memory.getContext(0), '');
});

test('should save the latest screenshot separately from text memory', () => {
  const directory = tempDirectory();
  const memory = new LocalMemory(directory, { maxEntries: 30 });
  const image = Buffer.from('png bytes');
  memory.saveLatestImage(image, { sourceLabel: 'External display 2' });
  assert.equal(memory.summary().screenshotSaved, true);
  assert.deepEqual(fs.readFileSync(memory.getLatestImagePath()), image);
  assert.equal(memory.summary().count, 0);
});

test('should clear entries and screenshot when requested', () => {
  const directory = tempDirectory();
  const memory = new LocalMemory(directory, { maxEntries: 30 });
  memory.addAnalysis({ prompt: 'prompt', answer: 'answer' });
  memory.saveLatestImage(Buffer.from('image'));
  memory.clear();
  assert.equal(memory.summary().count, 0);
  assert.equal(memory.summary().screenshotSaved, false);
});

test('should clear only the latest screenshot when requested', () => {
  const directory = tempDirectory();
  const memory = new LocalMemory(directory, { maxEntries: 30 });
  memory.addAnalysis({ prompt: 'prompt', answer: 'answer' });
  memory.saveLatestImage(Buffer.from('image'));

  memory.clearLatestImage();

  assert.equal(memory.summary().count, 1);
  assert.equal(memory.summary().screenshotSaved, false);
  assert.equal(memory.getLatestImagePath(), null);
});

test('should store no entries when the local limit is zero', () => {
  const memory = new LocalMemory(tempDirectory(), { maxEntries: 0 });
  memory.addAnalysis({ prompt: 'prompt', answer: 'answer' });
  assert.equal(memory.summary().count, 0);
});

test('should store voice text without attaching a screenshot', () => {
  const memory = new LocalMemory(tempDirectory(), { maxEntries: 30 });
  memory.addVoiceTranscript({ transcript: 'What is CORS?', prompt: 'Keep it short.', answer: 'It controls cross-origin requests.', memoryAnswer: 'It controls cross-origin requests and remembers earlier turns.' });
  const entry = memory.list()[0];
  assert.equal(entry.kind, 'voice');
  assert.equal(entry.transcript, 'What is CORS?');
  assert.equal(entry.answer, 'It controls cross-origin requests.');
  assert.equal(entry.memoryAnswer, 'It controls cross-origin requests and remembers earlier turns.');
  assert.equal(memory.summary().screenshotSaved, false);
});

test('should keep the state summary small while exposing all entries in details', () => {
  const memory = new LocalMemory(tempDirectory(), { maxEntries: 30 });
  for (let index = 0; index < 12; index += 1) {
    memory.addAnalysis({ prompt: `prompt ${index}`, answer: `answer ${index}` });
  }

  assert.equal(Object.hasOwn(memory.summary(), 'entries'), false);
  assert.equal(memory.details().entries.length, 12);
  assert.equal(memory.details().entries[0].answer, 'answer 11');
});

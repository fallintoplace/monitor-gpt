const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_PROMPT, DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings } = require('../lib/config');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gpt-config-'));
}

test('should keep the remembered defaults when settings are missing', () => {
  const settings = loadSettings(tempDirectory());
  assert.equal(settings.model, 'gpt-5.6-luna');
  assert.equal(settings.reasoning, 'medium');
  assert.equal(settings.resultLayout, 'five');
  assert.equal(settings.prompt, DEFAULT_PROMPT);
});

test('should normalize invalid settings without accepting unsupported values', () => {
  const settings = normalizeSettings({
    model: 'not-a-model',
    reasoning: 'ultra',
    resultFontSizePx: 999,
    memoryMaxEntries: -12,
    triggerMode: 'unknown'
  });
  assert.equal(settings.model, DEFAULT_SETTINGS.model);
  assert.equal(settings.reasoning, DEFAULT_SETTINGS.reasoning);
  assert.equal(settings.resultFontSizePx, 32);
  assert.equal(settings.memoryMaxEntries, 0);
  assert.equal(settings.triggerMode, DEFAULT_SETTINGS.triggerMode);
});

test('should persist settings outside the renderer state shape', () => {
  const directory = tempDirectory();
  const saved = saveSettings(directory, { prompt: 'Keep this prompt', model: 'gpt-5.6-terra' });
  const loaded = loadSettings(directory);
  assert.equal(saved.prompt, 'Keep this prompt');
  assert.equal(loaded.prompt, 'Keep this prompt');
  assert.equal(loaded.model, 'gpt-5.6-terra');
  assert.ok(fs.existsSync(path.join(directory, 'settings.json')));
});

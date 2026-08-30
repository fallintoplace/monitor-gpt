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
  assert.equal(settings.voiceModel, 'gpt-5.6-luna');
  assert.equal(settings.reasoning, 'medium');
  assert.equal(settings.resultLayout, 'five');
  assert.equal(settings.previousResultDisplayId, 'auto');
  assert.equal(settings.combinedResultDisplayId, 'auto');
  assert.equal(settings.prompt, DEFAULT_PROMPT);
  assert.equal(settings.screenAnswerLanguage, 'English');
  assert.equal(settings.voiceAnswerLanguage, 'English');
  assert.equal(settings.sourceDisplayId, '');
  assert.equal(settings.voiceTurnDetection, 'semantic-auto');
  assert.equal(settings.voiceTranscriptionDelay, 'low');
  assert.equal(settings.voiceMemoryEnabled, true);
  assert.equal(settings.voiceMemoryContextAnswers, 5);
  assert.equal(settings.voiceAudioDeviceId, '');
  assert.equal(settings.voiceFontSizePx, 16);
  assert.ok(settings.voicePrompt.length > 0);
});

test('should normalize invalid settings without accepting unsupported values', () => {
  const settings = normalizeSettings({
    model: 'not-a-model',
    reasoning: 'ultra',
    resultFontSizePx: 999,
    memoryMaxEntries: -12,
    triggerMode: 'unknown',
    screenAnswerLanguage: '   ',
    voiceAnswerLanguage: 'x'.repeat(100)
  });
  assert.equal(settings.model, DEFAULT_SETTINGS.model);
  assert.equal(settings.reasoning, DEFAULT_SETTINGS.reasoning);
  assert.equal(settings.resultFontSizePx, 32);
  assert.equal(settings.memoryMaxEntries, 0);
  assert.equal(settings.triggerMode, DEFAULT_SETTINGS.triggerMode);
  assert.equal(settings.screenAnswerLanguage, 'English');
  assert.equal(settings.voiceAnswerLanguage.length, 80);
  assert.equal(settings.voiceMemoryContextAnswers, DEFAULT_SETTINGS.voiceMemoryContextAnswers);
  assert.equal(settings.voiceScreenContextEnabled, true);
});

test('should persist settings outside the renderer state shape', () => {
  const directory = tempDirectory();
  const saved = saveSettings(directory, { prompt: 'Keep this prompt', model: 'gpt-5.6-terra', voiceModel: 'gpt-5.6-sol', voiceCustomModel: 'voice-model-123', screenAnswerLanguage: 'Spanish', voiceAnswerLanguage: 'Vietnamese', sourceDisplayId: 'display-3', voiceMemoryEnabled: false, voiceMemoryContextAnswers: 3, voiceAudioDeviceId: 'microphone-123', voiceFontSizePx: 18, voiceScreenContextEnabled: true, combinedResultDisplayId: 'display-2' });
  const loaded = loadSettings(directory);
  assert.equal(saved.prompt, 'Keep this prompt');
  assert.equal(loaded.prompt, 'Keep this prompt');
  assert.equal(loaded.model, 'gpt-5.6-terra');
  assert.equal(loaded.voiceModel, 'gpt-5.6-sol');
  assert.equal(loaded.voiceCustomModel, 'voice-model-123');
  assert.equal(loaded.screenAnswerLanguage, 'Spanish');
  assert.equal(loaded.voiceAnswerLanguage, 'Vietnamese');
  assert.equal(loaded.sourceDisplayId, 'display-3');
  assert.equal(loaded.voiceMemoryEnabled, false);
  assert.equal(loaded.voiceMemoryContextAnswers, 3);
  assert.equal(loaded.voiceResultDisplayId, '');
  assert.equal(loaded.previousResultDisplayId, 'auto');
  assert.equal(loaded.combinedResultDisplayId, 'display-2');
  assert.equal(loaded.voiceScreenContextEnabled, true);
  assert.equal(loaded.voiceAudioDeviceId, 'microphone-123');
  assert.equal(loaded.voiceFontSizePx, 18);
  assert.equal(loaded.voiceTurnDetection, 'semantic-auto');
  assert.ok(fs.existsSync(path.join(directory, 'settings.json')));
});

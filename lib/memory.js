const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read local memory:', error.message);
    return fallback;
  }
}

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function compactText(value, maximum = 8000) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

class LocalMemory {
  constructor(dataDirectory, options = {}) {
    this.dataDirectory = dataDirectory;
    this.memoryFile = path.join(dataDirectory, 'memory.json');
    this.latestImageFile = path.join(dataDirectory, 'latest.png');
    this.maxEntries = options.maxEntries === undefined ? 30 : Math.max(0, Math.min(100, Math.round(Number(options.maxEntries) || 0)));
    this.entries = [];
    this.latestImage = null;
    this.reload();
  }

  reload() {
    const stored = safeReadJson(this.memoryFile, { entries: [], latestImage: null });
    this.entries = Array.isArray(stored) ? stored : (Array.isArray(stored.entries) ? stored.entries : []);
    this.latestImage = stored && !Array.isArray(stored) ? stored.latestImage || null : null;
    try {
      const stats = fs.statSync(this.latestImageFile);
      this.latestImage = {
        ...(this.latestImage || {}),
        bytes: stats.size,
        createdAt: this.latestImage?.createdAt || stats.mtime.toISOString()
      };
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Could not inspect latest screenshot:', error.message);
    }
  }

  setMaxEntries(value) {
    this.maxEntries = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    this.entries = this.limitEntries(this.entries);
    this.persist();
  }

  limitEntries(entries) {
    return this.maxEntries > 0 ? entries.slice(-this.maxEntries) : [];
  }

  persist() {
    writeJsonAtomically(this.memoryFile, {
      entries: this.limitEntries(this.entries),
      latestImage: this.latestImage
    });
  }

  saveLatestImage(buffer, metadata = {}) {
    if (!buffer || !buffer.length) return null;
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    const temporary = `${this.latestImageFile}.tmp`;
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, this.latestImageFile);
    this.latestImage = {
      bytes: buffer.length,
      createdAt: new Date().toISOString(),
      sourceDisplayNumber: metadata.sourceDisplayNumber || null,
      sourceLabel: metadata.sourceLabel || ''
    };
    this.persist();
    return this.latestImage;
  }

  hasLatestImage() {
    return Boolean(this.latestImage && this.latestImage.bytes);
  }

  getLatestImagePath() {
    return this.hasLatestImage() ? this.latestImageFile : null;
  }

  addAnalysis({ prompt, answer, sourceDisplayNumber, sourceLabel, model }) {
    if (this.maxEntries === 0) return null;
    const entry = {
      id: crypto.randomUUID(),
      kind: 'analysis',
      createdAt: new Date().toISOString(),
      prompt: compactText(prompt, 10000),
      answer: compactText(answer, 12000),
      sourceDisplayNumber: sourceDisplayNumber || null,
      sourceLabel: compactText(sourceLabel, 200),
      model: compactText(model, 100)
    };
    this.entries = [...this.entries, entry].slice(-this.maxEntries);
    this.persist();
    return entry;
  }

  addVoiceTranscript({
    id = '',
    createdAt = null,
    transcript,
    prompt = '',
    answer = '',
    memoryAnswer = '',
    combinedAnswer = '',
    combinedSourceDisplayNumber = null,
    combinedSourceLabel = '',
    combinedCaptureAt = null
  }) {
    if (this.maxEntries === 0) return null;
    const entry = {
      id: typeof id === 'string' && id.trim() ? id.trim() : crypto.randomUUID(),
      kind: 'voice',
      createdAt: typeof createdAt === 'string' && createdAt ? createdAt : new Date().toISOString(),
      prompt: compactText(prompt, 4000),
      transcript: compactText(transcript, 8000),
      answer: compactText(answer, 12000),
      memoryAnswer: compactText(memoryAnswer, 12000),
      combinedAnswer: compactText(combinedAnswer, 12000),
      combinedSourceDisplayNumber: combinedSourceDisplayNumber || null,
      combinedSourceLabel: compactText(combinedSourceLabel, 200),
      combinedCaptureAt: typeof combinedCaptureAt === 'string' ? combinedCaptureAt : null
    };
    this.entries = [...this.entries, entry].slice(-this.maxEntries);
    this.persist();
    return entry;
  }

  getContext(limit = 5) {
    const count = Math.max(0, Number(limit) || 0);
    if (count === 0) return '';

    const selected = this.entries
      .filter((entry) => entry.kind === 'analysis' && entry.answer)
      .slice(-count);
    if (!selected.length) return '';
    return [
      'LOW-PRIORITY LOCAL MEMORY. Use this only to resolve continuity. The current screenshot and current prompt always take precedence.',
      ...selected.map((entry, index) => `Earlier answer ${index + 1}:\n${entry.answer}`)
    ].join('\n\n').slice(0, 24000);
  }

  list() {
    return this.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      createdAt: entry.createdAt,
      prompt: entry.prompt,
      answer: entry.answer,
      memoryAnswer: entry.memoryAnswer,
      combinedAnswer: entry.combinedAnswer,
      combinedSourceDisplayNumber: entry.combinedSourceDisplayNumber,
      combinedSourceLabel: entry.combinedSourceLabel,
      combinedCaptureAt: entry.combinedCaptureAt,
      transcript: entry.transcript,
      sourceLabel: entry.sourceLabel,
      model: entry.model
    }));
  }

  summary() {
    return {
      count: this.entries.length,
      maxEntries: this.maxEntries,
      screenshotSaved: this.hasLatestImage(),
      latestImage: this.latestImage
    };
  }

  details() {
    return {
      ...this.summary(),
      entries: this.list().reverse()
    };
  }

  clearLatestImage() {
    try {
      fs.unlinkSync(this.latestImageFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.latestImage = null;
    this.persist();
  }

  clear() {
    this.entries = [];
    this.latestImage = null;
    for (const file of [this.memoryFile, this.latestImageFile]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  delete(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length !== before) this.persist();
    return before !== this.entries.length;
  }
}

module.exports = { LocalMemory, compactText };

const crypto = require('node:crypto');
const { buildResponsesPayload } = require('./openai');
const { normalizeSettings, saveSettings } = require('./config');

function now() {
  return new Date().toISOString();
}

function publicError(error) {
  if (!error) return '';
  return String(error.message || error).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-…');
}

class MonitorRunner {
  constructor({
    dataDirectory,
    settings,
    memory,
    capture,
    requestOpenAI,
    apiKeyReady = false,
    logger = console
  }) {
    this.dataDirectory = dataDirectory;
    this.memory = memory;
    this.capture = capture;
    this.requestOpenAI = requestOpenAI;
    this.apiKeyReady = Boolean(apiKeyReady);
    this.logger = logger;
    this.settings = normalizeSettings(settings);
    this.listeners = new Set();
    this.displays = [];
    this.hotkeys = { analysis: [], voice: [] };
    this.running = false;
    this.timer = null;
    this.analysisInFlight = false;
    this.lastCaptureHash = '';
    this.lastAnalysisFingerprint = '';
    this.state = {
      status: 'ready',
      result: '',
      error: '',
      completedAt: null,
      startedAt: null,
      lastImageBytes: 0,
      lastCaptureAt: null,
      lastTrigger: '',
      revision: 0,
      voice: {
        enabled: false,
        status: 'unavailable',
        transcript: '',
        error: ''
      }
    };
    this.memory.setMaxEntries(this.settings.memoryMaxEntries);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.state.revision += 1;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  snapshot() {
    const source = this.findSourceDisplay();
    const result = this.findResultDisplay();
    return {
      ...this.state,
      settings: { ...this.settings },
      displays: this.displays,
      sourceDisplay: source,
      resultDisplay: result,
      memory: this.memory.summary(),
      hotkeys: this.hotkeys,
      apiKeyReady: this.apiKeyReady,
      monitoring: this.running,
      resultUrl: '/result'
    };
  }

  setApiKeyReady(value) {
    this.apiKeyReady = Boolean(value);
    this.notify();
  }

  setHotkeys(hotkeys) {
    this.hotkeys = {
      analysis: Array.isArray(hotkeys?.analysis) ? hotkeys.analysis : [],
      voice: Array.isArray(hotkeys?.voice) ? hotkeys.voice : []
    };
    this.notify();
  }

  setDisplays(displays) {
    this.displays = Array.isArray(displays) ? displays : [];
    const exactSource = this.displays.find((display) => display.captureNumber === this.settings.sourceDisplayNumber);
    if (!exactSource) {
      const first = this.displays[0];
      if (first) this.settings.sourceDisplayNumber = first.captureNumber;
    }
    const savedResult = String(this.settings.resultDisplayId || '');
    const exactResult = this.displays.find((display) => String(display.id) === savedResult || String(display.captureNumber) === savedResult);
    if (!exactResult) {
      const fallback = this.displays.find((display) => display.captureNumber !== this.settings.sourceDisplayNumber)
        || this.displays[0];
      if (fallback) this.settings.resultDisplayId = String(fallback.id);
    }
    saveSettings(this.dataDirectory, this.settings);
    this.notify();
  }

  findSourceDisplay() {
    return this.displays.find((display) => display.captureNumber === this.settings.sourceDisplayNumber)
      || this.displays[0]
      || null;
  }

  findResultDisplay() {
    const saved = String(this.settings.resultDisplayId || '');
    return this.displays.find((display) => String(display.id) === saved || String(display.captureNumber) === saved)
      || this.displays.find((display) => display.captureNumber !== this.settings.sourceDisplayNumber)
      || this.displays[0]
      || null;
  }

  updateSettings(changes = {}) {
    const previous = this.settings;
    this.settings = normalizeSettings({ ...previous, ...changes });
    saveSettings(this.dataDirectory, this.settings);
    this.memory.setMaxEntries(this.settings.memoryMaxEntries);
    if (previous.triggerMode !== this.settings.triggerMode || previous.analyzeEveryMs !== this.settings.analyzeEveryMs) {
      this.configureTimer();
    }
    this.notify();
    return this.settings;
  }

  setVoiceState(patch) {
    this.state.voice = { ...this.state.voice, ...patch };
    this.notify();
  }

  start() {
    this.running = true;
    this.configureTimer();
    this.notify();
  }

  stop() {
    this.running = false;
    this.clearTimer();
    this.notify();
  }

  clearTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  configureTimer() {
    this.clearTimer();
    if (this.running && this.settings.triggerMode === 'auto') {
      this.timer = setInterval(() => {
        void this.triggerAnalysis({ reason: 'timer' });
      }, this.settings.analyzeEveryMs);
    }
  }

  analysisFingerprint({ prompt = this.settings.prompt, sourceDisplayNumber = this.settings.sourceDisplayNumber } = {}) {
    return JSON.stringify({
      prompt,
      sourceDisplayNumber,
      model: this.settings.model,
      customModel: this.settings.customModel,
      reasoning: this.settings.reasoning,
      imageDetail: this.settings.imageDetail,
      maxImageWidth: this.settings.maxImageWidth,
      memoryEnabled: this.settings.memoryEnabled,
      memoryContextAnswers: this.settings.memoryContextAnswers
    });
  }

  async triggerAnalysis({ reason = 'manual', promptOverride = '' } = {}) {
    if (this.analysisInFlight) return { accepted: false, reason: 'already-running' };
    this.analysisInFlight = true;
    const source = this.findSourceDisplay();
    const prompt = typeof promptOverride === 'string' && promptOverride.trim()
      ? promptOverride.trim()
      : this.settings.prompt;
    this.state = {
      ...this.state,
      status: 'capturing',
      error: '',
      startedAt: now(),
      lastTrigger: reason
    };
    this.notify();

    try {
      if (!source) throw new Error('No source display is available. Refresh the display list.');
      const captured = await this.capture({
        displayNumber: source.captureNumber,
        maxImageWidth: this.settings.maxImageWidth
      });
      const imageHash = crypto.createHash('sha256').update(captured.buffer).digest('hex');
      const imageInfo = this.memory.saveLatestImage(captured.buffer, {
        sourceDisplayNumber: source.captureNumber,
        sourceLabel: source.label
      });
      this.state = {
        ...this.state,
        status: 'analyzing',
        lastImageBytes: captured.buffer.length,
        lastCaptureAt: now()
      };
      this.notify();

      const memoryContext = this.settings.memoryEnabled
        ? this.memory.getContext(this.settings.memoryContextAnswers)
        : '';
      const fingerprint = this.analysisFingerprint({
        prompt,
        sourceDisplayNumber: source.captureNumber
      });
      if (this.settings.skipUnchanged && imageHash === this.lastCaptureHash && fingerprint === this.lastAnalysisFingerprint) {
        this.state = { ...this.state, status: 'ready', error: '' };
        this.notify();
        return { accepted: true, skipped: true, imageInfo };
      }

      const payload = buildResponsesPayload({
        settings: this.settings,
        prompt,
        imageBase64: captured.buffer.toString('base64'),
        memoryContext
      });
      const response = await this.requestOpenAI({ payload, settings: this.settings });
      const answer = response.text || '';
      if (this.settings.memoryEnabled) {
        this.memory.addAnalysis({
          prompt,
          answer,
          sourceDisplayNumber: source.captureNumber,
          sourceLabel: source.label,
          model: payload.model
        });
      }
      this.lastCaptureHash = imageHash;
      this.lastAnalysisFingerprint = fingerprint;
      this.state = {
        ...this.state,
        status: 'ready',
        result: answer,
        error: '',
        completedAt: now()
      };
      this.notify();
      return { accepted: true, skipped: false, imageInfo, answer };
    } catch (error) {
      this.logger.error?.('Analysis failed:', error);
      this.state = {
        ...this.state,
        status: 'error',
        error: publicError(error)
      };
      this.notify();
      return { accepted: true, error: this.state.error };
    } finally {
      this.analysisInFlight = false;
    }
  }

  clearMemory() {
    this.memory.clear();
    this.notify();
  }

  deleteMemoryEntry(id) {
    const deleted = this.memory.delete(id);
    if (deleted) this.notify();
    return deleted;
  }
}

module.exports = { MonitorRunner, publicError };

const crypto = require('node:crypto');
const { buildResponsesPayload, buildVoiceAnswerPayload } = require('./openai');
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
    voiceSession = null,
    logger = console
  }) {
    this.dataDirectory = dataDirectory;
    this.memory = memory;
    this.capture = capture;
    this.requestOpenAI = requestOpenAI;
    this.apiKeyReady = Boolean(apiKeyReady);
    this.voiceSession = voiceSession;
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
    this.voiceItems = new Map();
    this.voiceProcessedItems = new Set();
    this.voiceActiveItemId = '';
    this.voiceTurnNumber = 0;
    this.voiceAnswerQueue = [];
    this.voiceAnswerInFlight = false;
    this.voiceStartGeneration = 0;
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
        status: this.apiKeyReady ? 'off' : 'unavailable',
        transcript: '',
        answer: '',
        error: '',
        speechActive: false,
        updatedAt: null,
        completedAt: null
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
    const voiceResult = this.findVoiceResultDisplay();
    return {
      ...this.state,
      settings: { ...this.settings },
      displays: this.displays,
      sourceDisplay: source,
      resultDisplay: result,
      voiceResultDisplay: voiceResult,
      memory: this.memory.summary(),
      hotkeys: this.hotkeys,
      apiKeyReady: this.apiKeyReady,
      monitoring: this.running,
      resultUrl: '/result',
      voiceUrl: '/voice'
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
    const savedVoiceResult = String(this.settings.voiceResultDisplayId || '');
    const exactVoiceResult = this.displays.find((display) => String(display.id) === savedVoiceResult || String(display.captureNumber) === savedVoiceResult);
    if (!exactVoiceResult) {
      const resultId = String(this.settings.resultDisplayId || '');
      const fallback = this.displays.find((display) => String(display.id) !== resultId
          && display.captureNumber !== this.settings.sourceDisplayNumber)
        || this.displays.find((display) => String(display.id) !== resultId)
        || this.displays[0];
      if (fallback) this.settings.voiceResultDisplayId = String(fallback.id);
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

  findVoiceResultDisplay() {
    const saved = String(this.settings.voiceResultDisplayId || '');
    return this.displays.find((display) => String(display.id) === saved || String(display.captureNumber) === saved)
      || this.displays.find((display) => String(display.id) !== String(this.settings.resultDisplayId || '')
        && display.captureNumber !== this.settings.sourceDisplayNumber)
      || this.displays.find((display) => String(display.id) !== String(this.settings.resultDisplayId || ''))
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

  setVoiceSession(session) {
    this.voiceSession = session;
  }

  voiceStatusWhenIdle() {
    return this.apiKeyReady ? 'off' : 'unavailable';
  }

  async startVoice() {
    if (!this.apiKeyReady) {
      const error = 'OpenAI API key is missing. Put OPENAI_API_KEY in .env and restart the app.';
      this.state.voice = {
        ...this.state.voice,
        enabled: false,
        status: 'error',
        error,
        updatedAt: now()
      };
      this.notify();
      return { accepted: false, error };
    }
    if (!this.voiceSession) {
      const error = 'Voice capture is not available.';
      this.state.voice = { ...this.state.voice, enabled: false, status: 'error', error, updatedAt: now() };
      this.notify();
      return { accepted: false, error };
    }
    if (this.state.voice.enabled || this.state.voice.status === 'connecting') {
      return { accepted: true, alreadyRunning: true };
    }

    this.voiceItems.clear();
    this.voiceProcessedItems.clear();
    this.voiceActiveItemId = '';
    this.voiceTurnNumber = 0;
    this.voiceAnswerQueue = [];
    const generation = ++this.voiceStartGeneration;
    this.state.voice = {
      ...this.state.voice,
      enabled: true,
      status: 'connecting',
      transcript: '',
      error: '',
      speechActive: false,
      updatedAt: now()
    };
    this.notify();

    try {
      await this.voiceSession.start({
        delay: this.settings.voiceTranscriptionDelay,
        turnDetection: this.settings.voiceTurnDetection
      });
      if (generation !== this.voiceStartGeneration || !this.state.voice.enabled) {
        return { accepted: false, stopped: true };
      }
      this.state.voice = { ...this.state.voice, enabled: true, status: 'on', error: '', updatedAt: now() };
      this.notify();
      return { accepted: true };
    } catch (error) {
      if (generation !== this.voiceStartGeneration || !this.state.voice.enabled) {
        return { accepted: false, stopped: true };
      }
      this.logger.error?.('Voice start failed:', error);
      this.state.voice = {
        ...this.state.voice,
        enabled: false,
        status: 'error',
        error: publicError(error),
        speechActive: false,
        updatedAt: now()
      };
      this.notify();
      return { accepted: false, error: this.state.voice.error };
    }
  }

  stopVoice() {
    this.voiceStartGeneration += 1;
    try {
      this.voiceSession?.stop();
    } catch (error) {
      this.logger.error?.('Voice stop failed:', error);
    }
    this.voiceAnswerQueue = [];
    this.state.voice = {
      ...this.state.voice,
      enabled: false,
      status: this.voiceStatusWhenIdle(),
      speechActive: false,
      error: '',
      updatedAt: now()
    };
    this.notify();
    return { accepted: true };
  }

  toggleVoice() {
    return this.state.voice.enabled ? this.stopVoice() : this.startVoice();
  }

  sendVoiceAudio(audio) {
    if (!this.state.voice.enabled || !this.voiceSession) return false;
    return Boolean(this.voiceSession.sendAudio(audio));
  }

  handleVoiceError(error) {
    const message = publicError(error);
    this.logger.error?.('Voice session failed:', message);
    this.state.voice = {
      ...this.state.voice,
      enabled: false,
      status: 'error',
      error: message,
      speechActive: false,
      updatedAt: now()
    };
    this.notify();
  }

  handleVoiceEvent(event = {}) {
    const type = event.type;
    if (type === 'session.opened' || type === 'session.created' || type === 'session.updated') {
      if (this.state.voice.enabled && this.state.voice.status === 'connecting') {
        this.state.voice = { ...this.state.voice, status: 'on', updatedAt: now() };
        this.notify();
      }
      return;
    }
    if (type === 'session.closed') {
      if (this.state.voice.enabled) this.handleVoiceError(new Error('Realtime voice connection closed.'));
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      this.voiceActiveItemId = event.item_id || `voice-turn-${++this.voiceTurnNumber}`;
      this.state.voice = {
        ...this.state.voice,
        status: 'speaking',
        transcript: '',
        error: '',
        speechActive: true,
        updatedAt: now()
      };
      this.notify();
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this.state.voice = { ...this.state.voice, status: 'transcribing', speechActive: false, updatedAt: now() };
      this.notify();
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      const itemId = event.item_id || this.voiceActiveItemId || 'current';
      const transcript = `${this.voiceItems.get(itemId) || ''}${event.delta || ''}`;
      this.voiceItems.set(itemId, transcript);
      this.state.voice = { ...this.state.voice, status: 'transcribing', transcript, updatedAt: now() };
      this.notify();
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = event.item_id || this.voiceActiveItemId || 'current';
      if (this.voiceProcessedItems.has(itemId)) return;
      const transcript = String(event.transcript || this.voiceItems.get(itemId) || '').trim();
      if (!transcript) return;
      this.voiceProcessedItems.add(itemId);
      this.voiceItems.set(itemId, transcript);
      this.voiceActiveItemId = '';
      this.state.voice = {
        ...this.state.voice,
        status: 'thinking',
        transcript,
        speechActive: false,
        updatedAt: now()
      };
      this.notify();
      this.voiceAnswerQueue.push(transcript);
      void this.processVoiceAnswerQueue();
    }
  }

  async processVoiceAnswerQueue() {
    if (this.voiceAnswerInFlight || !this.voiceAnswerQueue.length) return;
    this.voiceAnswerInFlight = true;
    const transcript = this.voiceAnswerQueue.shift();
    const settings = { ...this.settings };
    try {
      const payload = buildVoiceAnswerPayload({ settings, transcript });
      const response = await this.requestOpenAI({ payload, settings, channel: 'voice' });
      const answer = response.text || '';
      if (settings.memoryEnabled) {
        this.memory.addVoiceTranscript({
          transcript,
          prompt: settings.voicePrompt,
          answer
        });
      }
      this.state.voice = {
        ...this.state.voice,
        status: this.voiceAnswerQueue.length ? 'thinking' : (this.state.voice.enabled ? 'on' : this.voiceStatusWhenIdle()),
        answer,
        error: '',
        completedAt: now(),
        updatedAt: now()
      };
      this.notify();
    } catch (error) {
      this.logger.error?.('Voice answer failed:', error);
      this.state.voice = {
        ...this.state.voice,
        status: 'error',
        error: publicError(error),
        updatedAt: now()
      };
      this.notify();
    } finally {
      this.voiceAnswerInFlight = false;
      if (this.voiceAnswerQueue.length) void this.processVoiceAnswerQueue();
    }
  }

  start() {
    this.running = true;
    this.configureTimer();
    this.notify();
  }

  stop() {
    this.running = false;
    this.clearTimer();
    this.voiceStartGeneration += 1;
    try {
      this.voiceSession?.stop();
    } catch (error) {
      this.logger.error?.('Voice stop failed:', error);
    }
    this.state.voice = {
      ...this.state.voice,
      enabled: false,
      status: this.voiceStatusWhenIdle(),
      speechActive: false
    };
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

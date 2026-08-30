(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let state = null;
  let lastDisplaySignature = '';
  let lastSettingsSignature = '';
  let saveTimer = null;
  let memoryData = null;
  let voiceCapture = null;
  let voiceCapturePromise = null;
  let voiceCaptureGeneration = 0;
  let voiceWanted = false;
  let audioDevicesLoaded = false;
  let voiceCommitPromise = null;
  const VOICE_PAUSE_MS = Object.freeze({
    server: 450,
    'semantic-auto': 650,
    'semantic-low': 950
  });
  const VOICE_THRESHOLD = 0.012;
  const VOICE_PREROLL_MS = 240;
  const VOICE_START_MS = 100;
  let voiceVad = null;

  function displaySignature(displays) {
    return (displays || []).map((display) => `${display.id}:${display.captureNumber}:${display.width}x${display.height}`).join('|');
  }

  function settingsSignature(settings) {
    return JSON.stringify(settings || {});
  }

  function setSelectOptions(select, options, selected) {
    const previous = select.value;
    select.replaceChildren();
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }
    select.value = options.some((option) => option.value === String(selected)) ? String(selected) : previous;
    if (!select.value && options[0]) select.value = options[0].value;
  }

  function renderDisplays(nextState) {
    const signature = displaySignature(nextState.displays);
    if (signature !== lastDisplaySignature) {
      lastDisplaySignature = signature;
      const options = (nextState.displays || []).map((display) => ({
        value: String(display.id),
        label: `${display.label} · D${display.captureNumber} · ${display.width}×${display.height}${display.isPrimary ? ' · primary' : ''}`
      }));
      const selectedSourceId = String(nextState.settings.sourceDisplayId || '');
      if (selectedSourceId && !options.some((option) => option.value === selectedSourceId)) {
        options.unshift({
          value: selectedSourceId,
          label: 'Selected display unavailable · reconnect or choose another'
        });
      }
      setSelectOptions($('source-display'), options, nextState.settings.sourceDisplayId || nextState.settings.sourceDisplayNumber);
      const resultOptions = (nextState.displays || []).map((display) => ({
        value: String(display.id),
        label: `${display.label} · D${display.captureNumber} · ${display.width}×${display.height}`
      }));
      setSelectOptions($('result-display'), resultOptions, nextState.settings.resultDisplayId);
      setSelectOptions($('previous-result-display'), [
        { value: 'auto', label: 'Automatic · show as a movable window' },
        { value: 'off', label: 'Off · hide previous-answer window' },
        ...resultOptions
      ], nextState.settings.previousResultDisplayId);
      setSelectOptions($('voice-result-display'), resultOptions, nextState.settings.voiceResultDisplayId);
      setSelectOptions($('combined-result-display'), [
        { value: 'auto', label: 'Automatic · use an unused display' },
        ...resultOptions
      ], nextState.settings.combinedResultDisplayId);
    }
    const previousDisplay = $('previous-result-display');
    if (previousDisplay && document.activeElement !== previousDisplay) {
      previousDisplay.value = String(nextState.settings.previousResultDisplayId || '');
    }
    const voiceDisplay = $('voice-result-display');
    if (voiceDisplay && document.activeElement !== voiceDisplay && nextState.settings.voiceResultDisplayId) {
      voiceDisplay.value = String(nextState.settings.voiceResultDisplayId);
    }
    const combinedDisplay = $('combined-result-display');
    if (combinedDisplay && document.activeElement !== combinedDisplay && nextState.settings.combinedResultDisplayId) {
      combinedDisplay.value = String(nextState.settings.combinedResultDisplayId);
    }
  }

  async function refreshAudioDevices(selectedDeviceId = $('voice-audio-device')?.value || '') {
    const select = $('voice-audio-device');
    if (!select || !navigator.mediaDevices?.enumerateDevices) return;
    let devices;
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
    const seen = new Set();
    const options = [{ value: '', label: 'Default microphone' }];
    for (const device of inputs) {
      if (seen.has(device.deviceId)) continue;
      seen.add(device.deviceId);
      options.push({
        value: device.deviceId,
        label: device.label || `Microphone ${seen.size}`
      });
    }
    const signature = options.map((option) => `${option.value}:${option.label}`).join('|');
    if (!audioDevicesLoaded || select.dataset.deviceSignature !== signature) {
      setSelectOptions(select, options, selectedDeviceId);
      select.dataset.deviceSignature = signature;
      audioDevicesLoaded = true;
    } else if (document.activeElement !== select && selectedDeviceId !== undefined) {
      select.value = options.some((option) => option.value === String(selectedDeviceId))
        ? String(selectedDeviceId)
        : '';
    }
  }

  function applyTheme(theme) {
    document.body.dataset.theme = theme || 'light';
  }

  function setValue(id, value) {
    const element = $(id);
    if (element && document.activeElement !== element) element.value = value ?? '';
  }

  function applySettings(settings, force = false) {
    const signature = settingsSignature(settings);
    if (!force && signature === lastSettingsSignature) return;
    lastSettingsSignature = signature;
    if (force || document.activeElement !== $('prompt')) setValue('prompt', settings.prompt);
    if (force || document.activeElement !== $('model')) setValue('model', settings.model);
    setValue('custom-model', settings.customModel);
    setValue('voice-model', settings.voiceModel);
    setValue('voice-custom-model', settings.voiceCustomModel);
    setValue('reasoning', settings.reasoning);
    setValue('image-detail', settings.imageDetail);
    setValue('trigger-mode', settings.triggerMode);
    setValue('screen-answer-language', settings.screenAnswerLanguage);
    setValue('analyze-every', Math.round(settings.analyzeEveryMs / 1000));
    setValue('result-poll', settings.resultPollMs);
    setValue('max-image-width', settings.maxImageWidth);
    setValue('result-font-size', settings.resultFontSizePx);
    setValue('result-layout', settings.resultLayout);
    setValue('theme', settings.theme);
    if (force || document.activeElement !== $('voice-prompt')) setValue('voice-prompt', settings.voicePrompt);
    setValue('voice-turn-detection', settings.voiceTurnDetection);
    setValue('voice-transcription-delay', settings.voiceTranscriptionDelay);
    setValue('voice-audio-device', settings.voiceAudioDeviceId);
    setValue('voice-font-size', settings.voiceFontSizePx);
    setValue('voice-answer-language', settings.voiceAnswerLanguage);
    $('voice-memory-enabled').checked = Boolean(settings.voiceMemoryEnabled);
    setValue('voice-memory-context', settings.voiceMemoryContextAnswers);
    $('voice-screen-context-enabled').checked = Boolean(settings.voiceScreenContextEnabled);
    $('skip-unchanged').checked = Boolean(settings.skipUnchanged);
    $('result-autofit').checked = Boolean(settings.resultAutoFit);
    $('memory-enabled').checked = Boolean(settings.memoryEnabled);
    setValue('memory-max', settings.memoryMaxEntries);
    setValue('memory-context', settings.memoryContextAnswers);
    $('custom-model-wrap').classList.toggle('hidden', settings.model !== 'custom');
    $('voice-custom-model-wrap').classList.toggle('hidden', settings.voiceModel !== 'custom');
    applyTheme(settings.theme);
  }

  function currentSettings() {
    return {
      prompt: $('prompt').value,
      model: $('model').value,
      customModel: $('custom-model').value,
      voiceModel: $('voice-model').value,
      voiceCustomModel: $('voice-custom-model').value,
      reasoning: $('reasoning').value,
      imageDetail: $('image-detail').value,
      triggerMode: $('trigger-mode').value,
      screenAnswerLanguage: $('screen-answer-language').value,
      analyzeEveryMs: Math.max(1, Number($('analyze-every').value || 15)) * 1000,
      resultPollMs: Math.max(250, Number($('result-poll').value || 1000)),
      maxImageWidth: Math.max(0, Number($('max-image-width').value || 0)),
      resultFontSizePx: Math.max(9, Number($('result-font-size').value || 13)),
      resultLayout: $('result-layout').value,
      theme: $('theme').value,
      skipUnchanged: $('skip-unchanged').checked,
      resultAutoFit: $('result-autofit').checked,
      memoryEnabled: $('memory-enabled').checked,
      memoryMaxEntries: Math.max(0, Number($('memory-max').value || 0)),
      memoryContextAnswers: Math.max(0, Number($('memory-context').value || 0)),
      sourceDisplayId: $('source-display').value || '',
      resultDisplayId: $('result-display').value || '',
      previousResultDisplayId: $('previous-result-display').value || '',
      voiceResultDisplayId: $('voice-result-display').value || '',
      combinedResultDisplayId: $('combined-result-display').value || '',
      voicePrompt: $('voice-prompt').value,
      voiceTurnDetection: $('voice-turn-detection').value,
      voiceTranscriptionDelay: $('voice-transcription-delay').value,
      voiceAudioDeviceId: $('voice-audio-device').value || '',
      voiceFontSizePx: Math.max(10, Number($('voice-font-size').value || 16)),
      voiceAnswerLanguage: $('voice-answer-language').value,
      voiceScreenContextEnabled: $('voice-screen-context-enabled').checked,
      voiceMemoryEnabled: $('voice-memory-enabled').checked,
      voiceMemoryContextAnswers: Math.max(0, Number($('voice-memory-context').value || 0))
    };
  }

  async function saveSettings(showStatus = true, statusMessage = 'Settings saved locally.') {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(currentSettings())
    });
    if (!response.ok) throw new Error('Could not save settings.');
    const data = await response.json();
    if (showStatus) setControlStatus(statusMessage, 'ready');
    applySettings(data.settings, true);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveSettings(false).catch((error) => setControlStatus(error.message, 'error')), 500);
  }

  function setControlStatus(text, kind = '') {
    const element = $('control-status');
    element.textContent = text;
    element.className = `inline-status ${kind}`;
  }

  function pcm16(samples) {
    const output = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.max(-1, Math.min(1, samples[index]));
      output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    return output;
  }

  function resample(samples, sourceRate, targetRate = 24000) {
    if (sourceRate === targetRate) return samples;
    const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
    const output = new Float32Array(outputLength);
    const ratio = sourceRate / targetRate;
    for (let index = 0; index < output.length; index += 1) {
      const sourcePosition = Math.min(samples.length - 1, index * ratio);
      const left = Math.floor(sourcePosition);
      const right = Math.min(samples.length - 1, left + 1);
      const fraction = sourcePosition - left;
      output[index] = samples[left] + (samples[right] - samples[left]) * fraction;
    }
    return output;
  }

  function audioRms(samples) {
    let total = 0;
    for (let index = 0; index < samples.length; index += 1) total += samples[index] * samples[index];
    return Math.sqrt(total / Math.max(1, samples.length));
  }

  function voicePauseMs() {
    return VOICE_PAUSE_MS[state?.settings?.voiceTurnDetection] || VOICE_PAUSE_MS['semantic-auto'];
  }

  function createVoiceVad() {
    return {
      active: false,
      committing: false,
      sentAudio: false,
      speechMs: 0,
      lastSpeechAt: 0,
      noiseFloor: VOICE_THRESHOLD / 3,
      preroll: [],
      prerollMs: 0
    };
  }

  function sendVoiceAudioChunk(audio) {
    if (!audio?.byteLength) return false;
    const sent = Boolean(window.monitorApp?.voice?.sendAudio?.(audio));
    if (sent && voiceVad) voiceVad.sentAudio = true;
    return sent;
  }

  function commitVoiceTurn() {
    if (voiceCommitPromise) return voiceCommitPromise;
    const vad = voiceVad;
    if (!vad?.sentAudio) return Promise.resolve(false);
    vad.committing = true;
    vad.active = false;
    const promise = (async () => {
      try {
        return Boolean(await window.monitorApp?.voice?.commit?.());
      } catch {
        return false;
      } finally {
        if (voiceVad === vad) {
          vad.committing = false;
          vad.sentAudio = false;
          vad.speechMs = 0;
          vad.lastSpeechAt = 0;
          vad.preroll = [];
          vad.prerollMs = 0;
        }
      }
    })();
    voiceCommitPromise = promise;
    void promise.then(() => {
      if (voiceCommitPromise === promise) voiceCommitPromise = null;
    });
    return promise;
  }

  function handleVoiceChunk(input, audio, durationMs) {
    const vad = voiceVad;
    if (!vad || vad.committing) return;

    const level = audioRms(input);
    const now = performance.now();
    const threshold = Math.max(VOICE_THRESHOLD, vad.noiseFloor * 3.2);
    const voiced = level > threshold;
    if (level < threshold) vad.noiseFloor = vad.noiseFloor * 0.96 + level * 0.04;

    if (!vad.active) {
      vad.preroll.push({ audio, durationMs });
      vad.prerollMs += durationMs;
      while (vad.preroll.length > 1 && vad.prerollMs > VOICE_PREROLL_MS) {
        vad.prerollMs -= vad.preroll.shift().durationMs;
      }
      vad.speechMs = voiced ? vad.speechMs + durationMs : 0;
      if (vad.speechMs >= VOICE_START_MS) {
        vad.active = true;
        vad.lastSpeechAt = now;
        for (const chunk of vad.preroll) sendVoiceAudioChunk(chunk.audio);
        vad.preroll = [];
        vad.prerollMs = 0;
        vad.speechMs = 0;
      }
      return;
    }

    sendVoiceAudioChunk(audio);
    if (voiced) {
      vad.lastSpeechAt = now;
      return;
    }
    if (now - vad.lastSpeechAt >= voicePauseMs()) void commitVoiceTurn();
  }

  async function stopVoiceCapture() {
    voiceWanted = false;
    voiceCaptureGeneration += 1;
    await commitVoiceTurn();
    const capture = voiceCapture;
    voiceCapture = null;
    if (capture) {
      capture.processor.onaudioprocess = null;
      capture.source.disconnect();
      capture.processor.disconnect();
      capture.silent.disconnect();
      for (const track of capture.stream.getTracks()) track.stop();
      await capture.audioContext.close().catch(() => {});
    }
    voiceVad = null;
    const stopSession = window.monitorApp?.voice?.stop;
    if (stopSession) await stopSession().catch(() => {});
  }

  async function startVoiceCapture() {
    if (voiceCapture) return;
    if (voiceCapturePromise) return voiceCapturePromise;
    voiceWanted = true;
    const generation = ++voiceCaptureGeneration;
    voiceCapturePromise = (async () => {
      if (!window.monitorApp?.voice || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone capture is not available in this app window.');
      }
      const requestedDeviceId = $('voice-audio-device')?.value || '';
      const audio = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
      if (requestedDeviceId) audio.deviceId = { exact: requestedDeviceId };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (error) {
        if (!requestedDeviceId || !['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
        setValue('voice-audio-device', '');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      }
      audioDevicesLoaded = false;
      void refreshAudioDevices(requestedDeviceId);
      let audioContext;
      let source;
      let processor;
      let silent;
      try {
        const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextImpl) throw new Error('This app window does not support microphone audio.');
        audioContext = new AudioContextImpl({ sampleRate: 24000 });
        await audioContext.resume();
        if (generation !== voiceCaptureGeneration || !voiceWanted) {
          for (const track of stream.getTracks()) track.stop();
          await audioContext.close().catch(() => {});
          return;
        }
        const session = await window.monitorApp.voice.start();
        if (session?.error) throw new Error(session.error);
        if (generation !== voiceCaptureGeneration || !voiceWanted) {
          for (const track of stream.getTracks()) track.stop();
          await audioContext.close().catch(() => {});
          await window.monitorApp.voice.stop().catch(() => {});
          return;
        }
        voiceVad = createVoiceVad();
        source = audioContext.createMediaStreamSource(stream);
        if (!audioContext.createScriptProcessor) throw new Error('This app window does not support microphone processing.');
        processor = audioContext.createScriptProcessor(2048, 1, 1);
        silent = audioContext.createGain();
        silent.gain.value = 0;
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          const ready = resample(input, audioContext.sampleRate);
          handleVoiceChunk(input, pcm16(ready).buffer, input.length / audioContext.sampleRate * 1000);
        };
        source.connect(processor);
        processor.connect(silent);
        silent.connect(audioContext.destination);
        voiceCapture = { stream, audioContext, source, processor, silent };
      } catch (error) {
        voiceVad = null;
        for (const track of stream.getTracks()) track.stop();
        if (audioContext) await audioContext.close().catch(() => {});
        await window.monitorApp.voice.stop().catch(() => {});
        throw error;
      }
    })().finally(() => {
      voiceCapturePromise = null;
    });
    return voiceCapturePromise;
  }

  async function toggleVoiceCapture() {
    if (voiceCapture || voiceCapturePromise) {
      await stopVoiceCapture();
      return;
    }
    try {
      await startVoiceCapture();
      setControlStatus('Microphone listening. Home or Page Up toggles it.', 'ready');
    } catch (error) {
      setControlStatus(error.message || 'Could not start the microphone.', 'error');
    }
  }

  function renderState(nextState) {
    state = nextState;
    renderDisplays(nextState);
    applySettings(nextState.settings);
    $('api-status').textContent = nextState.apiKeyReady ? '● API key ready' : '● API key not configured';
    $('api-status').classList.toggle('ready', nextState.apiKeyReady);
    const analysisHotkeys = nextState.hotkeys?.analysis?.length ? nextState.hotkeys.analysis.join(' · ') : 'No screen hotkey';
    const voiceHotkeys = nextState.hotkeys?.voice?.length ? nextState.hotkeys.voice.join(' · ') : 'No voice hotkey';
    $('hotkey-pill').textContent = `${analysisHotkeys} · screen · ${voiceHotkeys} · voice · combined follows screen`;
    const triggerModeHelp = {
      click: 'The Analyze button triggers screen analysis. Home and Page Up control voice listening.',
      hotkeys: 'Global screen hotkeys trigger analysis. The Analyze button remains available. Home and Page Up control voice listening.',
      'click-hotkeys': 'The Analyze button and global screen hotkeys trigger analysis. Home and Page Up control voice listening.',
      auto: 'Screen analysis runs automatically at the interval below. Home and Page Up control voice listening.'
    };
    $('trigger-mode-help').textContent = triggerModeHelp[nextState.settings.triggerMode] || triggerModeHelp.click;
    $('voice-help').textContent = nextState.settings.voiceScreenContextEnabled
      ? 'Home or Page Up toggles the microphone. A natural pause ends the sentence, then separate voice and combined answers appear. End and Page Down refresh the screen context used by the combined answer.'
      : 'Home or Page Up toggles the microphone. A natural pause ends the sentence, then the answer appears on the voice display. Screen context is off, so voice questions stay text-only.';
    const status = nextState.status || 'ready';
    $('output-status').textContent = status;
    $('output-status').className = `status-pill ${status === 'error' ? 'error' : status === 'analyzing' || status === 'capturing' ? 'analyzing' : 'ready'}`;
    $('output-status-text').textContent = status;
    $('control-status').textContent = nextState.error || (nextState.monitoring ? 'Monitoring armed.' : 'Monitoring stopped.');
    $('control-status').className = `inline-status ${nextState.error ? 'error' : ''}`;
    $('latest-answer').textContent = nextState.result || (nextState.error || 'No analysis yet.');
    $('completed-at').textContent = nextState.completedAt ? `Last completed ${new Date(nextState.completedAt).toLocaleString()}` : 'Waiting for the first analysis.';
    $('last-image-size').textContent = nextState.lastImageBytes ? `${(nextState.lastImageBytes / 1048576).toFixed(1)} MB` : '—';
    $('last-trigger').textContent = nextState.lastTrigger || '—';
    const memory = nextState.memory || {};
    $('memory-count').textContent = `${memory.count || 0} memories${memory.screenshotSaved ? ' · screenshot saved' : ''}`;
    const voice = nextState.voice || {};
    const voiceLabels = {
      unavailable: 'Voice unavailable',
      off: 'Microphone off',
      connecting: 'Connecting…',
      on: 'Microphone on',
      speaking: 'Listening…',
      transcribing: 'Transcribing…',
      translating: 'Translating…',
      thinking: 'Answering…',
      error: 'Voice error'
    };
    $('voice-status').textContent = voice.error || voiceLabels[voice.status] || 'Microphone off';
    $('voice-status').className = `status-pill ${voice.error || voice.status === 'error' ? 'error' : ['connecting', 'speaking', 'transcribing', 'translating', 'thinking'].includes(voice.status) ? 'analyzing' : 'ready'}`;
    $('voice-enable').textContent = voice.enabled ? 'Stop listening' : 'Enable microphone';
    $('voice-enable').disabled = !nextState.apiKeyReady || !window.monitorApp?.voice;
    $('voice-hotkey').textContent = `${voiceHotkeys} · voice · combined follows screen`;
    $('stop-monitoring').textContent = nextState.monitoring ? 'Stop monitoring' : 'Start monitoring';
    if (voice.enabled && !voiceCapture && !voiceCapturePromise) {
      void startVoiceCapture().catch((error) => setControlStatus(error.message || 'Could not start the microphone.', 'error'));
    } else if (!voice.enabled && (voiceCapture || voiceCapturePromise)) {
      void stopVoiceCapture();
    }
  }

  async function poll() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (response.ok) renderState(await response.json());
    } catch (error) {
      setControlStatus('Local app is offline.', 'error');
    } finally {
      setTimeout(poll, 1000);
    }
  }

  async function post(path, body = {}) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Request failed.');
    return response.json();
  }

  async function loadMemory() {
    const response = await fetch('/api/memory', { cache: 'no-store' });
    memoryData = await response.json();
    const list = $('memory-list');
    list.replaceChildren();
    if (!memoryData.entries?.length) {
      list.textContent = 'No saved memory yet.';
      return;
    }
    for (const entry of memoryData.entries) {
      const article = document.createElement('article');
      article.className = 'memory-entry';
      const header = document.createElement('header');
      header.innerHTML = `<span>${entry.kind} · ${new Date(entry.createdAt).toLocaleString()}</span><button class="danger-button" data-delete-memory="${entry.id}" type="button">Delete</button>`;
      const text = document.createElement('p');
      text.textContent = entry.answer || entry.transcript || '';
      article.append(header, text);
      list.appendChild(article);
    }
  }

  function bind() {
    for (const id of ['prompt', 'model', 'custom-model', 'voice-model', 'voice-custom-model', 'reasoning', 'image-detail', 'trigger-mode', 'screen-answer-language', 'analyze-every', 'result-poll', 'max-image-width', 'result-font-size', 'result-layout', 'theme', 'skip-unchanged', 'result-autofit', 'memory-enabled', 'memory-max', 'memory-context', 'source-display', 'result-display', 'previous-result-display', 'voice-result-display', 'combined-result-display', 'voice-screen-context-enabled', 'voice-prompt', 'voice-turn-detection', 'voice-transcription-delay', 'voice-audio-device', 'voice-font-size', 'voice-answer-language', 'voice-memory-enabled', 'voice-memory-context']) {
      $(id).addEventListener('input', () => {
        if (id === 'model') $('custom-model-wrap').classList.toggle('hidden', $('model').value !== 'custom');
        if (id === 'voice-model') $('voice-custom-model-wrap').classList.toggle('hidden', $('voice-model').value !== 'custom');
        if (id === 'theme') applyTheme($('theme').value);
        scheduleSave();
      });
      $(id).addEventListener('change', scheduleSave);
    }
    $('save-settings').addEventListener('click', () => void saveSettings(true).catch((error) => setControlStatus(error.message, 'error')));
    $('save-voice-settings').addEventListener('click', () => void saveSettings(true, 'Voice settings saved locally.').catch((error) => setControlStatus(error.message, 'error')));
    window.monitorApp?.voice?.onToggleRequested?.(() => void toggleVoiceCapture());
    $('analyze-now').addEventListener('click', async () => {
      try {
        await saveSettings(false);
        await post('/api/analyze', { reason: 'button' });
        setControlStatus('Screenshot captured. Analyzing…');
      } catch (error) { setControlStatus(error.message, 'error'); }
    });
    $('voice-enable').addEventListener('click', () => void toggleVoiceCapture());
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      audioDevicesLoaded = false;
      void refreshAudioDevices($('voice-audio-device')?.value || '');
    });
    $('stop-monitoring').addEventListener('click', async () => {
      try {
        await post(state?.monitoring ? '/api/stop' : '/api/start');
        setControlStatus(state?.monitoring ? 'Monitoring stopped.' : 'Monitoring armed.');
      } catch (error) { setControlStatus(error.message, 'error'); }
    });
    $('refresh-displays').addEventListener('click', () => {
      lastDisplaySignature = '';
      void fetch('/api/displays', { cache: 'no-store' }).then((response) => response.json()).then((data) => renderDisplays({ displays: data.displays, settings: data.settings || currentSettings() }));
    });
    $('view-memory').addEventListener('click', async () => {
      await loadMemory();
      $('memory-dialog').showModal();
    });
    $('close-memory').addEventListener('click', () => $('memory-dialog').close());
    $('clear-memory').addEventListener('click', async () => {
      if (!window.confirm('Clear the saved answers and latest screenshot?')) return;
      try { await post('/api/memory/clear'); setControlStatus('Local memory cleared.', 'ready'); } catch (error) { setControlStatus(error.message, 'error'); }
    });
    $('memory-list').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-delete-memory]');
      if (!button) return;
      await post('/api/memory/delete', { id: button.dataset.deleteMemory });
      await loadMemory();
    });
  }

  bind();
  void refreshAudioDevices();
  poll();
})();

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
        value: String(display.captureNumber),
        label: `${display.label} · D${display.captureNumber} · ${display.width}×${display.height}${display.isPrimary ? ' · primary' : ''}`
      }));
      setSelectOptions($('source-display'), options, nextState.settings.sourceDisplayNumber);
      const resultOptions = (nextState.displays || []).map((display) => ({
        value: String(display.id),
        label: `${display.label} · D${display.captureNumber} · ${display.width}×${display.height}`
      }));
      setSelectOptions($('result-display'), resultOptions, nextState.settings.resultDisplayId);
      setSelectOptions($('voice-result-display'), resultOptions, nextState.settings.voiceResultDisplayId);
    }
    const voiceDisplay = $('voice-result-display');
    if (voiceDisplay && document.activeElement !== voiceDisplay && nextState.settings.voiceResultDisplayId) {
      voiceDisplay.value = String(nextState.settings.voiceResultDisplayId);
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
    setValue('reasoning', settings.reasoning);
    setValue('image-detail', settings.imageDetail);
    setValue('trigger-mode', settings.triggerMode);
    setValue('analyze-every', Math.round(settings.analyzeEveryMs / 1000));
    setValue('result-poll', settings.resultPollMs);
    setValue('max-image-width', settings.maxImageWidth);
    setValue('result-font-size', settings.resultFontSizePx);
    setValue('result-layout', settings.resultLayout);
    setValue('theme', settings.theme);
    if (force || document.activeElement !== $('voice-prompt')) setValue('voice-prompt', settings.voicePrompt);
    setValue('voice-turn-detection', settings.voiceTurnDetection);
    setValue('voice-transcription-delay', settings.voiceTranscriptionDelay);
    $('skip-unchanged').checked = Boolean(settings.skipUnchanged);
    $('result-autofit').checked = Boolean(settings.resultAutoFit);
    $('memory-enabled').checked = Boolean(settings.memoryEnabled);
    setValue('memory-max', settings.memoryMaxEntries);
    setValue('memory-context', settings.memoryContextAnswers);
    $('custom-model-wrap').classList.toggle('hidden', settings.model !== 'custom');
    applyTheme(settings.theme);
  }

  function currentSettings() {
    return {
      prompt: $('prompt').value,
      model: $('model').value,
      customModel: $('custom-model').value,
      reasoning: $('reasoning').value,
      imageDetail: $('image-detail').value,
      triggerMode: $('trigger-mode').value,
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
      sourceDisplayNumber: Number($('source-display').value || 1),
      resultDisplayId: $('result-display').value || '',
      voiceResultDisplayId: $('voice-result-display').value || '',
      voicePrompt: $('voice-prompt').value,
      voiceTurnDetection: $('voice-turn-detection').value,
      voiceTranscriptionDelay: $('voice-transcription-delay').value
    };
  }

  async function saveSettings(showStatus = true) {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(currentSettings())
    });
    if (!response.ok) throw new Error('Could not save settings.');
    const data = await response.json();
    if (showStatus) setControlStatus('Settings saved locally.', 'ready');
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

  async function stopVoiceCapture() {
    voiceWanted = false;
    voiceCaptureGeneration += 1;
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
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
        source = audioContext.createMediaStreamSource(stream);
        if (!audioContext.createScriptProcessor) throw new Error('This app window does not support microphone processing.');
        processor = audioContext.createScriptProcessor(2048, 1, 1);
        silent = audioContext.createGain();
        silent.gain.value = 0;
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          const ready = resample(input, audioContext.sampleRate);
          window.monitorApp.voice.sendAudio(pcm16(ready).buffer);
        };
        source.connect(processor);
        processor.connect(silent);
        silent.connect(audioContext.destination);
        voiceCapture = { stream, audioContext, source, processor, silent };
      } catch (error) {
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
      setControlStatus('Microphone listening. Page Down toggles it.', 'ready');
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
    $('hotkey-pill').textContent = `${analysisHotkeys} · screen · ${voiceHotkeys} · voice`;
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
      thinking: 'Answering…',
      error: 'Voice error'
    };
    $('voice-status').textContent = voice.error || voiceLabels[voice.status] || 'Microphone off';
    $('voice-status').className = `status-pill ${voice.error || voice.status === 'error' ? 'error' : ['connecting', 'speaking', 'transcribing', 'thinking'].includes(voice.status) ? 'analyzing' : 'ready'}`;
    $('voice-enable').textContent = voice.enabled ? 'Stop listening' : 'Enable microphone';
    $('voice-enable').disabled = !nextState.apiKeyReady || !window.monitorApp?.voice;
    $('voice-hotkey').textContent = `${voiceHotkeys} · voice`;
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
    for (const id of ['prompt', 'model', 'custom-model', 'reasoning', 'image-detail', 'trigger-mode', 'analyze-every', 'result-poll', 'max-image-width', 'result-font-size', 'result-layout', 'theme', 'skip-unchanged', 'result-autofit', 'memory-enabled', 'memory-max', 'memory-context', 'source-display', 'result-display', 'voice-result-display', 'voice-prompt', 'voice-turn-detection', 'voice-transcription-delay']) {
      $(id).addEventListener('input', () => {
        if (id === 'model') $('custom-model-wrap').classList.toggle('hidden', $('model').value !== 'custom');
        if (id === 'theme') applyTheme($('theme').value);
        scheduleSave();
      });
      $(id).addEventListener('change', scheduleSave);
    }
    $('save-settings').addEventListener('click', () => void saveSettings(true).catch((error) => setControlStatus(error.message, 'error')));
    $('analyze-now').addEventListener('click', async () => {
      try {
        await saveSettings(false);
        await post('/api/analyze', { reason: 'button' });
        setControlStatus('Screenshot captured. Analyzing…');
      } catch (error) { setControlStatus(error.message, 'error'); }
    });
    $('voice-enable').addEventListener('click', () => void toggleVoiceCapture());
    $('stop-monitoring').addEventListener('click', async () => {
      try {
        await post(state?.monitoring ? '/api/stop' : '/api/start');
        setControlStatus(state?.monitoring ? 'Monitoring stopped.' : 'Monitoring armed.');
      } catch (error) { setControlStatus(error.message, 'error'); }
    });
    $('refresh-displays').addEventListener('click', () => {
      lastDisplaySignature = '';
      void fetch('/api/displays', { cache: 'no-store' }).then((response) => response.json()).then((data) => renderDisplays({ displays: data.displays, settings: currentSettings() }));
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
  poll();
})();

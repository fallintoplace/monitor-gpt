(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let state = null;
  let lastDisplaySignature = '';
  let lastSettingsSignature = '';
  let saveTimer = null;
  let memoryData = null;

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
    if (signature === lastDisplaySignature) return;
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
      resultDisplayId: $('result-display').value || ''
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

  function renderState(nextState) {
    state = nextState;
    renderDisplays(nextState);
    applySettings(nextState.settings);
    $('api-status').textContent = nextState.apiKeyReady ? '● API key ready' : '● API key not configured';
    $('api-status').classList.toggle('ready', nextState.apiKeyReady);
    const hotkeys = nextState.hotkeys?.analysis?.length ? nextState.hotkeys.analysis.join(' · ') : 'No global hotkey registered';
    $('hotkey-pill').textContent = hotkeys;
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
    $('voice-status').textContent = nextState.voice?.error
      || (nextState.voice?.status === 'unavailable'
        ? 'Voice capture unavailable'
        : nextState.voice?.status === 'on' ? 'Microphone on' : 'Microphone off');
    $('stop-monitoring').textContent = nextState.monitoring ? 'Stop monitoring' : 'Start monitoring';
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
    for (const id of ['prompt', 'model', 'custom-model', 'reasoning', 'image-detail', 'trigger-mode', 'analyze-every', 'result-poll', 'max-image-width', 'result-font-size', 'result-layout', 'theme', 'skip-unchanged', 'result-autofit', 'memory-enabled', 'memory-max', 'memory-context', 'source-display', 'result-display']) {
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

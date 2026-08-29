(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let lastAnswer = null;
  let lastTheme = null;
  let lastTranscript = null;
  let lastError = null;

  function statusLabel(voice) {
    if (voice.error) return 'ERROR';
    return ({
      unavailable: 'OFF',
      off: 'OFF',
      connecting: 'CONNECTING',
      on: 'READY',
      speaking: 'LISTENING',
      transcribing: 'TRANSCRIBING',
      thinking: 'ANSWERING',
      error: 'ERROR'
    })[voice.status] || 'OFF';
  }

  function applyTheme(settings) {
    const theme = settings?.theme || 'light';
    if (theme === lastTheme) return;
    document.body.dataset.theme = theme;
    lastTheme = theme;
  }

  function renderAnswer(answer) {
    const target = $('voice-answer');
    if (!answer) {
      target.textContent = 'Your voice answer will appear here.';
      return;
    }
    if (window.renderMonitorMarkdown) window.renderMonitorMarkdown(answer, target);
    else target.textContent = answer;
  }

  function renderState(state) {
    const voice = state.voice || {};
    window.__voicePollMs = state.settings?.resultPollMs || 1000;
    applyTheme(state.settings);
    const label = statusLabel(voice);
    const status = $('voice-result-status');
    status.className = `status-pill ${voice.error || voice.status === 'error' ? 'error' : ['connecting', 'speaking', 'transcribing', 'thinking'].includes(voice.status) ? 'analyzing' : 'ready'}`;
    status.innerHTML = `<span class="status-dot"></span> ${label}`;
    $('voice-display').textContent = `VOICE DISPLAY: ${state.voiceResultDisplay?.label || '—'} · D${state.voiceResultDisplay?.captureNumber || '—'}`;
    const updated = voice.completedAt || voice.updatedAt;
    $('voice-updated').textContent = updated ? `Updated ${new Date(updated).toLocaleTimeString()}` : 'Microphone off';
    $('voice-footer-status').textContent = voice.error || label;

    if (voice.transcript !== lastTranscript) {
      lastTranscript = voice.transcript || '';
      $('voice-transcript').textContent = lastTranscript || 'Say a question and pause naturally.';
    }
    if (voice.answer !== lastAnswer) {
      lastAnswer = voice.answer || '';
      renderAnswer(lastAnswer);
    }
    if (voice.error !== lastError) {
      lastError = voice.error || '';
      $('voice-error').textContent = lastError;
      $('voice-error').classList.toggle('hidden', !lastError);
    }
  }

  async function poll() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (response.ok) renderState(await response.json());
    } catch {
      const status = $('voice-result-status');
      status.className = 'status-pill error';
      status.innerHTML = '<span class="status-dot"></span> OFFLINE';
    } finally {
      const delay = Math.max(250, Number(window.__voicePollMs || 1000));
      window.setTimeout(poll, delay);
    }
  }

  poll();
})();

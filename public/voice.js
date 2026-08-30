(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const view = new URLSearchParams(window.location.search).get('view');
  const memoryView = view === 'memory';
  const combinedView = view === 'combined';
  const voiceStateKey = combinedView ? 'combined' : memoryView ? 'voiceMemory' : 'voice';
  let lastAnswer = null;
  let lastTheme = null;
  let lastTranscript = null;
  let lastError = null;
  let lastHistorySignature = null;
  let lastLatestId = null;
  let lastLiveAnswerState = null;

  function statusLabel(voice) {
    if (voice.error) return 'ERROR';
    return ({
      unavailable: 'OFF',
      off: 'OFF',
      disabled: 'OFF',
      connecting: 'CONNECTING',
      on: 'READY',
      speaking: 'LISTENING',
      transcribing: 'TRANSCRIBING',
      translating: 'TRANSLATING',
      capturing: 'CAPTURING SCREEN',
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

  function applyVoiceFontSize(settings) {
    const configured = Number(settings?.voiceFontSizePx || 16);
    const fontSize = Math.min(28, Math.max(10, Number.isFinite(configured) ? configured : 16));
    document.body.style.setProperty('--voice-font-size', `${fontSize}px`);
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

  function renderTranslating(settings) {
    const target = $('voice-answer');
    target.replaceChildren();
    const loading = document.createElement('span');
    loading.className = 'voice-loading';
    const contextCount = Math.max(0, Number(settings?.voiceMemoryContextAnswers || 0));
    loading.textContent = combinedView
      ? 'Capturing the screen and preparing the answer'
      : memoryView
      ? `Answering with the last ${contextCount} voice turn${contextCount === 1 ? '' : 's'}`
      : 'Answering without voice memory';
    const dots = document.createElement('span');
    dots.className = 'voice-loading-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.textContent = '…';
    loading.appendChild(dots);
    target.appendChild(loading);
  }

  function voiceHistory(state) {
    return Array.isArray(state[voiceStateKey]?.history)
      ? state[voiceStateKey].history.filter((entry) => entry && entry.answer)
      : [];
  }

  function historySignature(history) {
    return history.map((entry) => [
      entry.id || '',
      entry.createdAt || '',
      entry.transcript || '',
      entry.answer || '',
      entry.sourceLabel || '',
      entry.captureAt || ''
    ].join('\u0002')).join('\u0001');
  }

  function renderHistory(history) {
    const target = $('voice-history');
    target.replaceChildren();
    for (const [index, entry] of history.entries()) {
      const article = document.createElement('article');
      article.className = `voice-turn${index === history.length - 1 ? ' latest' : ''}`;
      const meta = document.createElement('div');
      meta.className = 'voice-turn-meta';
      const time = entry.createdAt ? new Date(entry.createdAt).toLocaleTimeString() : '';
      meta.textContent = [combinedView ? 'Combined answer' : 'Voice answer', time].filter(Boolean).join(' · ');

      if (combinedView) {
        const context = document.createElement('div');
        context.className = 'voice-turn-context';
        const captured = entry.captureAt ? new Date(entry.captureAt).toLocaleTimeString() : '';
        context.textContent = [
          `Screen context: ${entry.sourceLabel || 'Selected source display'}`,
          captured ? `captured ${captured}` : ''
        ].filter(Boolean).join(' · ');
        article.appendChild(context);
      }

      const heard = document.createElement('div');
      heard.className = 'voice-turn-part';
      const heardLabel = document.createElement('p');
      heardLabel.className = 'eyebrow';
      heardLabel.textContent = 'HEARD';
      const transcript = document.createElement('p');
      transcript.className = 'voice-transcript';
      transcript.textContent = entry.transcript || '—';
      heard.append(heardLabel, transcript);

      const answer = document.createElement('div');
      answer.className = 'voice-turn-part voice-turn-answer';
      const answerLabel = document.createElement('p');
      answerLabel.className = 'eyebrow';
      answerLabel.textContent = 'ANSWER';
      const answerContent = document.createElement('div');
      answerContent.className = 'voice-answer';
      if (window.renderMonitorMarkdown) window.renderMonitorMarkdown(entry.answer, answerContent);
      else answerContent.textContent = entry.answer;
      answer.append(answerLabel, answerContent);
      article.append(meta, heard, answer);
      target.appendChild(article);
    }
  }

  function renderState(state) {
    const voice = state[voiceStateKey] || {};
    const history = voiceHistory(state);
    window.__voicePollMs = state.settings?.resultPollMs || 1000;
    applyTheme(state.settings);
    applyVoiceFontSize(state.settings);
    const viewLabel = combinedView
      ? 'LIVE COMBINED · SCREEN + VOICE'
      : memoryView
      ? `LIVE VOICE · LAST ${Math.max(0, Number(state.settings?.voiceMemoryContextAnswers || 0))}`
      : 'LIVE VOICE · NO MEMORY';
    document.title = `Monitor GPT · ${combinedView ? 'Combined' : memoryView ? 'Voice Memory' : 'Voice'}`;
    document.querySelector('.result-label').textContent = viewLabel;
    $('voice-footer-mode').textContent = combinedView
      ? 'COMBINED · HOME TO SHOW'
      : memoryView
      ? 'VOICE MEMORY · PAGE UP TOGGLE'
      : 'VOICE · NO MEMORY · PAGE UP TOGGLE';
    const label = statusLabel(voice);
    const status = $('voice-result-status');
    status.className = `status-pill ${voice.error || voice.status === 'error' ? 'error' : ['connecting', 'speaking', 'transcribing', 'translating', 'capturing', 'thinking'].includes(voice.status) ? 'analyzing' : 'ready'}`;
    status.innerHTML = `<span class="status-dot"></span> ${label}`;
    const display = combinedView ? state.combinedResultDisplay : state.voiceResultDisplay;
    $('voice-display').textContent = `${combinedView ? 'COMBINED DISPLAY' : 'VOICE DISPLAY'}: ${display?.label || '—'} · D${display?.captureNumber || '—'}`;
    const updated = voice.completedAt || voice.updatedAt;
    $('voice-updated').textContent = updated
      ? `Updated ${new Date(updated).toLocaleTimeString()}`
      : combinedView && !state.settings?.voiceScreenContextEnabled ? 'Screen context off' : 'Microphone off';
    $('voice-footer-status').textContent = voice.error || label;

    const context = $('voice-context');
    if (combinedView) {
      const captureTime = voice.captureAt ? new Date(voice.captureAt).toLocaleTimeString() : '';
      context.textContent = state.settings?.voiceScreenContextEnabled
        ? [
          `SCREEN CONTEXT: ${voice.sourceLabel || state.sourceDisplay?.label || 'Selected source display'}`,
          captureTime ? `captured ${captureTime}` : 'waiting for capture'
        ].join(' · ')
        : 'SCREEN CONTEXT OFF · Enable it in the control window to create a combined answer.';
      context.classList.remove('hidden');
    } else {
      context.classList.add('hidden');
    }

    const currentHistorySignature = historySignature(history);
    if (currentHistorySignature !== lastHistorySignature) {
      const scroller = document.scrollingElement;
      const scrollTop = scroller?.scrollTop || 0;
      const latestId = history.at(-1)?.id || '';
      const followLatest = scroller
        ? latestId !== lastLatestId || scroller.scrollHeight - scrollTop - scroller.clientHeight <= 24
        : true;
      renderHistory(history);
      lastHistorySignature = currentHistorySignature;
      lastLatestId = latestId;
      requestAnimationFrame(() => {
        if (!document.scrollingElement) return;
        document.scrollingElement.scrollTop = followLatest
          ? document.scrollingElement.scrollHeight
          : scrollTop;
      });
    }

    if (voice.transcript !== lastTranscript) {
      lastTranscript = voice.transcript || '';
      $('voice-transcript').textContent = lastTranscript || (combinedView
        ? 'Ask about the current screen and pause naturally.'
        : 'Say a question and pause naturally.');
    }
    const loadingState = ['capturing', 'translating', 'thinking'].includes(voice.status);
    const liveAnswerState = loadingState
      ? voice.status
      : `answer:${voice.answer || ''}`;
    if (liveAnswerState !== lastLiveAnswerState) {
      lastLiveAnswerState = liveAnswerState;
      if (loadingState) renderTranslating(state.settings);
      else {
        lastAnswer = voice.answer || '';
        renderAnswer(lastAnswer);
      }
    }
    const latest = history.at(-1);
    const liveIsLatest = Boolean(latest && latest.transcript === voice.transcript && latest.answer === voice.answer);
    const liveActive = ['connecting', 'speaking', 'transcribing', 'capturing', 'translating', 'thinking'].includes(voice.status);
    $('voice-live').classList.toggle('hidden', Boolean(history.length && (!liveActive || liveIsLatest)));
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

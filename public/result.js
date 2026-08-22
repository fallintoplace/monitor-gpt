(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let lastRenderedSignature = null;
  let lastLayoutSignature = null;
  let lastFitSignature = null;
  let lastTheme = null;
  let lastCaptureSignature = null;
  let nextPoll = null;

  function resultText(state) {
    return state.result || '';
  }

  function renderedSignature(state) {
    return [resultText(state), state.error || '', state.voice?.transcript || ''].join('\u0000');
  }

  function layoutSignature(state) {
    return [resultText(state), state.settings?.resultLayout || 'single'].join('\u0000');
  }

  function fitSignature(state) {
    return [
      resultText(state),
      state.settings?.resultLayout || 'single',
      state.settings?.resultFontSizePx || '',
      state.settings?.resultAutoFit ? 'on' : 'off'
    ].join('\u0000');
  }

  function applyTheme(state) {
    const theme = state.settings?.theme || 'light';
    if (theme === lastTheme) return;
    document.body.dataset.theme = theme;
    lastTheme = theme;
  }

  function renderAnswer(state) {
    const text = resultText(state);
    const prose = $('result-prose');
    const code = $('result-code');
    const temporary = document.createElement('div');
    window.renderMonitorMarkdown(text, temporary);
    prose.replaceChildren();
    code.replaceChildren();
    for (const child of [...temporary.children]) {
      if (child.classList.contains('markdown-code')) code.appendChild(child);
      else prose.appendChild(child);
    }
    $('result-empty').classList.toggle('hidden', Boolean(text));
    $('result-error').classList.toggle('hidden', !state.error);
    $('result-error').textContent = state.error || '';
    const hasCode = code.children.length > 0;
    $('big-result').classList.toggle('with-code', hasCode);
    $('big-result').classList.toggle('no-code', !hasCode);
    if (state.voice?.transcript) {
      const voice = document.createElement('p');
      voice.className = 'voice-transcript';
      voice.innerHTML = `<strong>Voice:</strong> ${state.voice.transcript.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`;
      prose.prepend(voice);
    }
  }

  function estimateColumns(state) {
    const layout = state.settings?.resultLayout || 'single';
    const maxColumns = layout === 'five' ? 5 : layout === 'columns' ? 3 : 1;
    if (maxColumns === 1) return 1;
    const proseLength = $('result-prose').textContent.trim().length;
    if (maxColumns === 5) {
      if (proseLength < 1100) return 2;
      if (proseLength < 2600) return 3;
      if (proseLength < 5200) return 4;
      return 5;
    }
    return proseLength < 900 ? 2 : maxColumns;
  }

  function applyResultLayout(state) {
    const root = $('big-result');
    const hasCode = $('result-code').children.length > 0;
    const occupied = estimateColumns(state);
    const textColumns = hasCode ? Math.max(1, occupied - 1) : occupied;
    root.style.setProperty('--prose-columns', String(textColumns));
    root.style.setProperty('--prose-area', hasCode ? `${Math.max(2, occupied - 1)}fr` : '1fr');
    root.classList.toggle('with-code', hasCode);
    root.classList.toggle('no-code', !hasCode);
  }

  function fitAnswer(state) {
    const root = $('big-result');
    const configured = Number(state.settings?.resultFontSizePx || 13);
    root.style.setProperty('--result-font-size', `${configured}px`);
    if (!state.settings?.resultAutoFit) return;
    const available = Math.max(1, window.innerHeight - 165);
    const contentHeight = root.scrollHeight;
    if (contentHeight > available * 1.18 && configured > 9) {
      const ratio = Math.max(.72, available / contentHeight);
      root.style.setProperty('--result-font-size', `${Math.max(9, Math.floor(configured * ratio))}px`);
    }
  }

  function updateCapture(state) {
    const image = $('last-capture');
    if (!state.memory?.screenshotSaved) {
      image.classList.add('hidden');
      return;
    }
    image.classList.remove('hidden');
    $('last-capture-label').textContent = state.memory.latestImage?.sourceLabel || state.sourceDisplay?.label || 'Source display';
    const signature = [state.lastCaptureAt, state.lastImageBytes, state.memory.latestImage?.createdAt].join('|');
    if (signature !== lastCaptureSignature) {
      lastCaptureSignature = signature;
      $('last-capture-image').src = `/api/memory/image?v=${encodeURIComponent(signature)}`;
    }
  }

  function renderState(state) {
    applyTheme(state);
    const status = state.status || 'ready';
    const statusElement = $('result-status');
    statusElement.className = `status-pill ${status === 'error' ? 'error' : status === 'analyzing' || status === 'capturing' ? 'analyzing' : 'ready'}`;
    statusElement.innerHTML = `<span class="status-dot"></span> ${status.toUpperCase()}`;
    $('result-source').textContent = `SOURCE: ${state.sourceDisplay?.label || '—'} · D${state.sourceDisplay?.captureNumber || '—'} · ${state.sourceDisplay?.width || '—'}×${state.sourceDisplay?.height || '—'}`;
    $('result-footer-source').textContent = `SOURCE: ${state.sourceDisplay?.label || '—'} · D${state.sourceDisplay?.captureNumber || '—'} · LAST IMAGE ${state.lastImageBytes ? `${(state.lastImageBytes / 1048576).toFixed(1)} MB` : '—'}`;
    const updated = state.completedAt || state.lastCaptureAt;
    $('result-updated').textContent = updated ? `Updated ${new Date(updated).toLocaleTimeString()}` : 'Waiting for the first screenshot…';

    const renderSig = renderedSignature(state);
    if (renderSig !== lastRenderedSignature) {
      const scrollTop = document.scrollingElement?.scrollTop || 0;
      renderAnswer(state);
      lastRenderedSignature = renderSig;
      requestAnimationFrame(() => { if (document.scrollingElement) document.scrollingElement.scrollTop = scrollTop; });
    }
    const layoutSig = layoutSignature(state);
    if (layoutSig !== lastLayoutSignature) {
      applyResultLayout(state);
      lastLayoutSignature = layoutSig;
    }
    const fitSig = fitSignature(state);
    if (fitSig !== lastFitSignature) {
      fitAnswer(state);
      lastFitSignature = fitSig;
    }
    updateCapture(state);
  }

  async function poll() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (response.ok) renderState(await response.json());
    } catch (error) {
      $('result-status').className = 'status-pill error';
      $('result-status').innerHTML = '<span class="status-dot"></span> OFFLINE';
    } finally {
      const delay = Math.max(250, Number(window.__lastPollMs || 1000));
      nextPoll = window.setTimeout(poll, delay);
    }
  }

  window.addEventListener('resize', () => {
    if (!window.__lastState) return;
    fitAnswer(window.__lastState);
  });
  const originalRenderState = renderState;
  renderState = (state) => {
    window.__lastState = state;
    window.__lastPollMs = state.settings?.resultPollMs || 1000;
    originalRenderState(state);
  };
  poll();
})();

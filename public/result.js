(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const RESULT_VIEW = new URLSearchParams(window.location.search).get('view') === 'previous' ? 'previous' : 'latest';
  const RESULT_VIEW_LABEL = RESULT_VIEW === 'previous' ? 'PREVIOUS SCREEN ANSWER' : 'LATEST SCREEN ANSWER';
  const RESULT_WAITING_MESSAGE = RESULT_VIEW === 'previous'
    ? 'Waiting for a previous screen answer.'
    : 'Waiting for the latest screen answer.';
  let lastRenderedSignature = null;
  let lastLayoutSignature = null;
  let lastFitSignature = null;
  let lastTheme = null;
  let lastCaptureSignature = null;
  let nextPoll = null;

  document.title = `Monitor GPT · ${RESULT_VIEW === 'previous' ? 'Previous Result' : 'Result'}`;
  const resultLabel = document.querySelector('.result-label');
  if (resultLabel) resultLabel.textContent = RESULT_VIEW_LABEL;
  const resultEmpty = $('result-empty');
  if (resultEmpty) resultEmpty.textContent = RESULT_WAITING_MESSAGE;

  function allResultHistory(state) {
    let history;
    if (Array.isArray(state.resultHistory)) {
      history = state.resultHistory.filter((entry) => entry && entry.answer);
    } else {
      history = state.result
        ? [{ id: 'current-result', createdAt: state.completedAt, answer: state.result, sourceLabel: '' }]
        : [];
    }
    return history;
  }

  function resultHistory(state) {
    const history = allResultHistory(state);
    if (RESULT_VIEW === 'previous') {
      return history.length > 1 ? [history[history.length - 2]] : [];
    }
    return history.length ? [history[history.length - 1]] : [];
  }

  function historySignature(state) {
    return resultHistory(state).map((entry) => [
      entry.id || '',
      entry.createdAt || '',
      entry.answer || '',
      entry.sourceLabel || '',
      entry.trigger || ''
    ].join('\u0002')).join('\u0001');
  }

  function renderedSignature(state) {
    return [historySignature(state), state.error || ''].join('\u0000');
  }

  function layoutSignature(state) {
    return [historySignature(state), state.error || '', state.settings?.resultLayout || 'single'].join('\u0000');
  }

  function fitSignature(state) {
    return [
      historySignature(state),
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

  function workspaceColumnCount(state) {
    const layout = state.settings?.resultLayout || 'single';
    const configuredColumns = layout === 'five' ? 5 : layout === 'columns' ? 3 : 1;
    const viewportColumns = window.innerWidth <= 700 ? 1 : window.innerWidth <= 1000 ? 3 : configuredColumns;
    return Math.min(configuredColumns, viewportColumns);
  }

  function renderAnswer(state) {
    const history = resultHistory(state);
    const root = $('big-result');
    root.replaceChildren();
    for (const [index, entry] of history.entries()) {
      const article = document.createElement('article');
      article.className = `conversation-entry${index === history.length - 1 ? ' latest' : ''}`;
      article.dataset.historyId = entry.id || '';

      const meta = document.createElement('div');
      meta.className = 'conversation-meta';
      const source = entry.sourceLabel || 'Screen answer';
      const time = entry.createdAt ? new Date(entry.createdAt).toLocaleTimeString() : '';
      meta.textContent = [source, time].filter(Boolean).join(' · ');

      const prose = document.createElement('div');
      prose.className = 'result-prose';
      const code = document.createElement('aside');
      code.className = 'result-code';
      code.setAttribute('aria-label', 'Code from answer');
      const temporary = document.createElement('div');
      window.renderMonitorMarkdown(entry.answer, temporary);
      for (const child of [...temporary.children]) {
        if (child.classList.contains('markdown-code')) code.appendChild(child);
        else prose.appendChild(child);
      }
      prose.classList.toggle('hidden', prose.textContent.trim().length === 0);
      code.classList.toggle('hidden', code.children.length === 0);
      article.append(meta, prose, code);
      root.appendChild(article);
    }
    $('result-empty').classList.toggle('hidden', history.length > 0);
    $('result-error').classList.toggle('hidden', !state.error);
    $('result-error').textContent = state.error || '';
    const hasCode = root.querySelector('.result-code:not(.hidden) .markdown-code') !== null;
    $('big-result').classList.toggle('with-code', hasCode);
    $('big-result').classList.toggle('no-code', !hasCode);
  }

  function estimateColumns(state, prose, code) {
    const maxColumns = workspaceColumnCount(state);
    if (maxColumns === 1) return 1;
    const proseLength = prose.textContent.trim().length;
    const codeLength = code.textContent.trim().length;
    if (!proseLength && codeLength < 900) return 1;
    if (maxColumns === 5) {
      if (codeLength > 1200) return 5;
      const contentLength = proseLength + Math.round(codeLength * 0.8);
      if (contentLength < 1100) return 2;
      if (contentLength < 2600) return 3;
      if (contentLength < 5200) return 4;
      return 5;
    }
    return proseLength + codeLength < 900 ? 2 : maxColumns;
  }

  function flowCodeAcrossColumns(container, columns) {
    const requestedColumns = Math.max(1, Number(columns) || 1);
    if (container.dataset.flowColumns === String(requestedColumns)) return;
    const directBlocks = [...container.children].filter((child) => child.classList.contains('markdown-code'));
    const blocks = directBlocks.length
      ? directBlocks.map((block) => ({
        language: block.dataset.language || '',
        text: block.querySelector('code')?.textContent || block.textContent || ''
      }))
      : [...container.children]
        .filter((child) => child.classList.contains('code-flow'))
        .map((flow) => ({
          language: flow.querySelector('.markdown-code')?.dataset.language || '',
          text: [...flow.querySelectorAll('code')].map((code) => code.textContent).join('\n')
        }));
    if (!blocks.length) return;

    const lines = blocks.flatMap((block, index) => [
      ...(index ? ['', ''] : []),
      ...block.text.split('\n')
    ]);
    const columnCount = Math.max(1, Math.min(requestedColumns, lines.length));
    const linesPerColumn = Math.ceil(lines.length / columnCount);
    const flow = document.createElement('div');
    flow.className = 'code-flow';
    flow.style.setProperty('--code-columns', String(columnCount));

    container.replaceChildren();
    for (let column = 0; column < columnCount; column += 1) {
      const chunk = document.createElement('pre');
      chunk.className = 'markdown-code';
      chunk.dataset.language = blocks[0].language;
      const code = document.createElement('code');
      const start = column * linesPerColumn;
      code.textContent = lines.slice(start, start + linesPerColumn).join('\n');
      chunk.appendChild(code);
      flow.appendChild(chunk);
    }
    container.appendChild(flow);
    container.dataset.flowColumns = String(requestedColumns);
  }

  function applyEntryLayout(state, entry) {
    const prose = entry.querySelector('.result-prose');
    const code = entry.querySelector('.result-code');
    const hasCode = code.querySelector('.markdown-code') !== null;
    const hasProse = prose.textContent.trim().length > 0;
    const workspaceColumns = workspaceColumnCount(state);
    const occupied = Math.min(workspaceColumns, estimateColumns(state, prose, code));
    let proseColumns = occupied;
    let codeColumns = 0;

    if (hasCode) {
      if (hasProse && occupied > 1) {
        codeColumns = Math.min(2, occupied - 1);
        proseColumns = occupied - codeColumns;
      } else {
        proseColumns = 0;
        codeColumns = occupied;
      }
    }

    entry.style.setProperty('--workspace-columns', String(workspaceColumns));
    entry.style.setProperty('--prose-columns', String(Math.max(1, proseColumns)));
    entry.style.setProperty('--prose-grid-columns', String(Math.max(1, proseColumns)));
    entry.style.setProperty('--code-grid-columns', String(Math.max(1, codeColumns)));
    const contentStart = workspaceColumns - occupied + 1;
    entry.style.setProperty('--prose-grid-start', String(contentStart));
    entry.style.setProperty('--code-grid-start', String(contentStart + (hasCode && hasProse ? proseColumns : 0)));
    if (hasCode) flowCodeAcrossColumns(code, codeColumns);
  }

  function applyResultLayout(state) {
    const root = $('big-result');
    const workspaceColumns = workspaceColumnCount(state);
    root.style.setProperty('--workspace-columns', String(workspaceColumns));
    for (const entry of root.querySelectorAll('.conversation-entry')) applyEntryLayout(state, entry);
    const hasCode = root.querySelector('.result-code:not(.hidden) .markdown-code') !== null;
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
    if (RESULT_VIEW === 'previous' || !state.memory?.screenshotSaved) {
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
    $('result-footer-source').textContent = RESULT_VIEW === 'previous'
      ? 'PREVIOUS ANSWER · SCREENSHOT HIDDEN'
      : `SOURCE: ${state.sourceDisplay?.label || '—'} · D${state.sourceDisplay?.captureNumber || '—'} · LAST IMAGE ${state.lastImageBytes ? `${(state.lastImageBytes / 1048576).toFixed(1)} MB` : '—'}`;
    const displayedEntry = resultHistory(state).at(-1);
    const updated = displayedEntry?.createdAt || (RESULT_VIEW === 'latest' ? state.completedAt : null);
    $('result-updated').textContent = updated ? `Updated ${new Date(updated).toLocaleTimeString()}` : '';

    const renderSig = renderedSignature(state);
    if (renderSig !== lastRenderedSignature) {
      const scroller = document.scrollingElement;
      const scrollTop = scroller?.scrollTop || 0;
      const followLatest = scroller
        ? scroller.scrollHeight - scrollTop - scroller.clientHeight <= 24
        : true;
      renderAnswer(state);
      lastRenderedSignature = renderSig;
      requestAnimationFrame(() => {
        if (!document.scrollingElement) return;
        document.scrollingElement.scrollTop = followLatest
          ? document.scrollingElement.scrollHeight
          : scrollTop;
      });
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
    applyResultLayout(window.__lastState);
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

(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function inline(value) {
    let html = escapeHtml(value);
    const code = [];
    html = html.replace(/`([^`]+)`/g, (_, text) => {
      const token = `@@CODE${code.length}@@`;
      code.push(`<code>${text}</code>`);
      return token;
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    for (let index = 0; index < code.length; index += 1) {
      html = html.replace(`@@CODE${index}@@`, code[index]);
    }
    return html;
  }

  function appendParagraph(parent, lines) {
    if (!lines.length) return;
    const paragraph = document.createElement('p');
    paragraph.innerHTML = lines.map(inline).join('<br>');
    parent.appendChild(paragraph);
  }

  function appendList(parent, items, ordered) {
    if (!items.length) return;
    const list = document.createElement(ordered ? 'ol' : 'ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.innerHTML = inline(item);
      list.appendChild(li);
    }
    parent.appendChild(list);
  }

  function renderMarkdown(markdown, parent) {
    parent.replaceChildren();
    const lines = String(markdown || '').replaceAll('\r\n', '\n').split('\n');
    let paragraph = [];
    let list = [];
    let ordered = false;
    let inCode = false;
    let codeLanguage = '';
    let codeLines = [];

    const flushParagraph = () => {
      appendParagraph(parent, paragraph);
      paragraph = [];
    };
    const flushList = () => {
      appendList(parent, list, ordered);
      list = [];
    };
    const flushCode = () => {
      const pre = document.createElement('pre');
      pre.className = 'markdown-code';
      pre.dataset.language = codeLanguage;
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      parent.appendChild(pre);
      codeLanguage = '';
      codeLines = [];
    };

    for (const line of lines) {
      const fence = line.match(/^\s*```(.*)$/);
      if (fence) {
        if (inCode) {
          flushCode();
          inCode = false;
        } else {
          flushParagraph();
          flushList();
          inCode = true;
          codeLanguage = fence[1].trim();
        }
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const element = document.createElement(`h${Math.min(6, heading[1].length)}`);
        element.innerHTML = inline(heading[2]);
        parent.appendChild(element);
        continue;
      }
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || numbered) {
        flushParagraph();
        const isOrdered = Boolean(numbered);
        if (list.length && ordered !== isOrdered) flushList();
        ordered = isOrdered;
        list.push((bullet || numbered)[1]);
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        flushList();
        const quote = document.createElement('blockquote');
        quote.innerHTML = inline(line.replace(/^\s*>\s?/, ''));
        parent.appendChild(quote);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      flushList();
      paragraph.push(line);
    }
    if (inCode) flushCode();
    flushParagraph();
    flushList();
    return parent;
  }

  window.renderMonitorMarkdown = renderMarkdown;
})();

// Толмач — то, что видно на странице: кнопка у выделения, карточка перевода,
// перевод страницы целиком. Ключа тут нет и быть не может.

(() => {
  if (window.__tolmachLoaded) return;
  window.__tolmachLoaded = true;

  const HOST_ID = 'tolmach-root';
  const MARK_ALT = '@@ALT@@';
  const MARK_NOTE = '@@NOTE@@';

  const LANG_LABEL = { ru: 'русский', en: 'английский', de: 'немецкий', es: 'испанский', fr: 'французский', zh: 'китайский', uk: 'украинский', tr: 'турецкий' };
  const SHORT = { ru: 'RU', en: 'EN', de: 'DE', es: 'ES', fr: 'FR', zh: 'ZH', uk: 'UK', tr: 'TR' };

  const TONE_CHIPS = [
    { id: 'natural', label: 'Естественно' },
    { id: 'literal', label: 'Дословно' },
    { id: 'tweet', label: 'Для твита' },
    { id: 'formal', label: 'Официально' }
  ];

  let settings = { showBubble: true };
  chrome.storage.local.get(['showBubble']).then((s) => Object.assign(settings, s)).catch(() => {});
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.showBubble) settings.showBubble = changes.showBubble.newValue;
  });

  // ——— оболочка ————————————————————————————————————————————————
  // Всё живёт в shadow root: стили страницы не достают до карточки,
  // а наши стили не портят страницу.
  let host = null;
  let shadow = null;

  function ui() {
    if (shadow) return shadow;
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);
    (document.documentElement || document.body).append(host);
    return shadow;
  }

  // Координаты внутри карточки отсчитываются от хоста, а не от документа.
  // Если у страницы спозиционирован <html> или <body>, хост уезжает вместе
  // с ними — поэтому каждый раз меряем, где он оказался, и вычитаем сдвиг.
  function hostOrigin() {
    if (!host) return { x: 0, y: 0 };
    const r = host.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY };
  }

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  // ——— кнопка у выделения ——————————————————————————————————————
  let bubble = null;

  function hideBubble() {
    bubble?.remove();
    bubble = null;
  }

  function showBubble(rect) {
    hideBubble();
    const root = ui();
    bubble = el('button', 'tm-bubble');
    bubble.title = 'Перевести (Alt+T)';
    bubble.innerHTML = ICON_GLYPH;
    const origin = hostOrigin();
    const top = rect.bottom + window.scrollY + 8 - origin.y;
    const left = rect.left + window.scrollX + rect.width / 2 - 18 - origin.x;
    bubble.style.top = `${top}px`;
    bubble.style.left = `${Math.max(8 - origin.x, left)}px`;
    bubble.addEventListener('mousedown', (e) => e.preventDefault());
    bubble.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = String(window.getSelection());
      hideBubble();
      if (text.trim()) openCard(text.trim(), rect);
    });
    root.append(bubble);
  }

  document.addEventListener('mouseup', (e) => {
    if (host && e.composedPath().includes(host)) return;
    if (!settings.showBubble) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = String(sel || '').trim();
      if (!text || text.length > 5000 || sel.rangeCount === 0) {
        hideBubble();
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) {
        hideBubble();
        return;
      }
      showBubble(rect);
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (host && e.composedPath().includes(host)) return;
    hideBubble();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideBubble();
      closeCard();
    }
  });

  // ——— карточка перевода ————————————————————————————————————————
  let card = null;
  let port = null;
  let current = { text: '', tone: null, rect: null };

  function closeCard() {
    port?.disconnect();
    port = null;
    card?.root.remove();
    card = null;
  }

  function placeCard(node, rect) {
    const width = 420;
    const margin = 12;
    const origin = hostOrigin();
    let left = rect ? rect.left + window.scrollX : window.scrollX + 40;
    const top = rect ? rect.bottom + window.scrollY + 10 : window.scrollY + 60;
    const minLeft = window.scrollX + margin;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - width - margin;
    left = Math.min(Math.max(minLeft, left), Math.max(minLeft, maxLeft));
    node.style.left = `${left - origin.x}px`;
    node.style.top = `${top - origin.y}px`;
  }

  function buildCard(rect) {
    const root = ui();
    const box = el('div', 'tm-card');

    const head = el('div', 'tm-head');
    const dir = el('div', 'tm-dir', '…');
    const spinner = el('div', 'tm-spinner');
    const spacer = el('div', 'tm-spacer');
    const close = el('button', 'tm-icon-btn', '✕');
    close.title = 'Закрыть (Esc)';
    close.addEventListener('click', closeCard);
    head.append(dir, spinner, spacer, close);

    const body = el('div', 'tm-body');
    const main = el('div', 'tm-main');
    body.append(main);

    const altWrap = el('div', 'tm-alt hidden');
    const altHead = el('div', 'tm-section-label', 'Другой вариант');
    const altText = el('div', 'tm-alt-text');
    altWrap.append(altHead, altText);
    body.append(altWrap);

    const noteWrap = el('div', 'tm-note hidden');
    body.append(noteWrap);

    const foot = el('div', 'tm-foot');
    const chips = el('div', 'tm-chips');
    TONE_CHIPS.forEach((t) => {
      const chip = el('button', 'tm-chip', t.label);
      chip.dataset.tone = t.id;
      chip.addEventListener('click', () => retranslate(t.id));
      chips.append(chip);
    });
    const copy = el('button', 'tm-copy', 'Копировать');
    copy.addEventListener('click', () => {
      const text = card?.parsed?.main || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(
        () => {
          copy.textContent = 'Скопировано';
          setTimeout(() => (copy.textContent = 'Копировать'), 1400);
        },
        () => {
          copy.textContent = 'Не вышло';
          setTimeout(() => (copy.textContent = 'Копировать'), 1400);
        }
      );
    });
    foot.append(chips, copy);

    box.append(head, body, foot);
    placeCard(box, rect);
    root.append(box);

    return { root: box, dir, spinner, main, altWrap, altText, noteWrap, chips, copy, parsed: null };
  }

  function parseStream(raw) {
    let rest = raw;
    let note = '';
    let alt = '';
    const noteAt = rest.indexOf(MARK_NOTE);
    if (noteAt !== -1) {
      note = rest.slice(noteAt + MARK_NOTE.length).trim();
      rest = rest.slice(0, noteAt);
    }
    const altAt = rest.indexOf(MARK_ALT);
    if (altAt !== -1) {
      alt = rest.slice(altAt + MARK_ALT.length).trim();
      rest = rest.slice(0, altAt);
    }
    // Пока маркер печатается посимвольно, его обрывок не должен мелькать в тексте.
    rest = rest.replace(/@[@A-Z]*$/, '');
    return { main: rest.trim(), alt, note };
  }

  function render(parsed) {
    if (!card) return;
    card.parsed = parsed;
    card.main.textContent = parsed.main;
    card.altWrap.classList.toggle('hidden', !parsed.alt);
    card.altText.textContent = parsed.alt;
    card.noteWrap.classList.toggle('hidden', !parsed.note);
    if (parsed.note) {
      card.noteWrap.textContent = '';
      parsed.note
        .split('\n')
        .map((l) => l.replace(/^[-•*]\s*/, '').trim())
        .filter(Boolean)
        .forEach((line) => card.noteWrap.append(el('div', 'tm-note-line', line)));
    }
  }

  function showError(message, kind) {
    if (!card) return;
    card.spinner.classList.add('hidden');
    card.main.textContent = '';
    const box = el('div', 'tm-error');
    box.append(el('div', null, message));
    if (kind === 'nokey' || kind === 'auth') {
      const link = el('button', 'tm-link', 'Открыть настройки');
      link.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-options' }).catch(() => {}));
      box.append(link);
    }
    card.main.append(box);
  }

  function retranslate(tone) {
    if (!current.text) return;
    current.tone = tone;
    startTranslate(current.text, current.rect, tone);
  }

  function openCard(text, rect) {
    current = { text, tone: null, rect };
    closeCard();
    card = buildCard(rect);
    startTranslate(text, rect, null);
  }

  function startTranslate(text, rect, tone) {
    if (!card) card = buildCard(rect);
    card.spinner.classList.remove('hidden');
    card.main.textContent = '';
    card.altWrap.classList.add('hidden');
    card.noteWrap.classList.add('hidden');
    card.chips.querySelectorAll('.tm-chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.tone === tone);
    });

    port?.disconnect();
    try {
      port = chrome.runtime.connect({ name: 'tolmach' });
    } catch {
      showError('Расширение обновилось — перезагрузи страницу.', 'reload');
      return;
    }

    port.onDisconnect.addListener(() => {
      port = null;
    });

    port.onMessage.addListener((msg) => {
      if (!card) return;
      if (msg.type === 'start') {
        card.dir.textContent = `${SHORT[msg.from] || '?'} → ${SHORT[msg.to] || '?'}`;
        card.dir.title = `Перевод на ${LANG_LABEL[msg.to] || msg.to}`;
      } else if (msg.type === 'delta') {
        render(parseStream(msg.full));
      } else if (msg.type === 'done') {
        card.spinner.classList.add('hidden');
        render(parseStream(msg.raw));
        card.dir.textContent = `${SHORT[msg.from] || '?'} → ${SHORT[msg.to] || '?'}`;
      } else if (msg.type === 'error') {
        showError(msg.message, msg.kind);
      }
    });

    port.postMessage({ type: 'translate', text, tone });
  }

  // ——— перевод всей страницы ————————————————————————————————————
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'CANVAS', 'IFRAME', 'MATH'
  ]);
  const MAX_SEGMENTS = 1200;

  let pageNodes = [];      // соответствие индекс → текстовый узел
  let pageOriginals = [];  // исходный текст для «вернуть оригинал»
  let pagePort = null;

  function collectTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue;
        if (!text || text.trim().length < 2) return NodeFilter.FILTER_REJECT;
        // Числа, знаки и одинокие символы переводить нечего.
        if (!/[\p{L}]{2}/u.test(text)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`#${HOST_ID}`)) return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[translate="no"], .notranslate')) return NodeFilter.FILTER_REJECT;
        // Невидимое переводить бессмысленно и дорого.
        const rects = parent.getClientRects();
        if (!rects.length) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode()) && nodes.length < MAX_SEGMENTS) nodes.push(node);
    return nodes;
  }

  let toast = null;

  function showToast() {
    const root = ui();
    toast?.root.remove();
    const box = el('div', 'tm-toast');
    const label = el('div', 'tm-toast-label', 'Читаю страницу…');
    const bar = el('div', 'tm-bar');
    const fill = el('div', 'tm-bar-fill');
    bar.append(fill);
    const btn = el('button', 'tm-toast-btn', 'Отмена');
    box.append(label, bar, btn);
    root.append(box);
    toast = { root: box, label, fill, btn };
    return toast;
  }

  function restorePage() {
    pageNodes.forEach((node, i) => {
      if (node && pageOriginals[i] != null) node.nodeValue = pageOriginals[i];
    });
    pageNodes = [];
    pageOriginals = [];
    toast?.root.remove();
    toast = null;
  }

  function translatePage() {
    if (pagePort) return; // уже идёт
    if (pageNodes.length) {
      restorePage();
      return;
    }

    const nodes = collectTextNodes();
    if (!nodes.length) {
      const t = showToast();
      t.label.textContent = 'На странице не нашлось текста для перевода.';
      t.fill.style.width = '100%';
      t.btn.textContent = 'Закрыть';
      t.btn.onclick = () => {
        toast?.root.remove();
        toast = null;
      };
      return;
    }

    pageNodes = nodes;
    pageOriginals = nodes.map((n) => n.nodeValue);

    const t = showToast();
    t.label.textContent = `Перевожу ${nodes.length} фрагментов…`;
    t.btn.onclick = () => {
      pagePort?.disconnect();
      pagePort = null;
      restorePage();
    };

    try {
      pagePort = chrome.runtime.connect({ name: 'tolmach' });
    } catch {
      t.label.textContent = 'Расширение обновилось — перезагрузи страницу.';
      return;
    }

    pagePort.onDisconnect.addListener(() => {
      pagePort = null;
    });

    pagePort.onMessage.addListener((msg) => {
      if (msg.type === 'page-start') {
        t.label.textContent = `Перевожу на ${LANG_LABEL[msg.to] || msg.to}…`;
      } else if (msg.type === 'page-chunk') {
        msg.items.forEach(({ index, text }) => {
          const node = pageNodes[index];
          if (node && node.isConnected) node.nodeValue = text;
        });
        t.fill.style.width = `${Math.round((msg.done / msg.total) * 100)}%`;
      } else if (msg.type === 'page-done') {
        pagePort?.disconnect();
        pagePort = null;
        t.fill.style.width = '100%';
        t.label.textContent = msg.failures
          ? `Готово, но ${msg.failures} из ${msg.total} пачек не перевелись.`
          : 'Готово.';
        t.btn.textContent = 'Вернуть оригинал';
        t.btn.onclick = restorePage;
      } else if (msg.type === 'error') {
        pagePort?.disconnect();
        pagePort = null;
        t.label.textContent = msg.message;
        t.btn.textContent = 'Закрыть';
        t.btn.onclick = () => {
          restorePage();
        };
      }
    });

    pagePort.postMessage({
      type: 'page',
      segments: nodes.map((n) => ({ text: n.nodeValue }))
    });
  }

  // ——— команды снаружи ——————————————————————————————————————————
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'translate-selection') {
      const sel = window.getSelection();
      const text = String(sel || '').trim();
      if (!text) {
        sendResponse?.({ ok: false });
        return;
      }
      const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      hideBubble();
      openCard(text, rect);
      sendResponse?.({ ok: true });
    } else if (msg.type === 'translate-page') {
      translatePage();
      sendResponse?.({ ok: true });
    } else if (msg.type === 'get-selection') {
      sendResponse?.({ text: String(window.getSelection() || '').trim() });
    }
    return false;
  });

  // ——— стили и иконка ————————————————————————————————————————————
  const ICON_GLYPH =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h10M9 3v2c0 4.5-2.2 8-5 10"/><path d="M6 10c1.5 2.6 4 4.7 7 5.7"/><path d="M12 21l4.5-11L21 21"/><path d="M14.2 17.5h5.6"/></svg>';

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

.tm-bubble {
  position: absolute;
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  border: 1px solid rgba(0,0,0,.12);
  background: #1f8a4c;
  color: #ffffff;
  cursor: pointer;
  /* Двойная тень: светлый ободок держит кнопку видимой на тёмных сайтах,
     мягкая тень отделяет её от светлых. */
  box-shadow: 0 0 0 2px rgba(255,255,255,.85), 0 6px 20px rgba(0,0,0,.3);
  z-index: 2147483647;
  transition: transform .12s ease, background .12s ease;
}
.tm-bubble:hover { transform: scale(1.08); background: #23a35c; }

.tm-card {
  position: absolute;
  width: 420px;
  max-width: calc(100vw - 24px);
  background: #fbfaf8;
  color: #17171a;
  border: 1px solid rgba(0,0,0,.1);
  border-radius: 14px;
  box-shadow: 0 18px 48px rgba(0,0,0,.22);
  font: 400 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif;
  z-index: 2147483647;
  overflow: hidden;
}

.tm-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid rgba(0,0,0,.07);
  background: #f3f1ed;
}
.tm-dir {
  font-size: 11px; font-weight: 600; letter-spacing: .08em;
  color: #6b6862; text-transform: uppercase;
}
.tm-spacer { flex: 1; }
.tm-icon-btn {
  border: none; background: none; cursor: pointer;
  color: #8a877f; font-size: 14px; line-height: 1;
  padding: 4px 6px; border-radius: 6px;
}
.tm-icon-btn:hover { background: rgba(0,0,0,.06); color: #17171a; }

.tm-spinner {
  width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid rgba(0,0,0,.15);
  border-top-color: #c96442;
  animation: tm-spin .7s linear infinite;
}
.tm-spinner.hidden { display: none; }
@keyframes tm-spin { to { transform: rotate(360deg); } }

.tm-body { padding: 13px 14px; max-height: 46vh; overflow-y: auto; }
.tm-main { white-space: pre-wrap; word-wrap: break-word; min-height: 20px; }

.tm-section-label {
  font-size: 10px; font-weight: 700; letter-spacing: .09em;
  text-transform: uppercase; color: #93908a; margin-bottom: 3px;
}
.tm-alt { margin-top: 13px; padding-top: 11px; border-top: 1px dashed rgba(0,0,0,.13); }
.tm-alt-text { white-space: pre-wrap; color: #4a4842; }
.tm-alt.hidden, .tm-note.hidden { display: none; }

.tm-note {
  margin-top: 12px; padding: 9px 11px;
  background: rgba(201,100,66,.07);
  border-left: 2px solid #c96442;
  border-radius: 0 7px 7px 0;
  font-size: 12.5px; color: #5c463c;
}
.tm-note-line + .tm-note-line { margin-top: 4px; }

.tm-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px;
  border-top: 1px solid rgba(0,0,0,.07);
  background: #f3f1ed;
}
.tm-chips { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
.tm-chip {
  font: inherit; font-size: 11.5px;
  padding: 3px 9px; border-radius: 999px;
  border: 1px solid rgba(0,0,0,.13);
  background: transparent; color: #6b6862; cursor: pointer;
}
.tm-chip:hover { background: rgba(0,0,0,.05); color: #17171a; }
.tm-chip.active { background: #1b1b1f; border-color: #1b1b1f; color: #fbfaf8; }
.tm-copy {
  font: inherit; font-size: 12px; font-weight: 500;
  padding: 4px 12px; border-radius: 7px;
  border: 1px solid rgba(0,0,0,.13);
  background: #fff; color: #17171a; cursor: pointer;
  white-space: nowrap;
}
.tm-copy:hover { background: #efece7; }

.tm-error { color: #a33a22; font-size: 13px; }
.tm-link {
  display: block; margin-top: 7px;
  font: inherit; font-size: 12.5px;
  background: none; border: none; padding: 0;
  color: #c96442; text-decoration: underline; cursor: pointer;
}

.tm-toast {
  position: fixed; top: 16px; right: 16px;
  width: 270px; padding: 12px 14px;
  background: #1b1b1f; color: #f5f3ef;
  border-radius: 12px;
  box-shadow: 0 14px 36px rgba(0,0,0,.32);
  font: 400 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
  z-index: 2147483647;
}
.tm-toast-label { margin-bottom: 9px; }
.tm-bar { height: 3px; border-radius: 2px; background: rgba(255,255,255,.16); overflow: hidden; }
.tm-bar-fill { height: 100%; width: 0; background: #c96442; transition: width .3s ease; }
.tm-toast-btn {
  margin-top: 10px; font: inherit; font-size: 12px;
  background: none; border: 1px solid rgba(255,255,255,.25);
  color: #f5f3ef; padding: 4px 11px; border-radius: 7px; cursor: pointer;
}
.tm-toast-btn:hover { background: rgba(255,255,255,.1); }

@media (prefers-color-scheme: dark) {
  .tm-card { background: #1f1f23; color: #ece9e3; border-color: rgba(255,255,255,.1); }
  .tm-head, .tm-foot { background: #26262b; border-color: rgba(255,255,255,.08); }
  .tm-dir, .tm-chip { color: #9c988f; }
  .tm-chip { border-color: rgba(255,255,255,.14); }
  .tm-chip:hover { background: rgba(255,255,255,.08); color: #ece9e3; }
  .tm-chip.active { background: #ece9e3; border-color: #ece9e3; color: #1f1f23; }
  .tm-copy { background: #303036; color: #ece9e3; border-color: rgba(255,255,255,.14); }
  .tm-copy:hover { background: #3a3a41; }
  .tm-alt { border-color: rgba(255,255,255,.13); }
  .tm-alt-text { color: #b3afa7; }
  .tm-note { background: rgba(201,100,66,.14); color: #e0bfb2; }
  .tm-icon-btn:hover { background: rgba(255,255,255,.1); color: #ece9e3; }
  .tm-error { color: #e58f72; }
}
`;
})();

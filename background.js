// Толмач — service worker. Единственное место, где живёт ключ API:
// content script и попап только просят перевод и получают текст.

import {
  DEFAULTS,
  translateStream,
  translateSegments,
  replyStream,
  pickDirection,
  TranslationError
} from './engine.js';

// ——— настройки ————————————————————————————————————————————————
async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

// ——— контекстное меню и горячие клавиши ———————————————————————
const MENU_SELECTION = 'tolmach-selection';
const MENU_PAGE = 'tolmach-page';

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: 'Перевести «%s»',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: 'Перевести всю страницу',
      contexts: ['page']
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  installMenus();
  // Первый запуск бесполезен без ключа — сразу показываем настройки.
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(installMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_SELECTION) {
    sendToTab(tab.id, { type: 'translate-selection' });
  } else if (info.menuItemId === MENU_PAGE) {
    sendToTab(tab.id, { type: 'translate-page' });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'translate-selection') sendToTab(tab.id, { type: 'translate-selection' });
  if (command === 'translate-page') sendToTab(tab.id, { type: 'translate-page' });
});

// На служебных страницах (chrome://, интернет-магазин) content script не живёт —
// сообщение туда просто не дойдёт, и это нормально, а не сбой.
function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// Карточка на странице не может сама открыть настройки — просит нас.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse?.({ ok: true });
  }
  return false;
});

// ——— поток перевода ——————————————————————————————————————————
// Каждый запрос — отдельный порт. Порт закрыли (закрыли карточку,
// ушли со страницы) — обрываем запрос к API, чтобы не платить за него.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tolmach') return;

  const controller = new AbortController();
  let closed = false;

  port.onDisconnect.addListener(() => {
    closed = true;
    controller.abort();
  });

  const post = (msg) => {
    if (closed) return;
    try {
      port.postMessage(msg);
    } catch {
      closed = true;
    }
  };

  port.onMessage.addListener(async (req) => {
    try {
      if (req.type === 'translate') {
        await handleTranslate(req, post, controller.signal);
      } else if (req.type === 'reply') {
        await handleReply(req, post, controller.signal);
      } else if (req.type === 'page') {
        await handlePage(req, post, controller.signal, () => closed);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      post({
        type: 'error',
        kind: err instanceof TranslationError ? err.kind : 'unknown',
        message: describeError(err)
      });
    }
  });
});

function describeError(err) {
  if (err instanceof TranslationError) return err.message;
  if (err?.name === 'TypeError') {
    return 'Не удалось достучаться до Anthropic — проверь интернет.';
  }
  return err?.message || 'Что-то пошло не так.';
}

async function handleTranslate(req, post, signal) {
  const settings = await getSettings();
  const text = (req.text || '').trim();
  if (!text) {
    post({ type: 'error', kind: 'empty', message: 'Нечего переводить.' });
    return;
  }

  const dir = req.targetOverride
    ? { to: req.targetOverride, from: '' }
    : pickDirection(text, settings);
  post({ type: 'start', to: dir.to, from: dir.from, model: settings.model });

  const result = await translateStream({
    text,
    settings,
    tone: req.tone,
    targetOverride: req.targetOverride,
    signal,
    onDelta: (_chunk, full) => post({ type: 'delta', full })
  });

  post({ type: 'done', raw: result.raw, to: result.to, from: result.from });
}

async function handleReply(req, post, signal) {
  const settings = await getSettings();
  const text = (req.text || '').trim();
  if (!text) {
    post({ type: 'error', kind: 'empty', message: 'Нечего отвечать.' });
    return;
  }

  post({ type: 'reply-start' });

  const raw = await replyStream({
    text,
    context: req.context,
    settings,
    signal,
    onDelta: (_chunk, full) => post({ type: 'reply-delta', full })
  });

  post({ type: 'reply-done', raw });
}

// Куски страницы шлём пачками: экономнее по токенам и модель видит контекст.
// Пачки идут последовательно, каждая долетает обратно сразу — страница
// переводится сверху вниз на глазах, а не одним рывком в конце.
const CHUNK_CHARS = 1800;
const CHUNK_MAX_SEGMENTS = 40;

function chunkSegments(segments) {
  const chunks = [];
  let current = [];
  let size = 0;
  segments.forEach((seg, index) => {
    const len = seg.text.length + 8;
    if (current.length && (size + len > CHUNK_CHARS || current.length >= CHUNK_MAX_SEGMENTS)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push({ index, text: seg.text });
    size += len;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

async function handlePage(req, post, signal, isClosed) {
  const settings = await getSettings();
  const segments = req.segments || [];
  if (!segments.length) {
    post({ type: 'error', kind: 'empty', message: 'На странице не нашлось текста.' });
    return;
  }

  // Направление берём по странице целиком, а не по отдельной надписи:
  // одна кнопка «OK» посреди русской страницы не должна разворачивать перевод.
  const sample = segments
    .map((s) => s.text)
    .join(' ')
    .slice(0, 4000);
  const dir = req.targetOverride
    ? { to: req.targetOverride, from: req.targetOverride === settings.native ? settings.foreign : settings.native }
    : pickDirection(sample, settings);

  const chunks = chunkSegments(segments);
  post({ type: 'page-start', total: chunks.length, to: dir.to });

  let failures = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (isClosed()) return;
    const chunk = chunks[i];
    try {
      const translated = await translateSegments({
        segments: chunk.map((c) => c.text),
        settings,
        to: dir.to,
        from: dir.from,
        signal
      });
      const items = [];
      translated.forEach((text, localIndex) => {
        const origin = chunk[localIndex];
        if (origin) items.push({ index: origin.index, text });
      });
      post({ type: 'page-chunk', done: i + 1, total: chunks.length, items });
    } catch (err) {
      if (signal.aborted) return;
      // Ключ или деньги — дальше идти бессмысленно, всё упадёт так же.
      if (err instanceof TranslationError && ['auth', 'nokey', 'billing'].includes(err.kind)) {
        throw err;
      }
      // Одна пачка не перевелась — эти куски останутся на месте,
      // остальная страница переведётся. Молча ронять всё было бы хуже.
      failures++;
      post({ type: 'page-chunk', done: i + 1, total: chunks.length, items: [], failed: true });
    }
  }

  post({ type: 'page-done', failures, total: chunks.length });
}

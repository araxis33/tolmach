// Толмач — service worker. Единственное место, где живёт ключ API:
// content script и попап только просят перевод и получают текст.

import {
  DEFAULTS,
  translateStream,
  translateSegments,
  replyStream,
  priceOf,
  pickDirection,
  modelFor,
  providerOf,
  listGeminiModels,
  pickGeminiModels,
  listGroqModels,
  pickGroqModels,
  listChatgptModels,
  pickChatgptModels,
  TranslationError
} from './engine.js';
import {
  buildAuthorizeUrl,
  isCallbackUrl,
  readCallback,
  verifyIdToken,
  exchangeCode,
  refreshTokens,
  revokeToken,
  authRecord,
  hasPlanScope,
  needsRefresh,
  randomToken,
  pkceChallenge
} from './chatgpt-auth.js';

// ——— настройки ————————————————————————————————————————————————
async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };
  // Токен входа ChatGPT живёт час — обновляем перед запросом, а не после отказа.
  if (settings.chatgptAuth) settings.chatgptAuth = await freshChatgptAuth(settings.chatgptAuth);
  return settings;
}

// ——— вход через ChatGPT ————————————————————————————————————————
// Пока человек входит на auth.openai.com, service worker может уснуть, поэтому
// всё про текущую попытку лежит в storage.session, а слушатель вкладок —
// на верхнем уровне файла: Chrome будит воркер ради него.
const LOGIN_PENDING = 'chatgptPending';
const LOGIN_STATUS = 'chatgptLoginStatus';

function loginStatus(phase, message = '') {
  return chrome.storage.session.set({ [LOGIN_STATUS]: { phase, message, at: Date.now() } });
}

async function startChatgptLogin() {
  const stored = await chrome.storage.local.get(['chatgptClientId', 'chatgptHostId', 'chatgptAuth']);
  // Свой идентификатор у каждой машины; создаётся один раз и больше не меняется.
  let hostId = stored.chatgptHostId;
  if (!hostId) {
    hostId = `urn:uuid:${crypto.randomUUID()}`;
    await chrome.storage.local.set({ chatgptHostId: hostId });
  }
  const verifier = randomToken(48);
  const pending = {
    clientId: stored.chatgptClientId || '',
    state: randomToken(24),
    nonce: randomToken(24),
    verifier
  };
  const url = buildAuthorizeUrl({
    clientId: pending.clientId,
    hostId,
    state: pending.state,
    nonce: pending.nonce,
    challenge: await pkceChallenge(verifier),
    loginHint: (stored.chatgptAuth && stored.chatgptAuth.email) || ''
  });
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.session.set({ [LOGIN_PENDING]: { ...pending, tabId: tab.id } });
  await loginStatus('waiting');
}

// Повторный вызов на тот же адрес (Chrome шлёт onUpdated не один раз) не должен
// второй раз менять код на токены: код одноразовый, вторая попытка испортила бы вход.
let finishing = false;

async function finishChatgptLogin(tabId, url) {
  if (finishing) return;
  // Флаг — до первого await: второй onUpdated приходит, пока первый читает storage.
  finishing = true;
  const { [LOGIN_PENDING]: pending } = await chrome.storage.session.get(LOGIN_PENDING);
  if (!pending || pending.tabId !== tabId) {
    finishing = false;
    return;
  }
  try {
    await chrome.storage.session.remove(LOGIN_PENDING);
    chrome.tabs.remove(tabId).catch(() => {});
    const cb = readCallback(url);
    if (cb.state !== pending.state) throw new Error('Ответ входа не совпал с запросом. Нажми «Войти» ещё раз.');
    if (cb.error) {
      throw new Error(cb.error === 'access_denied' ? 'Вход отменён.' : `OpenAI: ${cb.errorDescription || cb.error}`);
    }
    if (pending.clientId && cb.clientId && cb.clientId !== pending.clientId) {
      throw new Error('OpenAI вернул чужой идентификатор приложения — вход отклонён.');
    }
    const clientId = pending.clientId || cb.clientId;
    if (!clientId) throw new Error('Регистрация Толмача в ChatGPT не завершилась. Нажми «Войти» ещё раз.');
    // Сохраняем сразу: даже если дальше что-то сорвётся, повторный вход не
    // зарегистрирует Толмача в его ChatGPT второй раз.
    await chrome.storage.local.set({ chatgptClientId: clientId });

    const tokens = await exchangeCode({ clientId, code: cb.code, verifier: pending.verifier });
    const claims = await verifyIdToken(tokens.id_token, { clientId, nonce: pending.nonce });
    const auth = authRecord(tokens, claims, clientId);
    if (!hasPlanScope(auth.scope || cb.scope)) {
      throw new Error('Вход есть, но разрешение «тратить подписку» не дано. Нажми «Войти» ещё раз и оставь его включённым.');
    }
    const models = await listChatgptModels(auth.accessToken);
    if (!models.length) throw new Error('Вход есть, но OpenAI не показал ни одной модели для этой подписки.');
    const picked = pickChatgptModels(models);
    await chrome.storage.local.set({
      chatgptAuth: auth,
      chatgptAvailable: models,
      chatgptModel: picked.translate,
      chatgptReplyModel: picked.reply,
      chatgptNoReasoning: false,
      provider: 'chatgpt'
    });
    await loginStatus('ok', auth.email);
  } catch (err) {
    await loginStatus('error', describeError(err));
  } finally {
    finishing = false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && isCallbackUrl(info.url)) finishChatgptLogin(tabId, info.url);
});

// Закрыл вкладку входа, не войдя, — говорим об этом, а не «ждём» вечно.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { [LOGIN_PENDING]: pending } = await chrome.storage.session.get(LOGIN_PENDING);
  if (!pending || pending.tabId !== tabId || finishing) return;
  await chrome.storage.session.remove(LOGIN_PENDING);
  await loginStatus('error', 'Вкладку входа закрыли — вход не завершён.');
});

// Одно обновление на всех: долгий токен одноразовый, два параллельных
// обновления потратили бы его дважды, и второе выкинуло бы из входа.
let refreshing = null;

async function freshChatgptAuth(auth) {
  if (!needsRefresh(auth)) return auth;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const tokens = await refreshTokens({ clientId: auth.clientId, refreshToken: auth.refreshToken });
        const next = authRecord(tokens, null, auth.clientId, auth);
        await chrome.storage.local.set({ chatgptAuth: next });
        return next;
      } catch {
        // Не обновился — идём со старым: OpenAI ответит 401, карточка скажет
        // «войди заново», а перевод доделают Gemini или Groq.
        return auth;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

async function chatgptLogout() {
  const stored = await chrome.storage.local.get(['chatgptAuth', 'provider', 'geminiKey', 'groqKey']);
  const auth = stored.chatgptAuth;
  if (auth && auth.refreshToken) await revokeToken({ clientId: auth.clientId, token: auth.refreshToken });
  const next = { chatgptAuth: null, chatgptAvailable: [], chatgptModel: '', chatgptReplyModel: '' };
  if (stored.provider === 'chatgpt') next.provider = !stored.geminiKey && stored.groqKey ? 'groq' : 'gemini';
  await chrome.storage.local.set(next);
  await chrome.storage.session.remove(LOGIN_STATUS);
}

/**
 * Запоминаем, каким способом модель приняла ограничение размышлений.
 * Без этого каждый перевод начинался бы с отказа Google: числовой бюджет
 * пробуется первым, а модели поколения 3.x его не принимают.
 */
async function rememberThinkingStep(settings, step) {
  if (typeof step !== 'number') return;
  if (settings.geminiThinkingStep === step) return;
  await chrome.storage.local.set({ geminiThinkingStep: step });
}

/**
 * Запоминаем модель Gemini, которая ответила: следующий перевод начнётся с неё,
 * а не с перегруженной свежей (28.09 лестница тратила на это 25 с каждый раз).
 */
/** Модель ChatGPT отвергла поле reasoning — запоминаем, чтобы не платить отказом каждый раз. */
async function rememberNoReasoning(settings, off) {
  if (!off || settings.chatgptNoReasoning) return;
  await chrome.storage.local.set({ chatgptNoReasoning: true });
}

async function rememberGoodModel(settings, purpose, model) {
  if (!/^gemini-/.test(model || '')) return;
  const good = { ...(settings.geminiGood || {}), [purpose]: { model, at: Date.now() } };
  await chrome.storage.local.set({ geminiGood: good });
}

// ——— счётчик расходов ————————————————————————————————————————
// Токены берём из ответа API, а не прикидываем по длине текста.
// Консоль Anthropic обновляется с задержкой и по UTC, поэтому живой счёт — здесь.
const SPEND_KEY = 'spend';
const SPEND_DAYS = 60;

function emptyBucket() {
  return { n: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
}

function emptyLedger() {
  return { translate: emptyBucket(), reply: emptyBucket(), page: emptyBucket() };
}

async function recordSpend(kind, model, usage) {
  if (!usage) return 0;
  const cost = priceOf(model, usage);
  const today = new Date().toISOString().slice(0, 10);

  const stored = await chrome.storage.local.get([SPEND_KEY]);
  const spend = stored[SPEND_KEY] || { days: {}, total: emptyLedger() };
  if (!spend.days[today]) spend.days[today] = emptyLedger();
  if (!spend.total[kind]) spend.total[kind] = emptyBucket();

  // Отдельный счётчик от последнего пополнения: по нему считается остаток.
  spend.sinceBalance = (spend.sinceBalance || 0) + cost;

  for (const bucket of [spend.days[today][kind], spend.total[kind]]) {
    bucket.n += 1;
    bucket.cost += cost;
    bucket.tokensIn += (usage.input || 0) + (usage.cacheWrite || 0) + (usage.cacheRead || 0);
    bucket.tokensOut += usage.output || 0;
  }

  // Дни копились бы вечно, если их не подрезать.
  const days = Object.keys(spend.days).sort();
  while (days.length > SPEND_DAYS) delete spend.days[days.shift()];

  await chrome.storage.local.set({ [SPEND_KEY]: spend });
  return cost;
}

// Остаток API наружу не отдаёт. Считаем от суммы, которую он вписал сам.
async function moneyLeft() {
  const stored = await chrome.storage.local.get(['balance', SPEND_KEY]);
  const start = parseFloat(String(stored.balance || '').replace(',', '.'));
  if (!isFinite(start)) return null;
  const spent = (stored[SPEND_KEY] || {}).sinceBalance || 0;
  return Math.max(0, start - spent);
}

// Вписал новую сумму — значит пополнил: считаем траты с нуля.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.balance) return;
  chrome.storage.local.get([SPEND_KEY]).then((stored) => {
    const spend = stored[SPEND_KEY];
    if (!spend) return;
    spend.sinceBalance = 0;
    chrome.storage.local.set({ [SPEND_KEY]: spend });
  });
});

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
  // Настройки проверяют ключ Gemini списком моделей: видно и то, что ключ
  // принят, и какие модели ему доступны. Лучшие сразу сохраняются.
  if (msg?.type === 'gemini-models') {
    (async () => {
      try {
        const ids = await listGeminiModels(msg.key);
        const picked = pickGeminiModels(ids);
        await chrome.storage.local.set({
          geminiKey: msg.key,
          geminiModel: picked.translate,
          geminiReplyModel: picked.reply,
          // Запас на случай перегрузки: по этим моделям лестница попыток пойдёт
          // дальше, когда выбранная отвечает 503.
          geminiAvailable: picked.available,
          // Модели сменились — подобранный способ ограничить размышления
          // к ним может не подойти, подбираем заново.
          geminiThinkingStep: 0
        });
        sendResponse({ ok: true, ...picked });
      } catch (err) {
        sendResponse({ ok: false, message: describeError(err) });
      }
    })();
    return true; // ответ придёт позже
  }
  // Ключ Groq проверяем так же — списком моделей; лучшая сразу сохраняется.
  if (msg?.type === 'groq-models') {
    (async () => {
      try {
        const picked = pickGroqModels(await listGroqModels(msg.key));
        await chrome.storage.local.set({ groqKey: msg.key, groqModel: picked.model, groqAvailable: picked.available });
        sendResponse({ ok: true, ...picked });
      } catch (err) {
        sendResponse({ ok: false, message: describeError(err) });
      }
    })();
    return true;
  }
  if (msg?.type === 'chatgpt-login' || msg?.type === 'chatgpt-logout') {
    (msg.type === 'chatgpt-login' ? startChatgptLogin() : chatgptLogout())
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, message: describeError(err) }));
    return true;
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
    return 'Не удалось достучаться до модели — проверь интернет.';
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
  post({ type: 'start', to: dir.to, from: dir.from, model: modelFor(settings, 'translate') });

  const result = await translateStream({
    text,
    settings,
    tone: req.tone,
    targetOverride: req.targetOverride,
    signal,
    onDelta: (_chunk, full) => post({ type: 'delta', full })
  });

  await rememberThinkingStep(settings, result.thinkingStep);
  await rememberNoReasoning(settings, result.reasoningOff);
  await rememberGoodModel(settings, 'translate', result.model);
  const cost = await recordSpend('translate', result.model, result.usage);
  post({
    type: 'done',
    raw: result.raw,
    to: result.to,
    from: result.from,
    cost,
    left: await moneyLeft(),
    // Подпись под переводом на Gemini: на чём считали, сколько ждали и как
    // просили не думать. Без неё жалобу «долго» нечем мерить.
    note: result.how ? `${result.model}  ·  ${(result.took / 1000).toFixed(1)} с  ·  ${result.how}` : ''
  });
}

// Картинки поста X скачиваем сами и отдаём модели как base64: Gemini и Claude
// ссылку на pbs.twimg.com не откроют. Не вышло с какой-то — отвечаем без неё.
const IMAGE_HOST = /^https:\/\/pbs\.twimg\.com\//;
const IMAGE_MAX_BYTES = 1_500_000;

async function loadImages(urls, signal) {
  const list = (Array.isArray(urls) ? urls : []).filter((u) => IMAGE_HOST.test(u)).slice(0, 4);
  const out = await Promise.all(
    list.map(async (url) => {
      try {
        const res = await fetch(url, { signal });
        if (!res.ok) return null;
        const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.length || buf.length > IMAGE_MAX_BYTES) return null;
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { mime, data: btoa(bin) };
      } catch {
        return null;
      }
    })
  );
  return out.filter(Boolean);
}

async function handleReply(req, post, signal) {
  const settings = await getSettings();
  const text = (req.text || '').trim();
  if (!text) {
    post({ type: 'error', kind: 'empty', message: 'Нечего отвечать.' });
    return;
  }

  post({ type: 'reply-start' });

  const result = await replyStream({
    text,
    context: req.context,
    images: await loadImages(req.context?.images, signal),
    settings,
    signal,
    onDelta: (_chunk, full) => post({ type: 'reply-delta', full })
  });

  await rememberNoReasoning(settings, result.reasoningOff);
  await rememberGoodModel(settings, 'reply', result.model);
  const cost = await recordSpend('reply', result.model, result.usage);
  post({
    type: 'reply-done',
    raw: result.raw,
    cost,
    left: await moneyLeft(),
    // Если Gemini лёг и ответ дописал Claude — это должно быть видно в карточке:
    // иначе трата появится в счётчике денег без объяснения.
    note: result.how ? `${result.model}  ·  ${result.how}` : ''
  });
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
      const { map: translated, usage: pageUsage, model: pageModel } = await translateSegments({
        segments: chunk.map((c) => c.text),
        settings,
        to: dir.to,
        from: dir.from,
        signal
      });
      await recordSpend('page', pageModel, pageUsage);
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

import { DEFAULTS, TONES, splitResult, pickDirection, formatCost } from './engine.js';

const SHORT = { ru: 'RU', en: 'EN', de: 'DE', es: 'ES', fr: 'FR', zh: 'ZH', uk: 'UK', tr: 'TR' };

const $ = (id) => document.getElementById(id);
const input = $('input');
const result = $('result');
const altWrap = $('altWrap');
const altText = $('altText');
const note = $('note');
const errorBox = $('error');
const spin = $('spin');
const dirFrom = $('dirFrom');
const dirTo = $('dirTo');
const copyBtn = $('copy');

let settings = { ...DEFAULTS };
let tone = null;
let forcedTarget = null;
let port = null;
let parsed = { main: '', alt: '', note: '' };
let debounce = null;
let lastSent = '';

// ——— запуск ————————————————————————————————————————————————————
init();

async function init() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  settings = { ...DEFAULTS, ...stored };
  tone = settings.tone;
  buildChips();

  $('settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $('dirBtn').addEventListener('click', () => {
    const to = forcedTarget || currentDirection().to;
    forcedTarget = to === settings.native ? settings.foreign : settings.native;
    paintDirection();
    if (input.value.trim()) translate(true);
  });

  copyBtn.addEventListener('click', copyResult);
  $('useAlt').addEventListener('click', () => {
    if (!parsed.alt) return;
    const swapped = { main: parsed.alt, alt: parsed.main, note: parsed.note };
    parsed = swapped;
    paint(parsed);
  });

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    // Ждём, пока человек допечатает: иначе каждый пробел стоил бы запроса.
    debounce = setTimeout(() => translate(false), 800);
    paintDirection();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      clearTimeout(debounce);
      translate(true);
    }
  });

  if (!settings.apiKey) {
    showError('Сначала вставь ключ Anthropic в настройках.', 'nokey');
    return;
  }

  await prefillFromPage();
}

// Выделение на активной вкладке — самый частый повод открыть попап.
async function prefillFromPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'get-selection' });
    if (res?.text) {
      input.value = res.text;
      paintDirection();
      translate(true);
      return;
    }
  } catch {
    // Служебная страница или content script ещё не поднялся — не беда.
  }
  input.focus();
}

function buildChips() {
  const box = $('chips');
  box.textContent = '';
  ['natural', 'literal', 'tweet', 'formal'].forEach((id) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (id === tone ? ' active' : '');
    chip.textContent = TONES[id].label;
    chip.title = TONES[id].hint;
    chip.addEventListener('click', () => {
      tone = id;
      box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.textContent === TONES[id].label));
      if (input.value.trim()) translate(true);
    });
    box.append(chip);
  });
}

function currentDirection() {
  const text = input.value.trim();
  if (!text) return { from: settings.native, to: settings.foreign };
  return pickDirection(text, settings);
}

function paintDirection() {
  const auto = currentDirection();
  const to = forcedTarget || auto.to;
  const from = to === settings.native ? settings.foreign : settings.native;
  dirFrom.textContent = SHORT[from] || from.toUpperCase();
  dirTo.textContent = SHORT[to] || to.toUpperCase();
}

// ——— перевод ——————————————————————————————————————————————————
function translate(force) {
  const text = input.value.trim();
  if (!text) {
    lastSent = '';
    parsed = { main: '', alt: '', note: '' };
    paint(parsed);
    return;
  }
  // Тот же текст с той же настройкой второй раз не гоняем.
  const stamp = `${text}::${tone}::${forcedTarget || ''}`;
  if (!force && stamp === lastSent) return;
  lastSent = stamp;

  hideError();
  spin.classList.remove('hidden');
  result.textContent = '';
  altWrap.classList.add('hidden');
  note.classList.add('hidden');

  port?.disconnect();
  try {
    port = chrome.runtime.connect({ name: 'tolmach' });
  } catch {
    spin.classList.add('hidden');
    showError('Расширение обновилось — открой попап заново.');
    return;
  }

  port.onDisconnect.addListener(() => {
    port = null;
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'start') {
      dirFrom.textContent = SHORT[msg.from] || '?';
      dirTo.textContent = SHORT[msg.to] || '?';
    } else if (msg.type === 'delta') {
      paint(parseStream(msg.full));
    } else if (msg.type === 'done') {
      spin.classList.add('hidden');
      showMoney(msg.cost, msg.left);
      paint(splitResult(msg.raw));
      dirFrom.textContent = SHORT[msg.from] || '?';
      dirTo.textContent = SHORT[msg.to] || '?';
    } else if (msg.type === 'error') {
      spin.classList.add('hidden');
      showError(msg.message, msg.kind);
    }
  });

  port.postMessage({ type: 'translate', text, tone, targetOverride: forcedTarget });
}

// Пока маркер @@ALT@@ печатается посимвольно, его обрывок не должен мелькать.
function parseStream(raw) {
  const out = splitResult(raw);
  out.main = out.main.replace(/@[@A-Z]*$/, '').trim();
  return out;
}

function paint(next) {
  parsed = next;
  result.textContent = next.main;
  altWrap.classList.toggle('hidden', !next.alt);
  altText.textContent = next.alt;
  note.classList.toggle('hidden', !next.note);
  if (next.note) {
    note.textContent = '';
    next.note
      .split('\n')
      .map((line) => line.replace(/^[-•*]\s*/, '').trim())
      .filter(Boolean)
      .forEach((line) => {
        const div = document.createElement('div');
        div.className = 'note-line';
        div.textContent = line;
        note.append(div);
      });
  }
  copyBtn.disabled = !next.main;
}

function copyResult() {
  if (!parsed.main) return;
  navigator.clipboard.writeText(parsed.main).then(
    () => {
      copyBtn.textContent = 'Скопировано';
      setTimeout(() => (copyBtn.textContent = 'Копировать'), 1400);
    },
    () => {
      copyBtn.textContent = 'Не вышло';
      setTimeout(() => (copyBtn.textContent = 'Копировать'), 1400);
    }
  );
}

// В попапе нет отдельного места под цифры — пишем в строку подсказки внизу.
function showMoney(cost, left) {
  const hint = document.getElementById('hint');
  if (!hint) return;
  const parts = [];
  if (cost) parts.push('−' + formatCost(cost));
  if (typeof left === 'number') parts.push('осталось ' + formatCost(left));
  if (parts.length) hint.textContent = parts.join('  ·  ');
}

function showError(message, kind) {
  errorBox.textContent = '';
  errorBox.append(document.createTextNode(message));
  if (kind === 'nokey' || kind === 'auth') {
    const btn = document.createElement('button');
    btn.textContent = 'Открыть настройки';
    btn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
    errorBox.append(btn);
  }
  errorBox.classList.remove('hidden');
}

function hideError() {
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
}

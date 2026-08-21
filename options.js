import { DEFAULTS, MODELS, TONES, LANGS } from './engine.js';

const $ = (id) => document.getElementById(id);
const status = $('status');

const FIELDS = {
  apiKey: { el: () => $('apiKey'), prop: 'value' },
  native: { el: () => $('native'), prop: 'value' },
  foreign: { el: () => $('foreign'), prop: 'value' },
  tone: { el: () => $('tone'), prop: 'value' },
  model: { el: () => $('model'), prop: 'value' },
  showAlt: { el: () => $('showAlt'), prop: 'checked' },
  showBubble: { el: () => $('showBubble'), prop: 'checked' },
  glossary: { el: () => $('glossary'), prop: 'value' }
};

init();

async function init() {
  fillSelect($('native'), LANGS.map((l) => [l.id, l.label]));
  fillSelect($('foreign'), LANGS.map((l) => [l.id, l.label]));
  fillSelect($('model'), MODELS.map((m) => [m.id, m.label]));
  fillSelect(
    $('tone'),
    ['natural', 'literal', 'tweet', 'formal'].map((id) => [id, TONES[id].label])
  );

  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };

  for (const [key, field] of Object.entries(FIELDS)) {
    field.el()[field.prop] = settings[key];
    field.el().addEventListener('change', () => save(key));
    if (field.prop === 'value') field.el().addEventListener('input', () => save(key));
  }

  paintModelNote();
  $('model').addEventListener('change', paintModelNote);

  $('reveal').addEventListener('click', () => {
    const box = $('apiKey');
    const hidden = box.type === 'password';
    box.type = hidden ? 'text' : 'password';
    $('reveal').textContent = hidden ? 'Скрыть' : 'Показать';
  });

  $('test').addEventListener('click', testKey);

  // Ссылку на chrome://extensions/shortcuts нельзя открыть обычным <a>.
  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // Один и тот же язык с двух сторон обессмыслил бы перевод.
  $('native').addEventListener('change', () => guardLanguages('native'));
  $('foreign').addEventListener('change', () => guardLanguages('foreign'));
}

function fillSelect(select, pairs) {
  select.textContent = '';
  pairs.forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.append(opt);
  });
}

function guardLanguages(changed) {
  const native = $('native');
  const foreign = $('foreign');
  if (native.value !== foreign.value) return;
  const other = changed === 'native' ? foreign : native;
  const fallback = LANGS.find((l) => l.id !== native.value);
  if (fallback) {
    other.value = fallback.id;
    save(changed === 'native' ? 'foreign' : 'native');
  }
}

function paintModelNote() {
  const model = MODELS.find((m) => m.id === $('model').value);
  $('modelNote').textContent = model
    ? `${model.note}. Обычный перевод абзаца — доли цента.`
    : '';
}

let saveTimer = null;
function save(key) {
  const field = FIELDS[key];
  const value = field.el()[field.prop];
  chrome.storage.local.set({ [key]: typeof value === 'string' ? value.trim() : value });
  clearTimeout(saveTimer);
  $('saved').textContent = 'Сохранено.';
  saveTimer = setTimeout(() => {
    $('saved').textContent = 'Изменения сохраняются сразу.';
  }, 1500);
}

// Проверяем ключ настоящим коротким переводом — так видно и то, что ключ
// принят, и то, что на счету есть деньги.
async function testKey() {
  const key = $('apiKey').value.trim();
  if (!key) {
    setStatus('Сначала вставь ключ.', 'bad');
    return;
  }
  await chrome.storage.local.set({ apiKey: key });

  $('test').disabled = true;
  setStatus('Проверяю…', '');

  const port = chrome.runtime.connect({ name: 'tolmach' });
  let answered = false;

  const finish = (text, kind) => {
    if (answered) return;
    answered = true;
    $('test').disabled = false;
    setStatus(text, kind);
    port.disconnect();
  };

  port.onMessage.addListener((msg) => {
    if (msg.type === 'done') {
      const sample = msg.raw.split('@@')[0].trim().split('\n')[0];
      finish(`Работает. «Сегодня хорошая погода» → «${sample}»`, 'ok');
    } else if (msg.type === 'error') {
      finish(msg.message, 'bad');
    }
  });

  port.onDisconnect.addListener(() => finish('Связь оборвалась. Попробуй ещё раз.', 'bad'));

  port.postMessage({
    type: 'translate',
    text: 'Сегодня хорошая погода',
    tone: 'natural',
    targetOverride: $('foreign').value
  });
}

function setStatus(text, kind) {
  status.textContent = text;
  status.className = `status ${kind}`;
  status.classList.remove('hidden');
}

import { DEFAULTS, MODELS, TONES, LANGS, formatCost } from './engine.js';

const $ = (id) => document.getElementById(id);

// Черновик для кнопки «Подставить черновик». Пример, а не образец для подражания:
// работает ровно настолько, насколько он про конкретного человека.
const PERSONA_DRAFT = [
  "I'm a solo builder in the Base ecosystem. Russian is my first language, I post in English.",
  '',
  'What I actually do: I run an on-chain scanner that watches new memecoin pools on Base and',
  'Robinhood Chain and flags the ones showing real demand. I keep a small site of Base tools.',
  'I track Aerodrome vote epochs. Most of what I know comes from staring at my own data every',
  'day, not from reading threads.',
  '',
  'How I think: I check things before I believe them. With a token that means tokenomics and',
  "audits first, and I've walked away from projects where those pages in the docs were simply",
  'empty. That caution is about projects, never about people: when someone posts something, my',
  "first move is to find what is right in it. I've been wrong in public myself and said so",
  'instead of quietly fixing it.',
  '',
  "How I talk: plain and short. No hype words, no shilling, no wagmi. I don't pose as an",
  "engineer. If I don't know, I say I don't know. I would much rather add something to what",
  'someone said than argue with it, and I never use irony to make a point.',
  '',
  "Outside all that: I'm just a normal person, curious about pretty much everything — food,",
  'sport, films, history, politics, whatever the thread happens to be about. No specialty in',
  "any of it, no deep expertise. So when a post isn't about crypto or software, I reply like",
  "someone with common sense and real interest: react to what they actually said, say what I'd",
  'say to a friend, ask if I want to know more. Never perform knowledge I don\'t have.',
  "Don't drag the conversation back to markets or tech. Don't work my projects into a thread",
  'where nobody asked.'
].join('\n');
const status = $('status');

const FIELDS = {
  apiKey: { el: () => $('apiKey'), prop: 'value' },
  native: { el: () => $('native'), prop: 'value' },
  foreign: { el: () => $('foreign'), prop: 'value' },
  tone: { el: () => $('tone'), prop: 'value' },
  model: { el: () => $('model'), prop: 'value' },
  showAlt: { el: () => $('showAlt'), prop: 'checked' },
  showBubble: { el: () => $('showBubble'), prop: 'checked' },
  glossary: { el: () => $('glossary'), prop: 'value' },
  persona: { el: () => $('persona'), prop: 'value' },
  replyModel: { el: () => $('replyModel'), prop: 'value' },
  balance: { el: () => $('balance'), prop: 'value' }
};

init();

async function init() {
  fillSelect($('native'), LANGS.map((l) => [l.id, l.label]));
  fillSelect($('foreign'), LANGS.map((l) => [l.id, l.label]));
  fillSelect($('model'), MODELS.map((m) => [m.id, m.label]));
  fillSelect($('replyModel'), MODELS.map((m) => [m.id, m.label]));
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

  await paintSpend();
  $('balance').addEventListener('input', () => setTimeout(paintSpend, 250));
  $('spendReset').addEventListener('click', async () => {
    if (!confirm('Обнулить счётчик расходов? Деньги это не вернёт, только статистику.')) return;
    await chrome.storage.local.remove('spend');
    await paintSpend();
  });

  $('personaDraft').addEventListener('click', () => {
    const box = $('persona');
    if (box.value.trim() && !confirm('Заменить то, что уже написано, черновиком?')) return;
    box.value = PERSONA_DRAFT;
    save('persona');
  });

  // Ссылку на chrome://extensions/shortcuts нельзя открыть обычным <a>.
  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // Один и тот же язык с двух сторон обессмыслил бы перевод.
  $('native').addEventListener('change', () => guardLanguages('native'));
  $('foreign').addEventListener('change', () => guardLanguages('foreign'));
}

// ——— расходы ——————————————————————————————————————————————————
// Главная строка во всём разделе: не «сколько потратил», а «сколько осталось».
async function paintLeft(spend) {
  const box = $('spendLeft');
  const raw = String($('balance').value || '').replace(',', '.').trim();
  const start = parseFloat(raw);

  if (!raw) {
    box.textContent = 'Впиши сумму выше — и здесь будет видно, сколько осталось.';
    box.classList.remove('warn');
    return;
  }
  if (!isFinite(start)) {
    box.textContent = 'Это не похоже на сумму. Нужно число, например 5.';
    box.classList.add('warn');
    return;
  }

  const spent = (spend || {}).sinceBalance || 0;
  const left = Math.max(0, start - spent);

  const total = (spend || {}).total || {};
  const replies = total.reply || { n: 0, cost: 0 };
  const perReply = replies.n ? replies.cost / replies.n : 0;

  const tail = perReply
    ? ' — это примерно ' + Math.floor(left / perReply) + ' ' + plural(Math.floor(left / perReply), 'ответ', 'ответа', 'ответов')
    : '';

  box.textContent = 'Осталось ' + formatCost(left) + tail + '. Потрачено с последнего пополнения: ' + formatCost(spent) + '.';
  box.classList.toggle('warn', left < start * 0.15);
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const SPEND_ROWS = [
  ['reply', 'Ответы'],
  ['translate', 'Переводы'],
  ['page', 'Страницы целиком']
];

function sumDays(spend, fromDate) {
  const out = {};
  for (const [kind] of SPEND_ROWS) out[kind] = { n: 0, cost: 0 };
  for (const [day, ledger] of Object.entries(spend.days || {})) {
    if (day < fromDate) continue;
    for (const [kind] of SPEND_ROWS) {
      const b = ledger[kind];
      if (!b) continue;
      out[kind].n += b.n || 0;
      out[kind].cost += b.cost || 0;
    }
  }
  return out;
}

function dayShift(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function paintSpend() {
  const table = $('spendTable');
  const note = $('spendNote');
  const stored = await chrome.storage.local.get(['spend']);
  const spend = stored.spend;

  table.textContent = '';
  if (!spend || !spend.days) {
    note.textContent = 'Пока ничего не потрачено — счётчик начнёт считать с первого запроса.';
    await paintLeft(null);
    return;
  }

  await paintLeft(spend);

  const today = new Date().toISOString().slice(0, 10);
  const day = sumDays(spend, today);
  const month = sumDays(spend, dayShift(30));
  const total = spend.total || {};

  const head = document.createElement('tr');
  ['', 'Сегодня', 'За 30 дней', 'Всего'].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  });
  table.append(head);

  for (const [kind, label] of SPEND_ROWS) {
    const row = document.createElement('tr');
    const cells = [
      label,
      cell(day[kind]),
      cell(month[kind]),
      cell(total[kind])
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 0) td.className = 'spend-label';
      row.append(td);
    });
    table.append(row);
  }

  const replies = total.reply || { n: 0, cost: 0 };
  note.textContent = replies.n
    ? `Средний ответ обходится в ${formatCost(replies.cost / replies.n)}. Всего потрачено ${formatCost(
        SPEND_ROWS.reduce((sum, [kind]) => sum + ((total[kind] || {}).cost || 0), 0)
      )}.`
    : 'Ответов пока не было.';
}

function cell(bucket) {
  if (!bucket || !bucket.n) return '—';
  return `${formatCost(bucket.cost)} · ${bucket.n}`;
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

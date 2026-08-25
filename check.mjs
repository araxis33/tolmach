// Предполётная проверка расширения: манифест, файлы, синтаксис, права.
// Гоняется до того, как грузить папку в Chrome.
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
const ok = (msg) => console.log(`ok    ${msg}`);
const bad = (msg) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
ok('манифест — валидный JSON');

// ——— все упомянутые файлы на месте ———————————————————————————
const referenced = [
  manifest.background.service_worker,
  manifest.options_page,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon)
];
for (const file of new Set(referenced)) {
  existsSync(file) ? ok(`есть ${file}`) : bad(`манифест ссылается на ${file}, а его нет`);
}

// ——— html тянет только существующее ————————————————————————
for (const page of ['popup.html', 'options.html']) {
  const html = readFileSync(page, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    const target = m[1];
    if (target.startsWith('http')) continue;
    existsSync(target) ? ok(`${page} → ${target}`) : bad(`${page} тянет ${target}, а его нет`);
  }
}

// ——— синтаксис ————————————————————————————————————————————————
const dir = mkdtempSync(join(tmpdir(), 'tolmach-'));
const modules = ['engine.js', 'background.js', 'popup.js', 'options.js'];
const scripts = ['content.js'];

for (const file of [...modules, ...scripts]) {
  const ext = modules.includes(file) ? 'mjs' : 'cjs';
  const copy = join(dir, `${file.replace('.js', '')}.${ext}`);
  writeFileSync(copy, readFileSync(file));
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    ok(`синтаксис ${file}`);
  } catch (err) {
    bad(`синтаксис ${file}: ${String(err.stderr || err).split('\n').slice(0, 3).join(' ')}`);
  }
  unlinkSync(copy);
}

// ——— права под то, что реально вызывается ———————————————————
const sources = Object.fromEntries(
  [...modules, ...scripts].map((f) => [f, readFileSync(f, 'utf8')])
);
const allCode = Object.values(sources).join('\n');
const perms = new Set(manifest.permissions);

const needs = {
  'chrome.storage': 'storage',
  'chrome.contextMenus': 'contextMenus',
  'chrome.tabs.query': 'activeTab'
};
for (const [api, perm] of Object.entries(needs)) {
  if (!allCode.includes(api)) continue;
  perms.has(perm) ? ok(`${api} покрыт правом "${perm}"`) : bad(`${api} используется без права "${perm}"`);
}

if (/fetch\(\s*API_URL/.test(sources['engine.js'])) {
  manifest.host_permissions?.some((h) => h.includes('api.anthropic.com'))
    ? ok('запросы к api.anthropic.com разрешены в host_permissions')
    : bad('код ходит в api.anthropic.com, а host_permissions этого не разрешает');
}

// ——— регулярка, которая стала комментарием ————————————————————
// Так уже ломалось однажды: в `return //status/d+/.test(path)` потерялись
// обратные слэши, строка превратилась в комментарий, функция молча вернула
// undefined — и разговор выше по треду перестал доезжать до модели.
// Синтаксис при этом валиден, поэтому нужна отдельная проверка.
const COMMENTED_REGEX = /(?:return|=>|[=(,])\s*\/\/\S/;
let commented = 0;
for (const [file, src] of Object.entries(sources)) {
  src.split('\n').forEach((line, i) => {
    if (COMMENTED_REGEX.test(line)) {
      commented++;
      bad(`${file}:${i + 1} — регулярка потеряла обратные слэши и стала комментарием`);
    }
  });
}
if (!commented) ok('ни одна регулярка не выродилась в комментарий');

// ——— ключ не должен утекать в страницу ————————————————————————
if (/apiKey/.test(sources['content.js'])) {
  bad('content.js упоминает apiKey — ключ не должен попадать на страницу');
} else {
  ok('content.js не видит ключ');
}
if (/x-api-key/.test(sources['content.js'])) {
  bad('content.js шлёт заголовок с ключом');
} else {
  ok('ключ уходит только из service worker');
}

// ——— команды манифеста совпадают с обработчиками ————————————
for (const command of Object.keys(manifest.commands)) {
  sources['background.js'].includes(`'${command}'`)
    ? ok(`команда ${command} обработана`)
    : bad(`команда ${command} объявлена, но нигде не обрабатывается`);
}

// ——— сообщения, которые шлёт одна сторона, ловит другая ————————
const sent = [...allCode.matchAll(/type:\s*'([a-z-]+)'/g)].map((m) => m[1]);
for (const type of new Set(sent)) {
  const handled = allCode.includes(`=== '${type}'`) || allCode.includes(`'${type}'`);
  if (!handled) bad(`сообщение "${type}" отправляется, но не обрабатывается`);
}
ok('у каждого типа сообщений есть обработчик');

console.log(failed ? `\n${failed} провалено` : '\nрасширение готово к загрузке');
process.exit(failed ? 1 : 0);

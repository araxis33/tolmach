// Проверка чистых функций движка — без сети и без ключа.
import {
  detectLang,
  pickDirection,
  parseGlossary,
  splitResult,
  packSegments,
  unpackSegments
} from './engine.js';

let failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        получили ${a}\n        ожидали  ${e}`}`);
}

const cfg = { native: 'ru', foreign: 'en' };

check('кириллица распознана', detectLang('Привет мир'), 'cyr');
check('латиница распознана', detectLang('hello world'), 'lat');
check('тикеры не сбивают детектор', detectLang('Купил $ETH на Base вчера, доволен'), 'cyr');
check('без букв — направление неизвестно', detectLang('42 — 17 = 25'), 'unknown');
check('ссылка не перевешивает русский текст', detectLang('Смотри тут https://aerodrome.finance/vote'), 'cyr');
check('хэндл и тикер не перевешивают русский', detectLang('@vitalikbuterin про $ETH — годно'), 'cyr');
check('адрес кошелька не перевешивает русский', detectLang('Кинул на 0xAb37f9C4c2Bd11 вчера'), 'cyr');
check('английский текст со ссылкой остаётся английским', detectLang('check https://base.org now'), 'lat');

check('русский уходит в английский', pickDirection('Привет мир', cfg).to, 'en');
check('английский уходит в русский', pickDirection('hello world', cfg).to, 'ru');
check('направление знает источник', pickDirection('Привет', cfg).from, 'ru');

check('словарь: знак равенства', parseGlossary('рагпул = rugpull'), [['рагпул', 'rugpull']]);
check('словарь: стрелка', parseGlossary('ликва -> liquidity'), [['ликва', 'liquidity']]);
check('словарь: мусорные строки отброшены', parseGlossary('просто строка\nа = б'), [['а', 'б']]);

check('разбор трёх секций', splitResult('Основной\n@@ALT@@\nВторой\n@@NOTE@@\n- заметка'), {
  main: 'Основной',
  alt: 'Второй',
  note: '- заметка'
});
check('разбор без секций', splitResult('Просто перевод'), { main: 'Просто перевод', alt: '', note: '' });
check('разбор только с альтернативой', splitResult('А\n@@ALT@@\nБ'), { main: 'А', alt: 'Б', note: '' });
check('разбор только с заметкой', splitResult('А\n@@NOTE@@\nВ'), { main: 'А', alt: '', note: 'В' });

// ——— пакетный режим ————————————————————————————————————————————
check('упаковка нумерует с нуля', packSegments(['Hi', 'Bye']), '⟦0⟧\nHi\n⟦1⟧\nBye');

check(
  'распаковка собирает все куски',
  [...unpackSegments('⟦0⟧\nПривет\n⟦1⟧\nПока', 2).entries()],
  [[0, 'Привет'], [1, 'Пока']]
);
check(
  'распаковка держит многострочный кусок',
  unpackSegments('⟦0⟧\nПервая\nвторая\n⟦1⟧\nХвост', 2).get(0),
  'Первая\nвторая'
);
check(
  'модель вернула не всё — берём что есть',
  [...unpackSegments('⟦0⟧\nПривет', 3).keys()],
  [0]
);
check(
  'выдуманный индекс за пределами пачки отброшен',
  [...unpackSegments('⟦0⟧\nА\n⟦9⟧\nМусор', 1).keys()],
  [0]
);
check('пустой ответ не ломает распаковку', [...unpackSegments('', 2).keys()], []);
check(
  'болтовня модели вокруг маркеров не попадает в текст',
  unpackSegments('Вот перевод:\n⟦0⟧\nПривет', 1).get(0),
  'Привет'
);

console.log(failed ? `\n${failed} провалено` : '\nвсе проверки прошли');
process.exit(failed ? 1 : 0);

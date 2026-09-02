/**
 * Разделы верхнего уровня: у каждого свой стек навигации.
 *
 * Проверяется рантайм устройства -- он и решает, что за кадр открыт, какой
 * стек активен и каким путём список читает записи. Объявление приложения
 * (`App`, `Screen`, порядок разделов) -- вопрос привязки, и он остался в
 * `tests/test_screens.py`: там объявляют, здесь исполняют.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { bindRow } from "../../web/src/react/bindrow.js";
import { поднятьРантайм, собратьБазу, поднятьФайл } from "./помощь.mjs";

const л = await import("../../../oneframework-js/index.mjs");
const { Button, List, Row, Screen, Tab, Tabs, app, boolean, date, declare, model,
        string, view } = л;

// --------------------------------------------------------------------------
// подопытные приложения
// --------------------------------------------------------------------------
const Note = model("Note", {
  fields: { title: string("Title", { required: true }), done: boolean("Done") },
});
const Person = model("Person", { fields: { name: string("Name", { required: true }) } });

const NoteItem = view("NoteItem", { model: Note, ui: (r) => Row(r.title({ widget: "title" })) });
const NoteDetail = view("NoteDetail", { model: Note, ui: (r) => [r.title(), r.done()] });
const Notes = view("Notes", { ui: () => [List(Note, { item: NoteItem, open: NoteDetail })] });
const PersonItem = view("PersonItem", { model: Person, ui: (r) => Row(r.name({ widget: "title" })) });
const People = view("People", { ui: () => [List(Person, { item: PersonItem })] });

const Grid = view("Grid", {
  ui: () => [List(Note, { item: NoteItem, open: NoteDetail, display: "table" })],
});

const Board = view("Board", {
  ui: () => [
    Button("Быстро", { action: Note.create({ open: NoteDetail, target: "sheet" }) }),
    Button("Медленно", { action: Note.create({ open: NoteDetail }) }),
  ],
});

const NoteRow = view("NoteRow", {
  model: Note,
  ui: (r) => Row(r.title({ widget: "title" }),
                 r.done({ widget: "checkbox", visible: r.done })),
});
const Ledger = view("Ledger", { ui: () => [List(Note, { item: NoteRow })] });

const Sections = view("Sections", {
  ui: () => [Tabs(
    Tab("Свои",
        Button({ place: "fab", action: Note.create({ values: { title: "Из вкладки" } }) }),
        List(Note, { item: NoteItem })),
    Tab("Чужие", List(Person, { item: PersonItem })),
  )],
});

const Card = view("Card", { model: Note, title: "", ui: (r) => [r.title()] });
const Desk = view("Desk", {
  title: "Стол",
  ui: () => [List(Note, { item: NoteItem, open: Card }),
             Button("Новая", { action: Note.create({ open: Card, draft: true }) })],
});

const Memo = model("Memo", {
  fields: { title: string("Заголовок", { required: true }), done: boolean("Выполнено"),
            due: date("Срок") },
});
/** Условие о колонке, которая есть у записи всегда. */
const SolidRow = view("SolidRow", {
  model: Memo,
  ui: (r) => Row(r.title({ widget: "title" }),
                 r.done({ widget: "checkbox", visible: r.done.not() })),
});
/** Пустая колонка под `is_null()`: неизвестности не возникает. */
const NullableRow = view("NullableRow", {
  model: Memo,
  ui: (r) => Row(r.title({ widget: "title" }),
                 r.done({ widget: "checkbox", visible: r.due.isNull() }),
                 r.due({ visible: r.due.isNull().not() })),
});
/** Пустая колонка в сравнении: SQL ответил бы неизвестностью. */
const CompareRow = view("CompareRow", {
  model: Memo,
  ui: (r) => Row(r.title({ widget: "title" }),
                 r.done({ widget: "checkbox", visible: r.due.ne("2026-02-01") })),
});

const приложение = (заголовок, экраны, модели, виды, корень) =>
  declare(app({ title: заголовок, models: модели, views: виды, screens: экраны, root: корень }));

const ДВА = приложение("Two",
  [Screen(Notes, { label: "Заметки", icon: "doc" }),
   Screen(People, { label: "Люди", icon: "people" })],
  [Note, Person], [NoteItem, NoteDetail, Notes, PersonItem, People], Notes);

const один = (заголовок, вид, модели, виды) =>
  приложение(заголовок, [Screen(вид)], модели, виды, вид);

//: Собранная база кэшируется по имени приложения: сборщик -- отдельный
//: процесс, и платить им за каждую проверку одного и того же приложения
//: незачем. Рантайм при этом всё равно свой у каждой: файл читается заново.
const СОБРАНО = new Map();
async function поднять(пакет) {
  if (!СОБРАНО.has(пакет.app.title)) СОБРАНО.set(пакет.app.title, собратьБазу(пакет));
  return поднятьФайл(СОБРАНО.get(пакет.app.title), пакет.app.screens ?? []);
}

const стек = (снимок) => снимок.stacks[снимок.active];

// --------------------------------------------------------------------------
// разделы и стеки
// --------------------------------------------------------------------------
test("список-таблица отказывается от раскладки надвое", async () => {
  // Спрашивается **снимок**, а не объявление. Раскладку решает нарисованное
  // дерево -- «единственное место, где дерево вообще существует», -- а дерево
  // есть только у того, кто рисует.
  const { rt } = await поднять(один("Grid", Grid, [Note], [NoteItem, NoteDetail, Grid]));
  assert.equal(rt.snapshot().screens[0].master_detail, false);
});

test("каждый раздел поднимается со своим стеком", async () => {
  const { rt } = await поднять(ДВА);
  const снимок = rt.snapshot();
  assert.equal(снимок.active, "Notes");
  assert.deepEqual(Object.keys(снимок.stacks).sort(), ["Notes", "People"]);
  assert.ok(Object.values(снимок.stacks).every((с) => с.length === 1));
  assert.equal(стек(снимок)[0].view, "Notes");
  assert.equal(снимок.stacks.People[0].view, "People");
});

/** Создать заметку и открыть её -- то, с чего начинается половина проверок. */
function открытьЗаметку(rt, db, модели) {
  const ключ = db.create(модели.Note, { title: "N" });
  rt.touch("Note");
  const списокId = стек(rt.snapshot())[0].children[0].id;
  rt.dispatch({ type: "open", list_id: списокId, record_id: ключ });
  return ключ;
}

test("переключение оставляет каждый стек там, где он был", async () => {
  const { rt, db, модели } = await поднять(ДВА);
  открытьЗаметку(rt, db, модели);
  assert.equal(rt.snapshot().stacks.Notes.length, 2);

  let снимок = rt.dispatch({ type: "switch_screen", key: "People" });
  assert.equal(снимок.active, "People");
  assert.equal(снимок.depth, 1);
  assert.equal(rt.snapshot().stacks.Notes.length, 2, "соседний раздел тронут");

  снимок = rt.dispatch({ type: "switch_screen", key: "Notes" });
  assert.equal(снимок.depth, 2, "раздел вернулся не туда, где был");
});

test("«назад» относится к открытому разделу", async () => {
  const { rt, db, модели } = await поднять(ДВА);
  открытьЗаметку(rt, db, модели);

  rt.dispatch({ type: "switch_screen", key: "People" });
  rt.dispatch({ type: "back" });            // People и так на своём корне
  assert.equal(rt.snapshot().stacks.People.length, 1);
  assert.equal(rt.snapshot().stacks.Notes.length, 2);

  rt.dispatch({ type: "switch_screen", key: "Notes" });
  rt.dispatch({ type: "back" });
  assert.equal(rt.snapshot().stacks.Notes.length, 1);
});

test("список в закрытом разделе всё равно находится", async () => {
  // События называют список, а не раздел; рантайм находит его в любом случае.
  const { rt } = await поднять(ДВА);
  const чужой = rt.snapshot().stacks.People[0].children[0].id;
  rt.dispatch({ type: "switch_screen", key: "People" });
  const [кадр, состояние] = rt.findList(чужой);
  assert.equal(кадр.viewName, "People");
  assert.equal(состояние.node.id, чужой);
});

test("неизвестный раздел отвергнут", async () => {
  const { rt } = await поднять(ДВА);
  assert.throws(() => rt.dispatch({ type: "switch_screen", key: "Nope" }), /Nope/);
});

test("back_to сворачивает стек до названного уровня", async () => {
  // Крошка называет уровень -- снимается всё, что лежит поверх него. Разом, а
  // не по кадру: десять раз посланное `back` -- это десять снимков и десять
  // переходов маршрутизатора там, где человек нажал один раз.
  const { rt, db, модели } = await поднять(ДВА);
  const ключ = db.create(модели.Note, { title: "N" });
  rt.touch("Note");
  const списокId = стек(rt.snapshot())[0].children[0].id;
  for (let i = 0; i < 3; i += 1) {
    rt.dispatch({ type: "open", list_id: списокId, record_id: ключ });
  }
  const [корень, второй] = rt.snapshot().stacks.Notes.slice(0, 2).map((к) => к.id);
  assert.equal(rt.snapshot().stacks.Notes.length, 4);

  const снимок = rt.dispatch({ type: "back_to", screen_id: второй });
  assert.deepEqual(rt.snapshot().stacks.Notes.map((к) => к.id), [корень, второй]);
  assert.equal(снимок.depth, 2);

  // Тот же уровень второй раз -- ничто. Ссылки у звена «здесь» нет, но
  // безобидным событие обязано быть и так: между снимком и нажатием лежит
  // круг через воркер.
  rt.dispatch({ type: "back_to", screen_id: второй });
  assert.deepEqual(rt.snapshot().stacks.Notes.map((к) => к.id), [корень, второй]);

  rt.dispatch({ type: "back_to", screen_id: корень });
  assert.deepEqual(rt.snapshot().stacks.Notes.map((к) => к.id), [корень]);
});

test("back_to отвергает кадр, которого в стеке нет", async () => {
  // Ключ кадра рендерер берёт из того же снимка, что и всё остальное. Значит
  // чужой ключ -- не устаревшая ссылка (тем занят `goto`, туда адрес приходит
  // снаружи), а ошибка отправителя. Молчание о ней читалось бы как «нажал, и
  // ничего не произошло», и объяснить это было бы нечем.
  const { rt, db, модели } = await поднять(ДВА);
  открытьЗаметку(rt, db, модели);
  const чужой = rt.snapshot().stacks.People[0].id;
  assert.throws(() => rt.dispatch({ type: "back_to", screen_id: чужой }),
                new RegExp(чужой));
  assert.equal(rt.snapshot().stacks.Notes.length, 2, "что-то снялось");
});

// --------------------------------------------------------------------------
// глубокая ссылка
// --------------------------------------------------------------------------
test("goto доходит прямо до записи", async () => {
  const { rt, db, модели } = await поднять(ДВА);
  const ключ = db.create(модели.Note, { title: "N" });
  rt.touch("Note");
  const снимок = rt.dispatch({ type: "goto", screen: "Notes",
                              path: [{ view: "NoteDetail", record_id: ключ }] });
  assert.equal(снимок.active, "Notes");
  assert.deepEqual(стек(снимок).map((к) => к.view), ["Notes", "NoteDetail"]);
  assert.equal(стек(снимок)[1].record_id, ключ);
});

test("goto выводит свой раздел вперёд", async () => {
  const { rt } = await поднять(ДВА);
  const снимок = rt.dispatch({ type: "goto", screen: "People", path: [] });
  assert.equal(снимок.active, "People");
  assert.equal(rt.snapshot().stacks.Notes.length, 1);
});

test("goto сохраняет кадры, которые адрес уже описывает", async () => {
  // Совпавшее начало остаётся тем же кадром, а не таким же. Кадр помнит, что
  // человек в нём делал: фильтр, сортировку, окно списка. Пересобранный заново
  // он показал бы ту же запись с начала, и «назад» браузера читалось бы как
  // «сбросить». Ключ кадра -- то, чем это видно.
  const { rt, db, модели } = await поднять(ДВА);
  открытьЗаметку(rt, db, модели);
  const открытый = rt.snapshot().stacks.Notes[1];
  const сюда = { type: "goto", screen: "Notes",
                 path: [{ view: "NoteDetail", record_id: открытый.record_id }] };

  rt.dispatch(сюда);
  assert.deepEqual(rt.snapshot().stacks.Notes.map((к) => к.id), ["s1", открытый.id]);
  // ...и тот же адрес во второй раз -- по-прежнему ничто.
  rt.dispatch(сюда);
  assert.deepEqual(rt.snapshot().stacks.Notes.map((к) => к.id), ["s1", открытый.id]);
  // Адрес короче -- снялось только лишнее.
  rt.dispatch({ type: "goto", screen: "Notes", path: [] });
  assert.deepEqual(rt.snapshot().stacks.Notes.map((к) => к.id), ["s1"]);
});

test("goto останавливается на шаге, который не выполнить", async () => {
  // Ссылка живёт в закладке дольше, чем вид с таким именем и запись с таким
  // ключом.
  const { rt, db, модели } = await поднять(ДВА);
  const ключ = db.create(модели.Note, { title: "N" });
  rt.touch("Note");

  // Записи нет: путь обрывается на ней, и хвост за ней не достраивается.
  let снимок = rt.dispatch({ type: "goto", screen: "Notes", path: [
    { view: "NoteDetail", record_id: "нет такой" },
    { view: "NoteDetail", record_id: ключ },
  ] });
  assert.deepEqual(стек(снимок).map((к) => к.view), ["Notes"]);

  // Вида нет -- то же самое. Исполнимый шаг после него нарочно: обрыв тем и
  // отличается от пропуска, что хвост за неисполнимым шагом не достраивается,
  // -- склеенный через пропуск стек описывал бы путь, которого не было.
  снимок = rt.dispatch({ type: "goto", screen: "Notes", path: [
    { view: "NoteDetail", record_id: ключ },
    { view: "Переименованный", record_id: ключ },
    { view: "NoteDetail", record_id: ключ },
  ] });
  assert.deepEqual(стек(снимок).map((к) => к.view), ["Notes", "NoteDetail"]);
});

test("goto отвергает неизвестный раздел", async () => {
  const { rt } = await поднять(ДВА);
  assert.throws(() => rt.dispatch({ type: "goto", screen: "Nope", path: [] }), /Nope/);
  // И раздела нет вовсе -- тот же отказ, а не подстановка текущего: адрес без
  // раздела не адрес, а «куда-нибудь», и открыть его гаданием значило бы
  // увести человека не туда молча.
  assert.throws(() => rt.dispatch({ type: "goto", path: [] }));
});

// --------------------------------------------------------------------------
// кадр и его имя
// --------------------------------------------------------------------------
test("кадр называет свой уровень даже когда бар не просит заголовка", async () => {
  // Заголовка нет у карточки записи: запись и есть страница, второй раз её имя
  // над ней не пишут. Спрашивает кадр не только бар -- крошка называет
  // уровень, и звено без слова было бы дырой в цепочке. Порядок проверяется
  // целиком: заголовок, пока он есть; иначе имя записи; и лишь в последнюю
  // очередь имя вида.
  //
  // Черновик -- третий случай, и он не тот же самый: записи у него ещё нет.
  // `display_name` на строке без ключа отдал бы не имя, а заглушку с решёткой
  // (`#null`), то есть разом и дыру в цепочке, и расхождение двух рантаймов на
  // ровном месте.
  const { rt, db, модели } = await поднять(
    один("Desk", Desk, [Note], [NoteItem, Card, Desk]));
  const ключ = db.create(модели.Note, { title: "Купить хлеб" });
  rt.touch("Note");

  const корень = стек(rt.snapshot())[0];
  assert.deepEqual([корень.title, корень.name], ["Стол", "Стол"]);

  let снимок = rt.dispatch({ type: "open", list_id: корень.children[0].id,
                             record_id: ключ });
  const карточка = стек(снимок)[1];
  assert.equal(карточка.title, "");
  assert.equal(карточка.name, "Купить хлеб");

  rt.dispatch({ type: "back" });
  const кнопка = стек(rt.snapshot())[0].children[1].id;
  снимок = rt.dispatch({ type: "action", button_id: кнопка, context: { screen_id: "s1" } });
  const черновик = стек(снимок).at(-1);
  assert.equal(черновик.draft, true);
  assert.equal(черновик.title, "");
  assert.equal(черновик.name, "Card");
});

test("один вид приходит тем способом, о котором попросило действие", async () => {
  const { rt } = await поднять(один("Board", Board, [Note], [NoteDetail, Board]));
  const кнопки = Object.fromEntries(стек(rt.snapshot())[0].children
.filter((c) => c.type === "button").map((c) => [c.label, c]));
  for (const [подпись, ждём] of [["Быстро", "sheet"], ["Медленно", "page"]]) {
    rt.dispatch({ type: "action", button_id: кнопки[подпись].id, context: {} });
    const верх = стек(rt.snapshot()).at(-1);
    assert.equal(верх.view, "NoteDetail");
    assert.equal(верх.target, ждём);
    rt.dispatch({ type: "back" });
  }
});

test("один вид строки рисует разные строки", async () => {
  // `visible=` на запись: что показывает завершённая заметка, того не
  // показывает открытая.
  const { rt, db, модели } = await поднять(
    один("Ledger", Ledger, [Note], [NoteRow, Ledger]));
  for (const [title, done] of [["Сделано", true], ["В работе", false]]) {
    db.create(модели.Note, { title, done });
  }
  rt.touch("Note");
  const узел = стек(rt.snapshot())[0].children[0];
  const нарисовано = Object.fromEntries((узел.rows || []).map((с) => {
    const строка = bindRow(узел.row, с);
    const ячейки = строка.children[0].children;
    return [ячейки[0].value, ячейки.filter((c) => c.visible).map((c) => c.name)];
  }));
  assert.deepEqual(нарисовано, { "Сделано": ["title", "done"], "В работе": ["title"] });
});

test("вкладка называет свою плавающую кнопку", async () => {
  // Она висит над экраном, а значит содержимым страницы вкладки не является.
  const { rt, db, модели } = await поднять(приложение("Sections", [Screen(Sections)],
    [Note, Person], [NoteItem, PersonItem, Sections], Sections));
  const вкладки = стек(rt.snapshot())[0].children[0];
  const [первая, вторая] = вкладки.children.filter((c) => c.type === "tab");
  assert.ok(первая.fab !== null && вторая.fab === null);
  assert.deepEqual(первая.children.filter((c) => c.type === "button"), []);

  rt.dispatch({ type: "action", button_id: первая.fab.id, context: первая.fab.context });
  assert.deepEqual(db.all(модели.Note).map((r) => r.title), ["Из вкладки"]);
});

// --------------------------------------------------------------------------
// строка списка: описание один раз, значения вектором
// --------------------------------------------------------------------------
const СТЕНЫ = {
  SolidRow: view("WallSolid", { ui: () => [List(Memo, { item: SolidRow })] }),
  NullableRow: view("WallNullable", { ui: () => [List(Memo, { item: NullableRow })] }),
  CompareRow: view("WallCompare", { ui: () => [List(Memo, { item: CompareRow })] }),
};
const СТРОКИ = { SolidRow, NullableRow, CompareRow };

/** Приложение с одной из трёх строк -- и записи в нём. */
async function стена(имя) {
  const стенаВид = СТЕНЫ[имя];
  const п = приложение(`Memos-${имя}`, [Screen(стенаВид)], [Memo],
                       [СТРОКИ[имя], стенаВид], стенаВид);
  const поднято = await поднять(п);
  const { rt, db, модели } = поднято;
  if (!db.count(модели.Memo)) {
    for (const [title, done, due] of [["Раз", false, "2026-02-01"], ["Два", true, null],
                                      ["Три", false, null]]) {
      db.create(модели.Memo, { title, done, due });
    }
  }
  rt.touch("Memo");
  return поднято;
}

/**
 * Одна перерисовка со счётом обращений к базе -> {select, query}.
 *
 * Считается **та** база, из которой список правда читает: подменять другую
 * значило бы мерить не то.
 */
function считаяПути(rt, db) {
  const счёт = { select: 0, query: 0 };
  const целое = { select: db.select.bind(db), query: db.query.bind(db) };
  db.select = (sql, params) => { счёт.select += 1; return целое.select(sql, params); };
  db.query = (m, sql, params, extra) => {
    счёт.query += 1; return целое.query(m, sql, params, extra);
  };
  try {
    // Перерисовать верхний кадр -- то, что делает эффект экрана, когда данные
    // под ним сдвинулись. Меряется именно одна перерисовка.
    rt.stack.at(-1)._render();
  } finally {
    db.select = целое.select;
    db.query = целое.query;
  }
  return счёт;
}

test("условие о своих непустых колонках отвечается запросом", async () => {
  // Правило, ради которого весь путь: переспросить условие можно у той же
  // таблицы, и только когда оно говорит о её колонках, которые есть всегда.
  const { rt, db } = await стена("SolidRow");
  const было = считаяПути(rt, db);
  assert.deepEqual([было.select, было.query], [1, 0], "условие не уехало в SQL");
});

test("is_null о пустой колонке отвечается запросом", async () => {
  // `IS NULL` -- та форма, где пустота и есть предмет вопроса. Отказ поимённо
  // («колонка бывает пустой») уводил такой список на построчный путь без
  // всякой причины: SQLite отвечает на `IS NULL` нулём или единицей при любом
  // содержимом колонки, и ровно это же считает `evaluate`.
  const { rt, db } = await стена("NullableRow");
  const было = считаяПути(rt, db);
  assert.deepEqual([было.select, было.query], [1, 0], "is_null() не уехал в SQL");
});

test("сравнение с пустой колонкой остаётся построчным", async () => {
  // NULL в SQL -- ни истина, ни ложь, а `evaluate` отвечает булевым. Пока эти
  // двое расходятся, сравнение с пустой колонкой в запрос не уходит: он
  // ответил бы иначе, и разошлись бы два рантайма молча, показав разные ячейки.
  const { rt, db } = await стена("CompareRow");
  const было = считаяПути(rt, db);
  assert.deepEqual([было.select, было.query], [0, 1], "сравнение с NULL ушло в SQL");
});

test("отказ, который он держит, -- настоящее расхождение, а не осторожность", async () => {
  // Условие `due != <дата>` считается двумя способами на одних и тех же
  // записях: колонкой `CASE WHEN` в SQL и построчным счётом. У записи без
  // срока ответы обязаны разойтись -- иначе общий отказ нечем было бы
  // оправдать, и сужать его было бы не от чего.
  const { rt, db, модели } = await стена("CompareRow");
  const { toJson } = await import("../../../oneframework-js/src/expr.mjs");
  const { recordProxy } = await import("../../../oneframework-js/src/model.mjs");
  const { conditionColumn } = await import("../../src/runtime/session.js");
  const { QueryContext, buildSelect, compileDomain } =
    await import("../../src/runtime/query.js");
  const { evaluate } = await import("../../src/expr.js");

  const узел = toJson(recordProxy(Memo).due.ne("2026-02-01"));
  const m = модели.Memo;
  assert.equal(conditionColumn(узел, m, new QueryContext(m)), null,
               "правило пустило его в SQL");

  // ...и вот что было бы, пусти оно: та же колонка, собранная руками.
  const ctx = new QueryContext(m);
  const [where, params] = compileDomain(узел, ctx);
  const [sql, всеПараметры] = buildSelect(m, ctx, [], `${ctx.alias}."id" ASC`,
    { columns: [[ctx.column(m.fields.id), []],
                [`(CASE WHEN ${where} THEN 1 ELSE 0 END)`, params]] });
  const вSql = Object.fromEntries(db.select(sql, всеПараметры).map((с) => [с[0], Boolean(с[1])]));
  const построчно = Object.fromEntries(
    db.all(m).map((r) => [r.id, Boolean(evaluate(узел, { record: r }))]));
  assert.notDeepEqual(вSql, построчно, "ответы сошлись -- отказ больше не нужен");
  const пустые = db.all(m).filter((r) => r.due === null).map((r) => r.id);
  assert.ok(пустые.length, "в наборе нет записи с пустым сроком");
  assert.ok(пустые.every((i) => вSql[i] === false && построчно[i] === true));
});

for (const имя of ["SolidRow", "NullableRow", "CompareRow"]) {
  test(`оба пути дают один вектор: ${имя}`, async () => {
    // Запросом и построчно -- один и тот же вектор, иначе выбор пути видно.
    const { rt } = await стена(имя);
    const { RowPlan } = await import("../../src/runtime/session.js");
    const узел = rt.stack.at(-1).tree.children[0];
    const быстро = (узел.rows || []).map((r) => ({ ...r }));

    const прежняя = RowPlan.prototype.projection;
    RowPlan.prototype.projection = () => null;
    try {
      rt.stack.at(-1)._render();
      assert.deepEqual(rt.stack.at(-1).tree.children[0].rows, быстро);
    } finally {
      RowPlan.prototype.projection = прежняя;
    }
    // ...и вектор действительно отвечает на условие, а не повторяет один ответ
    const нарисовано = (узел.rows || []).map((с) => {
      const ячейки = bindRow(узел.row, с).children[0].children;
      return ячейки.filter((c) => c.visible).map((c) => c.name).join(",");
    });
    assert.ok(new Set(нарисовано).size > 1, "все строки вышли одинаковыми");
  });
}

test("описание строки едет один раз", async () => {
  const { rt, db, модели } = await стена("SolidRow");
  const узел = rt.stack.at(-1).tree.children[0];
  assert.ok(узел.row.children.length, "описание строки не приехало");
  assert.equal(узел.row.cells, null);
  assert.deepEqual(узел.rows.map((r) => r.id), db.all(модели.Memo).map((r) => r.id));
  for (const строка of узел.rows) {
    // только значения: ни одного узла, ни одного номера узла
    assert.ok(строка.v.every((v) => v === null || typeof v !== "object" || Array.isArray(v)));
  }
});

/**
 * Повторитель, счётчик, меню и складывающийся блок в привязке на JavaScript.
 *
 * Что они дают тот же документ, что и питон, сверено побайтово при переносе на
 * приложении `Boards` из `tests/js/expand.test.mjs`. Здесь -- правила, которые
 * тем приложением не задеты: отказы, умолчания и разбор доводов.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseExpr } from "../../src/build/exprtext.mjs";

import {
  Accordion, Button, Delete, List, Menu, Pill, Repeat, Row,
  Tab, Tabs, boolean, many2one, model, parseTemplate, string, toJson, view, expr,
} from "../../../oneframework-js/index.mjs";

const Board = model("Board", { fields: { name: string("Название") } });
const Task = model("Task", {
  fields: { title: string("Задача"), done: boolean("Выполнено"),
            board: many2one(Board, "Список") },
});

/** Документ первого узла через настоящий вид: номера раздаёт он. */
const узел = (сделать) => view("V", { ui: сделать }).document().children[0];

// --------------------------------------------------------------- шаблоны
test("строка без ссылок остаётся строкой", () => {
  assert.equal(parseTemplate("Выполненные"), "Выполненные");
});

test("ссылка делает из строки шаблон", () => {
  assert.deepEqual(toJson(parseTemplate("Удалить «{item.name}»?")),
                   { fmt: ["Удалить «", { i: "name" }, "»?"] });
});

test("другие области названы, а не напечатаны скобками", () => {
  // Иначе строка приедет на экран с фигурными скобками, и никто не поймёт
  // почему.
  assert.throws(() => parseTemplate("Удалить «{record.name}»?"),
                /подставляется только «item\.<поле>»/);
});

// -------------------------------------------------------------- повторитель
test("повторитель требует тело функцией", () => {
  // Доводом, а не глобальной подстановкой: `item` привязан к модели этого
  // повторителя, и опечатка отказывает при сборке.
  assert.throws(() => Repeat(Board, Tab("Раз")), /тело -- функция/);
});

test("опечатка в поле повторителя отказывает по имени", () => {
  // Иначе она нарисует пустую вкладку, и связать пустоту с опечаткой нечем.
  assert.throws(() => узел(() => Repeat(Board, (item) => Tab(item.nmae))),
                /item\.nmae: у модели Board такого поля нет/);
});

test("id записи спрашивается, даже если поля с таким именем нет", () => {
  // `item.id` -- ключ записи, а не объявленное поле: без него домен вкладки
  // писать нечем.
  const вкладка = узел(() => Repeat(Board, (item) => Tab("Раз", List(Task, {
    domain: item.id,
  })))).children[0];
  assert.deepEqual(вкладка.children[0].domain, { i: "id" });
});

test("домен и порядок повторителя едут, только когда они есть", () => {
  const голый = узел(() => Repeat(Board, (item) => Tab("{item.name}")));
  assert.ok(!("domain" in голый) && !("order" in голый),
            "пустые ключи заняли место в документе");
});

// ------------------------------------------------------------------ счётчик
test("счётчик везёт вопрос, а не ответ", () => {
  // Число приезжает с данными, когда документ развёрнут; документ несёт запрос.
  const п = узел(() => Pill(expr("count(Task)")));
  // В документе -- строка: дерево из неё собирает сборка, и до устройства
  // доезжает оно. Здесь сверяется и то и другое: строка на месте, и она правда
  // свёртка, а не что-то похожее.
  assert.deepEqual(п.value, { text: "count(Task)" });
  assert.deepEqual(parseExpr(п.value.text), { agg: "count", model: "Task" });
});

test("считать нечего -- показывать нечего", () => {
  // Нулевой значок -- отметка на вкладке со словом «пусто», и обе платформы её
  // не рисуют вовсе.
  for (const пусто of [0, null, false]) {
    assert.equal(узел(() => Pill(пусто)).value, null, String(пусто));
  }
  assert.equal(узел(() => Pill(3)).value, "3");
});

test("счётчик знает, когда он уместен", () => {
  assert.equal(узел(() => Pill(3)).when, "always");
  assert.equal(узел(() => Pill(3, { when: "closed" })).when, "closed");
  assert.throws(() => Pill(3, { when: "иногда" }), /Pill\(when: "иногда"\)/);
});

// -------------------------------------------------------------------- меню
test("меню списка стоит на списке, а не среди детей", () => {
  const л = узел(() => List(Task, { menu: Menu(Button("Жать", { action: Delete() })) }));
  assert.equal(л.menu.type, "menu");
  assert.equal(л.menu.icon, "more_vert", "три точки -- умолчание обеих платформ");
  assert.deepEqual(л.menu.children.map((c) => c.type), ["button"]);
});

test("меню и его кнопки получают номера", () => {
  // Кнопку без номера нажать нечем, а обход раздаёт их одним проходом.
  const л = узел(() => List(Task, { menu: Menu(Button("Жать", { action: Delete() })) }));
  assert.equal(л.menu.id, "V.m1");
  assert.equal(л.menu.children[0].id, "V.b1");
});

test("списку в меню дают Menu, а не похожее", () => {
  assert.throws(() => List(Task, { menu: { children: [] } }), /List\(menu:\) ждёт Menu/);
});

test("место меню -- только бар", () => {
  assert.equal(узел(() => Menu(Button("Ж", { action: Delete() }), { place: "navbar" })).place,
               "navbar");
  assert.throws(() => Menu({ place: "внизу" }), /Menu\(place: "внизу"\)/);
});

// ----------------------------------------------------------- складной блок
test("складной блок начинается свёрнутым, пока не сказано иначе", () => {
  assert.equal(узел(() => Accordion(Row(), { label: "Выполненные" })).open, false);
  assert.equal(узел(() => Accordion(Row(), { open: true })).open, true);
});

test("условие раздела едет, только когда оно есть", () => {
  // Умолчание -- «виден»: ключ в документе значил бы, что кто-то это решал.
  assert.ok(!("visible" in узел(() => Accordion(Row(), { label: "Р" }))));
  const с = узел(() => Accordion(Row(), { visible: expr("exists(Task)") }));
  assert.deepEqual(с.visible, { text: "exists(Task)" });
  assert.deepEqual(parseExpr(с.visible.text), { agg: "exists", model: "Task" });
});

// ---------------------------------------------------------------- удаление
test("вопрос удаления бывает словами, «да» и шаблоном", () => {
  const вопрос = (confirm) => Delete({ model: Task, confirm }).document().confirm;
  assert.equal(вопрос(true), true);
  assert.equal(вопрос(false), false);
  assert.equal(вопрос("Точно?"), "Точно?");
  assert.deepEqual(вопрос("Удалить «{item.name}»?"),
                   { fmt: ["Удалить «", { i: "name" }, "»?"] });
});

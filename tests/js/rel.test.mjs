/**
 * Реляционный слой: смысл сохраняется, форма сливается, отказ называет причину.
 *
 * Проверки не спрашивают «напечатался ли SQL». Они исполняют его на настоящей
 * SQLite и смотрят на план запроса: коррелированный подзапрос в слитой выборке
 * -- это провал, даже если ответ верный.
 *
 * Здесь, а не на питоне, и это не переезд ради порядка. Питоновская половина
 * этой сюиты **подменяла функции хоста своими**: `oneframework_round`,
 * `pyupper` и `pylower` она объявляла питоном, и компилятор проверялся против
 * похожего хоста, а не против того, что стоит на устройстве. Здесь их ставит
 * `Database` -- те самые, что работают у пользователя. Заодно проверка ядра
 * перестала требовать питона на машине.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { canonical, compileExpr } from "../../src/rel/compile.js";
import {
  AccessPath, Mutation, compileRule, compileScreen,
} from "../../src/rel/plan.js";
import { Database } from "../../src/runtime/db.js";
import { sqlite } from "./помощь.mjs";

//: Исходы перевода и формы куска -- те же слова, что у компилятора.
const ТОЧНО = "EXACT_NATIVE";
const ПРИСПОСОБЛЕНО = "EXACT_ADAPTED";
const НЕ_УМЕЕМ = "UNSUPPORTED";
const ПО_СТРОКЕ = "ROW_SCALAR";
const СГРУППИРОВАНО = "GROUPED";
const РЕКУРСИЯ = "RECURSIVE";

let db = null;

/** Свежая база на каждую проверку: две из них правят данные. */
async function завести() {
  const sqlite3 = await sqlite();
  // Через `Database`, а не голым дескриптором: он ставит функции хоста
  // (`oneframework_round`, `oneframework_zero_division`, `pyupper`, `pylower`),
  // без которых база вела бы себя не так, как у пользователя.
  const о = new Database(new sqlite3.oo1.DB(":memory:"), { sqlite3 });
  о.connect().handle.exec(`
    CREATE TABLE board(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE task(id TEXT PRIMARY KEY, board TEXT, parent TEXT,
                      title TEXT, details TEXT, done INT, total INT);
    INSERT INTO board VALUES ('b1','Дом'),('b2','Пусто');
    INSERT INTO task VALUES
        ('t1','b1',NULL,'Крыша',NULL,0,4),
        ('t2','b1','t1','Стропила','есть',1,4),
        ('t3','b1','t2','Гвозди',NULL,0,4),
        ('t4','b1',NULL,'Забор','есть',1,0);
  `);
  return о;
}

/**
 * Строки ответа списками.
 *
 * Имена доводов приводятся к виду `:имя`: компилятор печатает их голыми
 * (`{root: "t1"}`), а `sqlite-wasm` требует того же знака, что стоит в самом
 * SQL. Драйвер питона прощал голое имя, и это единственное, чем перенос
 * отличается от исходной сюиты.
 */
function строки(sql, params = {}) {
  const из = [];
  const связь = {};
  for (const [к, з] of Object.entries(params)) {
    связь[":$@".includes(к[0]) ? к : `:${к}`] = з;
  }
  db.connect().handle.exec({
    sql, bind: Object.keys(связь).length ? связь : undefined,
    rowMode: "array", callback: (r) => { из.push(r); },
  });
  return из;
}

function план(sql, params = {}) {
  return строки(`EXPLAIN QUERY PLAN ${sql}`, params).map((r) => r[3]).join(" | ");
}

/** Отказ базы словами -- проверяем, что запрос **падает**, а не молчит. */
function падает(sql, params = {}) {
  try {
    строки(sql, params);
    return null;
  } catch (отказ) {
    return String(отказ.message || отказ);
  }
}

const экран = (table, {
  row_fields = {}, aggregates = [], consumer = "screen", key = "id",
} = {}) => compileScreen(table, { rowFields: row_fields, aggregates, consumer, key });

before(async () => { db = await завести(); });

// ==========================================================================
// каноническая форма: ради того, чтобы индекс по выражению совпадал
// ==========================================================================
describe("каноническая форма", () => {
  it("переставляемые доводы упорядочены", () => {
    const a = canonical({ op: "+", args: [{ field: "done" }, { field: "total" }] });
    const b = canonical({ op: "+", args: [{ field: "total" }, { field: "done" }] });
    assert.deepEqual(a, b);
    assert.equal(compileExpr(a, { table: "t" }).sql, compileExpr(b, { table: "t" }).sql);
  });

  it("непереставляемые оставлены как есть", () => {
    const minus = { op: "-", args: [{ field: "done" }, { field: "total" }] };
    assert.deepEqual(canonical(minus), minus);
    assert.equal(compileExpr(minus, { table: "t" }).sql, '("t"."done" - "t"."total")');
  });

  it("канон достаёт до условия свёртки", () => {
    const узел = { agg: "count", where: { op: "and", args: [{ field: "b" }, { field: "a" }] } };
    assert.deepEqual(canonical(узел).where.args[0], { field: "a" });
  });
});

// ==========================================================================
// исход перевода: смысл или отказ с именем
// ==========================================================================
describe("исход перевода", () => {
  it("«пусто ли» переводится точно", () => {
    const кусок = compileExpr({ op: "is_null", args: [{ field: "details" }] }, { table: "t" });
    assert.equal(кусок.status, ТОЧНО);
    assert.equal(кусок.form, ПО_СТРОКЕ);
    assert.deepEqual([...кусок.reads], ["details"]);
  });

  it("«не» о колонке, бывающей пустой, приспособлено, а не точно", () => {
    // `NOT NULL` даёт NULL -- третьего состояния на экране не бывает.
    const кусок = compileExpr({ op: "not", args: [{ field: "done" }] }, { table: "t" });
    assert.equal(кусок.status, ПРИСПОСОБЛЕНО);
    assert.ok(кусок.sql.includes("coalesce"));
  });

  it("склейка переживает пустоту", () => {
    const кусок = compileExpr(
      { op: "concat", args: [{ field: "title" }, { const: ": " }, { field: "details" }] },
      { table: "t" });
    assert.equal(кусок.status, ПРИСПОСОБЛЕНО);
    const [[значение]] = строки(
      `SELECT ${кусок.sql} FROM task "t" WHERE "t".id = :id`, { id: "t1" });
    assert.equal(значение, "Крыша: ");        // а не NULL
  });

  it("деление на ноль -- отказ, как в питоне", () => {
    // SQLite молча отдаёт пустоту, а молчание тут хуже отказа: пустая клетка
    // на экране выглядит как ответ, и заметит её пользователь, а не автор.
    const кусок = compileExpr({ op: "/", args: [{ field: "done" }, { field: "total" }] },
                              { table: "t" });
    assert.equal(кусок.status, ПРИСПОСОБЛЕНО);
    assert.ok(кусок.sql.includes("oneframework_zero_division"));
    const отказ = падает(`SELECT ${кусок.sql} FROM task "t" WHERE "t".id = :id`,
                         { id: "t4" });
    assert.ok(отказ, "запрос отдал пустую клетку вместо отказа");
  });

  it("невыбранная ветка не вычисляется", () => {
    // `x / total if total else 0` -- обычная запись, и она безопасна: ветка,
    // которую не выбрали, в SQLite не считается, поэтому деления на ноль у
    // пустого списка не происходит вовсе.
    const узел = { op: "if", args: [
      { field: "total" },
      { op: "/", args: [{ op: "*", args: [{ field: "done" }, { const: 100 }] },
                        { field: "total" }] },
      { const: 0 },
    ] };
    const кусок = compileExpr(узел, { table: "t" });
    const по = Object.fromEntries(строки(`SELECT "t".id, ${кусок.sql} FROM task "t"`));
    assert.equal(по.t2, 25);   // 1*100/4
    assert.equal(по.t4, 0);    // total = 0 -- деление не выполнялось
  });

  it("регистр кириллицы отвечает хост, а не отказ", () => {
    // `upper` у SQLite знает только ASCII: «крыша» он оставляет «крыша» и
    // ничего об этом не говорит. Похожий ответ здесь хуже отказа.
    const кусок = compileExpr({ op: "upper", args: [{ field: "title" }] }, { table: "t" });
    assert.notEqual(кусок.status, НЕ_УМЕЕМ);
    const [[значение]] = строки(
      `SELECT ${кусок.sql} FROM task "t" WHERE "t".id = :id`, { id: "t1" });
    assert.equal(значение, "КРЫША");
  });

  it("«начинается с» пишется срезом, а не LIKE", () => {
    // `LIKE` считает `%` в образце подстановкой и не различает регистр ASCII --
    // то есть отвечает **похоже**, а не то же.
    const кусок = compileExpr(
      { op: "startswith", args: [{ field: "title" }, { const: "Кры" }] }, { table: "t" });
    const по = Object.fromEntries(строки(`SELECT "t".id, ${кусок.sql} FROM task "t"`));
    assert.equal(по.t1, 1);
    assert.equal(по.t2, 0);
  });

  it("календарь рабочих дней отказывает по имени", () => {
    const кусок = compileExpr(
      { op: "add_workdays", args: [{ field: "title" }, { const: 3 }] }, { table: "t" });
    assert.deepEqual([...кусок.missing], ["workday_calendar"]);
  });

  it("худший исход берёт верх над всем узлом", () => {
    const узел = { op: "and", args: [
      { op: "is_null", args: [{ field: "details" }] },
      { op: "add_workdays", args: [{ field: "title" }, { const: 3 }] },
    ] };
    assert.equal(compileExpr(узел, { table: "t" }).status, НЕ_УМЕЕМ);
  });
});

// ==========================================================================
// экран: одна выборка, а не N подзапросов
// ==========================================================================
describe("экран", () => {
  it("поля строки становятся колонками одной выборки", () => {
    const с = экран("task", { row_fields: {
      vis_details: { op: "not", args: [{ field: "done" }] },
      has_details: { op: "not", args: [{ op: "is_null", args: [{ field: "details" }] }] },
    } });
    assert.equal(с.sql.split("SELECT").length - 1, 1);
    const по = Object.fromEntries(строки(с.sql, с.params).map((r) => [r[0], r.slice(-2)]));
    assert.deepEqual(по.t1, [0, 1]);   // has_details=0, vis_details=1
    assert.deepEqual(по.t2, [1, 0]);
  });

  it("свёртки сливаются в одну группировку", () => {
    const с = экран("board", { aggregates: [
      { name: "total", model: "task", via: "board", agg: "count" },
      { name: "done", model: "task", via: "board", agg: "count", where: { field: "done" } },
      { name: "open", model: "task", via: "board", agg: "count",
        where: { op: "not", args: [{ field: "done" }] } },
    ] });
    assert.equal(с.sql.split("GROUP BY").length - 1, 1);
    assert.equal(с.sql.split("LEFT JOIN").length - 1, 1);
    const по = Object.fromEntries(строки(с.sql, с.params).map((r) => [r[0], r.slice(2)]));
    // Порядок колонок -- **как объявлено**, а не по алфавиту: кадр читается по
    // позициям, и переставлять их сортировкой было бы ловушкой.
    assert.deepEqual(по.b1, [4, 2, 2]);   // total, done, open
    assert.deepEqual(по.b2, [0, 0, 0]);   // пустой список: нули, а не NULL
  });

  it("у слитого экрана нет коррелированного подзапроса", () => {
    const с = экран("board", { aggregates: [
      { name: "total", model: "task", via: "board", agg: "count" },
      { name: "done", model: "task", via: "board", agg: "count", where: { field: "done" } },
    ] });
    assert.ok(!план(с.sql, с.params).toUpperCase().includes("CORRELATED"));
  });

  it("экран требует путь доступа и не создаёт его сам", () => {
    const с = экран("board", { aggregates: [
      { name: "total", model: "task", via: "board", agg: "count" }] });
    assert.ok(!с.sql.includes("CREATE INDEX"));
    assert.deepEqual(с.access.map((a) => [a.table, [...a.prefix], a.reason, a.consumer]),
                     [["task", ["board"], "group_by", "screen.agg__task__board"]]);
  });

  it("путь доступа покрывается составным указателем", () => {
    const путь = new AccessPath("task", ["board"], "group_by", "screen");
    assert.ok(путь.satisfiedBy([["board", "done"]]));
    assert.ok(!путь.satisfiedBy([["done", "board"]]));
  });

  it("у непереведённого поля всё равно есть колонка", () => {
    // Форма кадра не зависит от того, что удалось перевести.
    const с = экран("task", { row_fields: {
      shout: { op: "add_workdays", args: [{ field: "title" }, { const: 3 }] },
    } });
    assert.deepEqual(Object.fromEntries(
      Object.entries(с.unsupported).map(([к, з]) => [к, [...з]])),
                     { shout: ["workday_calendar"] });
    const [строка] = строки(с.sql, с.params);
    assert.equal(строка[строка.length - 1], null);
  });
});

// ==========================================================================
// правило и изменение набора
// ==========================================================================
describe("правило и правка", () => {
  it("правило обходит дерево одним запросом", () => {
    const { piece, access } = compileRule(
      { name: "d", table: "task", via: "parent", seed: { param: "root", value: "t1" } });
    const [[собрано]] = строки(`${piece.sql} SELECT group_concat(id) FROM d`, piece.params);
    assert.deepEqual(собрано.split(",").sort(), ["t2", "t3"]);
    assert.equal(piece.form, РЕКУРСИЯ);
    assert.deepEqual([...access[0].prefix], ["parent"]);
  });

  it("правило останавливается на кольце в данных", async () => {
    // Кольцо заводится само: спор решается по колонкам.
    db = await завести();
    строки("UPDATE task SET parent='t3' WHERE id='t1'");
    const { piece } = compileRule(
      { name: "d", table: "task", via: "parent", seed: { param: "root", value: "t1" } });
    const [[сколько]] = строки(`${piece.sql} SELECT count(*) FROM d`, piece.params);
    assert.equal(сколько, 3);
  });

  it("правило с меняющимися колонками требует явного предела", () => {
    assert.throws(() => compileRule({
      name: "d", table: "task", via: "parent",
      columns: ["id", "depth"], seed: { param: "root" },
    }), /max_depth/);
  });

  it("правило с глубиной и пределом завершается", async () => {
    db = await завести();
    строки("UPDATE task SET parent='t3' WHERE id='t1'");
    const { piece } = compileRule({
      name: "d", table: "task", via: "parent", columns: ["id", "depth"],
      max_depth: 8, seed: { param: "root", value: "t1" },
    });
    const [[сколько]] = строки(`${piece.sql} SELECT count(*) FROM d`, piece.params);
    assert.equal(сколько, 9);
  });

  it("правка ложится на набор, который дало правило", async () => {
    db = await завести();
    const { piece } = compileRule(
      { name: "d", table: "task", via: "parent", seed: { param: "root", value: "t1" } });
    const правка = new Mutation("task", "d", { done: { const: 1 } }).compile(piece.sql);
    строки(правка.sql, { ...piece.params, ...правка.params });
    assert.deepEqual(строки("SELECT id FROM task WHERE done ORDER BY id").map((r) => r[0]),
                     ["t2", "t3", "t4"]);
  });

  it("правка отказывается от непереводимого значения", () => {
    assert.throws(() => new Mutation("task", "d", {
      title: { op: "add_workdays", args: [{ field: "title" }, { const: 3 }] },
    }).compile(), /workday_calendar/);
  });
});

// ==========================================================================
// корпус: обе разметки сразу
// ==========================================================================
describe("корпус gtasks", () => {
  it("частый путь переводится точно, отказ -- редкий и именной", async () => {
    db = await завести();
    const с = экран("task", {
      row_fields: {
        vis_details: { op: "not", args: [{ field: "done" }] },
        vis_finished: { field: "done" },
        no_details: { op: "is_null", args: [{ field: "details" }] },
        label: { op: "concat", args: [{ field: "title" }, { const: "!" }] },
        percent: { op: "if", args: [
          { field: "total" },
          { op: "/", args: [{ op: "*", args: [{ field: "done" }, { const: 100 }] },
                            { field: "total" }] },
          { const: 0 }] },
        shout: { op: "add_workdays", args: [{ field: "title" }, { const: 3 }] },
      },
      aggregates: [
        { name: "open", model: "task", via: "board", agg: "count",
          where: { op: "not", args: [{ field: "done" }] } },
      ],
    });
    const исход = Object.fromEntries(
      Object.entries(с.fields).map(([имя, [статус]]) => [имя, статус]));
    assert.equal(исход.vis_finished, ТОЧНО);
    assert.equal(исход.no_details, ТОЧНО);
    assert.equal(исход.open, ПРИСПОСОБЛЕНО);
    assert.equal(исход.shout, НЕ_УМЕЕМ);
    assert.deepEqual(Object.keys(с.unsupported), ["shout"]);
    assert.deepEqual(
      Object.entries(с.fields).filter(([, [, форма]]) => форма === СГРУППИРОВАНО)
        .map(([имя]) => имя), ["open"]);
    строки(с.sql, с.params);   // и он вправду исполняется
  });
});

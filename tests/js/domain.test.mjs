/**
 * Компилятор домена: правила той копии, что едет на устройство.
 *
 * Копия одна -- `src/core/rel/domain.js`. Питоновская держала эти правила, пока
 * была эталоном для сверки; держателем стала та, которую правда
 * исполняет пользователь.
 *
 * Правила, ради которых компилятор когда-то уезжал в WASM:
 *
 * 1. **UNSET расширяет выборку.** Через `&` часть выпадает, через `|` и `!`
 *    поглощает всё выражение. Именно на этом копии однажды и разошлись: SQL
 *    показывал все строки, а фронтенд прятал все -- ни исключения, ни записи.
 * 2. **`null` -- это не UNSET.** Он ставит условие, а не снимает.
 * 3. **Голой ссылкой может стоять только boolean.**
 * 4. **Любое пользовательское значение -- параметр `?`.**
 *
 * Правила от этого не менялись, а
 * каждое утверждение платило разбором JSON туда-обратно.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compileQuery } from "../../src/rel/domain.js";

const MODEL = {
  table: "line",
  fields: [
    { name: "text", column: "text", ftype: "string", stored: true },
    { name: "completed", column: "completed", ftype: "boolean", stored: true },
    { name: "rank", column: "rank", ftype: "integer", stored: true },
    { name: "due", column: "due", ftype: "date", stored: true },
    { name: "lines", column: null, ftype: "one2many", stored: false },
    { name: "id", column: "id", ftype: "uuid", stored: true },
  ],
};

const R = (имя) => ({ r: имя });
const V = (имя) => ({ v: имя });
const C = (op, l, r) => ({ op, l, r });
const UNSET = { unset: true };

/** Один домен -- один ответ. Псевдоним «t», модель одна на весь файл. */
function один(node, state = {}) {
  return compileQuery(JSON.stringify({
    ctx: { model: MODEL, state, alias: "t" },
    ops: [{ do: "domain", node }],
  }))[0];
}

describe("домен: правила", () => {
  it("UNSET снимает условие, а не сужает выборку", () => {
    assert.equal(один(C("=", R("rank"), V("missing"))).ok.sql, null);
    assert.equal(один(V("missing")).ok.sql, null);
  });

  it("UNSET выпадает из «и», но поглощает «или»", () => {
    // Скобки группы остаются: выпала часть, а не сама группа.
    assert.equal(один({ op: "&", p: [R("completed"), C("=", V("missing"), 3)] }).ok.sql,
                 '((t."completed" = 1))');
    assert.equal(один({ op: "|", p: [R("completed"), C("=", V("missing"), 3)] }).ok.sql,
                 null);
  });

  it("null ставит условие, а не снимает его", () => {
    assert.equal(один(C("=", R("text"), null)).ok.sql, '(t."text" IS NULL)');
    assert.equal(один(C("!=", R("text"), null)).ok.sql, '(t."text" IS NOT NULL)');
  });

  it("узел «пусто» превращается в IS NULL и только на колонке", () => {
    // Отдельно от `= null`: это разные узлы, и прежде прямой проверки
    // у `is_null` не было -- он попадал только в корпус, который верного
    // ответа не знает. Снятое правило оставляло сюиту зелёной.
    assert.equal(один({ op: "null", e: R("due") }).ok.sql, '(t."due" IS NULL)');
    assert.match(один({ op: "null", e: V("flag") }).error.message,
                 /only valid on a stored field/);
  });

  it("голой ссылкой может стоять только boolean", () => {
    assert.equal(один(R("completed")).ok.sql, '(t."completed" = 1)');
    assert.match(один(R("text")).error.message, /cannot stand on its own/);
  });

  it("действие переворачивается, когда колонка справа", () => {
    assert.equal(один(C("<", 3, R("rank"))).ok.sql, '(t."rank" > ?)');
    assert.equal(один(C(">=", 3, R("rank"))).ok.sql, '(t."rank" <= ?)');
  });

  it("любое значение -- параметр, никогда не текст запроса", () => {
    const ответ = один(C("=", R("text"), "'; DROP TABLE line--")).ok;
    assert.equal(ответ.sql, '(t."text" = ?)');
    assert.deepEqual(ответ.params, ["'; DROP TABLE line--"]);
    assert.deepEqual(ответ.cast, ["text"]);
  });

  it("истинность состояния экрана -- питоновская, а не JavaScript", () => {
    // `Boolean([])` в JS -- истина, в питоне -- ложь. Берётся питоновское:
    // условие пишет автор приложения, и правила его языка первичны.
    assert.equal(один(V("flag"), { flag: [] }).ok.sql, "(1=0)");
    assert.equal(один(V("flag"), { flag: [1] }).ok.sql, "(1=1)");
    assert.equal(один(V("flag"), { flag: "" }).ok.sql, "(1=0)");
  });

  it("несравнимые значения отвергаются, а не угадываются", () => {
    assert.match(один(C("<", null, false)).error.message, /not supported between/);
  });
});

describe("домен: порядок и выборка", () => {
  const прогнать = (ops, ctx = { model: MODEL, state: {}, alias: "t" }) =>
    compileQuery(JSON.stringify({ ctx, ops }));

  it("порядок получает устойчивый доводчик в ту же сторону", () => {
    const [о] = прогнать([{ do: "order", terms: [{ order: R("rank"), dir: "desc" }] }]);
    assert.equal(о.ok.sql, 't."rank" DESC, t."id" DESC');
  });

  it("выборка ставит id первым: строки читаются по месту", () => {
    const [о] = прогнать([{ do: "select", where: [], order: "" }]);
    assert.ok(о.ok.sql.startsWith('SELECT t."id", t."text"'), о.ok.sql);
  });

  it("сломанная работа не уносит соседнюю", () => {
    const ответы = прогнать([{ do: "domain", node: { op: "??" } },
                             { do: "domain", node: R("completed") }]);
    assert.ok("error" in ответы[0]);
    assert.ok("ok" in ответы[1]);
  });
});

// ==========================================================================
// корпус: охват, а не верность
// ==========================================================================
const ДОМЕНЫ = [
  null, true, false, 0, 1, "text", [], {},
  R("completed"), R("text"), R("rank"), R("lines"),
  V("flag"), V("missing"), UNSET,
  { op: "!", e: R("completed") }, { op: "!", e: V("missing") },
  { op: "null", e: R("due") }, { op: "null", e: V("flag") },
  { op: "&", p: [R("completed"), C(">", R("rank"), 3)] },
  { op: "&", p: [R("completed"), C("=", V("missing"), 3)] },
  { op: "&", p: [] },
  { op: "|", p: [R("completed"), C("=", V("missing"), 3)] },
  { op: "|", p: [R("completed"), C(">", R("rank"), 1)] },
  { op: "|", p: [] },
  { op: "&", p: [{ op: "&", p: [R("completed"), C(">", R("rank"), 1)] },
                 C("<", R("rank"), 9)] },
  C("=", R("text"), null), C("!=", R("text"), null),
  C("<", R("text"), null), C(">", R("rank"), null),
  C("=", 3, R("rank")), C("<", 3, R("rank")), C("<=", 3, R("rank")),
  C(">", 3, R("rank")), C(">=", 3, R("rank")), C("!=", 3, R("rank")),
  C("=", R("rank"), R("rank")), C("<", R("rank"), R("due")),
  C("=", 1, 1), C("=", 1, 2), C("<", "a", "b"), C("<", [1, 2], [1, 3]),
  C("<", null, false), C("=", null, false), C("<", "a", 1),
  C("=", UNSET, R("rank")), C("=", R("rank"), UNSET),
  C("=", V("missing"), V("missing")),
  { op: "??", l: 1, r: 2 }, { i: "name" },
  C("=", R("nosuch"), 1), C("=", R("lines"), 1), { fmt: ["x"] },
];

const СОСТОЯНИЯ = [
  {}, { flag: true }, { flag: false }, { flag: null }, { flag: 0 },
  { flag: "" }, { flag: [] }, { flag: {} }, { flag: [1] },
  { flag: { unset: true } }, { flag: "текст" },
];

const ПОРЯДКИ = [
  [], [R("rank")], [{ order: R("rank"), dir: "desc" }],
  [{ order: R("rank"), dir: "asc" }, { order: R("due"), dir: "desc" }],
  [{ order: R("due"), dir: "desc" }, { order: R("rank"), dir: "asc" }],
  [R("lines")], [V("flag")],
];

const ПОИСКИ = [
  [[], ""], [["text"], ""], [["text"], "  "], [["text"], "Чай"],
  [["text", "due"], "abc"], [["lines"], "abc"], [["nosuch"], "abc"],
  [[R("text")], "abc"],
];

const ВЫБОРКИ = [
  { do: "select", where: [], order: "" },
  { do: "select", where: [null, '(t."completed" = 1)'], order: 't."id" ASC' },
  { do: "select", where: [], order: "", limit: 5, offset: 0 },
  { do: "select", where: [], order: "", limit: 5, offset: 40 },
  { do: "select", where: [], order: "", offset: 40 },
  { do: "select", columns: ['t."id"', '(CASE WHEN (t."rank" > ?) THEN 1 ELSE 0 END)'],
    where: [null], order: "" },
  { do: "select", columns: [], where: [], order: "" },
];

describe("домен: корпус", () => {
  it("компилятор отвечает на весь поток, не ломаясь", () => {
    // Правила выше берут по одному запросу и знают верный ответ. Корпус берёт
    // восемь сотен и верного ответа не знает -- он ловит другое: запрос, на
    // котором компилятор ломается вместо того, чтобы ответить или отказать.
    const запросы = [];
    for (const state of СОСТОЯНИЯ) {
      const ops = [
...ДОМЕНЫ.map((node) => ({ do: "domain", node })),
...ПОРЯДКИ.map((terms) => ({ do: "order", terms })),
...ПОИСКИ.map(([fields, text]) => ({ do: "search", fields, text })),
...ВЫБОРКИ,
      ];
      запросы.push({ ctx: { model: MODEL, state, alias: "t" }, ops });
    }
    // Без модели вовсе и с другим псевдонимом -- оба случая живые.
    запросы.push({ ctx: { model: null, state: {}, alias: "t" },
                   ops: [{ do: "domain", node: R("rank") },
                         { do: "domain", node: C("=", 1, 1) },
                         { do: "select", where: [], order: "" }] });
    запросы.push({ ctx: { model: MODEL, state: {}, alias: "a" },
                   ops: [{ do: "domain", node: R("completed") },
                         { do: "order", terms: [R("rank")] },
                         { do: "select", where: [], order: "" }] });

    let отвечено = 0;
    for (const запрос of запросы) {
      for (const ответ of compileQuery(JSON.stringify(запрос))) {
        assert.ok("ok" in ответ || "error" in ответ, JSON.stringify(ответ));
        отвечено += 1;
      }
    }
    assert.ok(отвечено > 700, `корпус выродился: ${отвечено}`);
  });
});

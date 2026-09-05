/**
 * Показ и отбор решают одинаково: вычислитель фронтенда против выборки.
 *
 * Язык печатает пятнадцать родов узлов. Выборка читает их все -- это сторожит
 * `tests/js/grammar.test.mjs`. Вычислитель на фронтенде, который решает
 * «показывать ли это поле», читал шесть: арифметики у него не было вовсе.
 * Условие `visible = length(record.title) > 3` собиралось, доезжало до
 * устройства и падало там -- вслух, но у пользователя.
 *
 * Здесь второй сторож: тот же документ и та же запись отдаются обоим, и ответ
 * обязан совпасть. Выборка считает **настоящей базой устройства**, а не
 * подделкой: у неё свои функции с питоновской семантикой -- округление к
 * чётному и отказ на делении на ноль, -- и повторять их в проверке значило бы
 * завести третью запись тех же правил.
 *
 * Регистр (`lower`, `upper`, `casefold`) сюда не входит намеренно: у выборки
 * его ставят свои функции, а `toLowerCase()` совпадает с ними не везде.
 * Вычислитель отказывает по имени -- проверено ниже.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { compileExpr } from "../../src/rel/compile.js";
import { evaluate } from "../../src/expr.js";
import { Database } from "../../src/runtime/db.js";
import { sqlite } from "./помощь.mjs";

const П = (имя) => ({ r: имя });

/** Выражение, запись -- и ответ, посчитанный обоими. */
const СЛУЧАИ = {
  "длина строки": [{ op: ">", l: { op: "length", args: [П("title")] }, r: 3 },
                   { title: "Привет", n: 7, price: 10.5 }],
  "длина короткой": [{ op: ">", l: { op: "length", args: [П("title")] }, r: 30 },
                     { title: "Привет", n: 7, price: 10.5 }],
  "умножение": [{ op: "=", l: { op: "*", args: [П("n"), 2] }, r: 14 }, { n: 7 }],
  "сложение": [{ op: "=", l: { op: "+", args: [П("n"), 1] }, r: 8 }, { n: 7 }],
  "вычитание": [{ op: "=", l: { op: "-", args: [П("n"), 1] }, r: 6 }, { n: 7 }],
  "деление": [{ op: "=", l: { op: "/", args: [П("n"), 2] }, r: 3.5 }, { n: 7 }],
  "деление на ноль": [{ op: "null", e: { op: "/", args: [П("n"), 0] } }, { n: 7 }],
  "целочисленное": [{ op: "=", l: { op: "//", args: [П("n"), 2] }, r: 3 }, { n: 7 }],
  "остаток": [{ op: "=", l: { op: "%", args: [П("n"), 2] }, r: 1 }, { n: 7 }],
  "остаток отрицат": [{ op: "=", l: { op: "%", args: [П("m"), 2] }, r: 1 }, { m: -7 }],
  "степень": [{ op: "=", l: { op: "**", args: [П("n"), 2] }, r: 49 }, { n: 7 }],
  "минус": [{ op: "=", l: { op: "neg", args: [П("n")] }, r: -7 }, { n: 7 }],
  "модуль": [{ op: "=", l: { op: "abs", args: [{ op: "neg", args: [П("n")] }] }, r: 7 },
             { n: 7 }],
  "округление вниз": [{ op: "=", l: { op: "round", args: [2.5] }, r: 2 }, { n: 1 }],
  "округление вверх": [{ op: "=", l: { op: "round", args: [3.5] }, r: 4 }, { n: 1 }],
  "начинается с": [{ op: "startswith", args: [П("title"), "При"] }, { title: "Привет" }],
  "не начинается": [{ op: "startswith", args: [П("title"), "нет"] }, { title: "Привет" }],
  "кончается на": [{ op: "endswith", args: [П("title"), "вет"] }, { title: "Привет" }],
  "кончается пустым": [{ op: "endswith", args: [П("title"), ""] }, { title: "Привет" }],
  "замена": [{ op: "=", l: { op: "replace", args: [П("title"), "и", "ы"] }, r: "Прывет" },
             { title: "Привет" }],
  "к тексту": [{ op: "=", l: { op: "text", args: [П("n")] }, r: "7" }, { n: 7 }],
  "к целому": [{ op: "=", l: { op: "integer", args: [П("price")] }, r: 10 },
               { price: 10.5 }],
  "длина с эмодзи": [{ op: "=", l: { op: "length", args: [П("title")] }, r: 3 },
                     { title: "аб🙂" }],
  "пусто в доводе": [{ op: "null", e: { op: "+", args: [П("n"), 1] } },
                     { title: "Привет", n: null }],
};

describe("показ и отбор решают одинаково", () => {
  let sqlite3;
  before(async () => { sqlite3 = await sqlite(); });

  /** То же выражение, но собранное в SQL и прогнанное на одной строке. */
  function выборкой(node, record) {
    const handle = new sqlite3.oo1.DB(":memory:");
    const db = new Database(handle, { sqlite3, journal: "DELETE" });
    try {
      const колонки = Object.keys(record);
      const имена = колонки.map((к) => `"${к}"`).join(", ");
      db.connect().execute(`CREATE TABLE "t" (${имена})`);
      db.connect().execute(
        `INSERT INTO "t" (${имена}) VALUES (${колонки.map(() => "?").join(", ")})`,
        колонки.map((к) => record[к]));
      const кусок = compileExpr(node, {});
      const есть = Object.keys(кусок.params || {}).length > 0;
      const v = есть
        ? db.connect().scalar(`SELECT (${кусок.sql}) FROM "t"`, кусок.params)
        : db.connect().scalar(`SELECT (${кусок.sql}) FROM "t"`);
      return { ok: v === null || v === undefined ? null : Boolean(v) };
    } catch (о) {
      return { error: String(о.message || о) };
    } finally {
      handle.close();
    }
  }

  for (const [имя, [node, record]] of Object.entries(СЛУЧАИ)) {
    it(имя, () => {
      const отбор = выборкой(node, record);
      if ("error" in отбор) {
        assert.throws(() => evaluate(node, { record }), /division by zero/);
        assert.match(отбор.error, /division by zero/);
        return;
      }
      assert.equal(evaluate(node, { record }), отбор.ok,
                   `показ и отбор разошлись: ${JSON.stringify(отбор)}`);
    });
  }

  for (const слово of ["lower", "upper", "casefold"]) {
    it(`регистр «${слово}» здесь не считается -- отказ по имени`, () => {
      // Ответить «примерно так же» хуже, чем отказать: показ и отбор разошлись
      // бы на одной и той же записи, а увидел бы это пользователь.
      const узел = { op: "=", l: { op: слово, args: [П("title")] }, r: "привет" };
      assert.throws(() => evaluate(узел, { record: { title: "Привет" } }),
                    /не считается/);
    });
  }
});

/**
 * То же выражение, но **выборкой**: собрать SQL и прогнать на одной строке.
 *
 * Нужен, чтобы сверить двух читателей одного документа: показ на фронтенде
 * (`core/expr.js`, решает «рисовать ли это поле») и отбор в базе
 * (`core/rel/compile.js`, решает «какие записи взять»). Расходились они
 * молча: язык печатает пятнадцать родов узлов, отбор читает все, а показ
 * читал шесть -- арифметики у него не было вовсе.
 *
 * Через настоящую базу устройства, а не питоновский `sqlite3`: у выборки есть
 * свои функции с питоновской семантикой -- округление к чётному и отказ на
 * делении на ноль, -- и повторять их в проверке значило бы завести третью
 * запись тех же правил. Сверять надо с той базой, что стоит на устройстве.
 *
 * Читает со stdin `{"cases": [{"node": ..., "record": {...}}, ...]}` и пишет
 * список ответов: `{"ok": true|false|null}` либо `{"error": "..."}`.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { compileExpr } from "../../src/rel/compile.js";
import { Database } from "../../src/runtime/db.js";

const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });

let raw = "";
process.stdin.setEncoding("utf8");
for await (const кусок of process.stdin) raw += кусок;

const вход = JSON.parse(raw);
const ответы = [];
for (const { node, record } of вход.cases) {
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
    // Пустой перечень подстановок -- не пустой объект: sqlite отвечает «нечего
    // подставлять», если у запроса нет мест, а объект ему всё равно подали.
    const есть = Object.keys(кусок.params || {}).length > 0;
    const v = есть
      ? db.connect().scalar(`SELECT (${кусок.sql}) FROM "t"`, кусок.params)
      : db.connect().scalar(`SELECT (${кусок.sql}) FROM "t"`);
    ответы.push({ ok: v === null || v === undefined ? null : Boolean(v) });
  } catch (о) {
    ответы.push({ error: String((о && о.message) || о) });
  } finally {
    handle.close();
  }
}
process.stdout.write(JSON.stringify(ответы));

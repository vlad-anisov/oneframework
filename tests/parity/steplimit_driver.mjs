/**
 * Предел шагов у базы устройства: арифметика и настоящий обрыв.
 *
 * Правило было записано дважды -- у питоновской базы и здесь, -- а сторожила
 * его только питоновская. Проверено мутацией 21.08.2026: снятый предел в
 * `db.js` оставлял всю сюиту зелёной. То есть беззащитной была живая половина.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { Database, STEP_LIMIT, STEP_TICK, stepBudget } from "../../src/runtime/db.js";

const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const ответ = { budget: {}, runaway: null };

// Арифметика без часов: счётчику вызовов положено быть во столько раз меньше
// предела, во сколько крупен шаг сторожа.
ответ.budget = {
  default: stepBudget(),
  limit: STEP_LIMIT,
  tick: STEP_TICK,
  small: stepBudget(2_000_000),
};

// И настоящий обрыв. Предел маленький нарочно: правило от величины не зависит,
// а боевое значение резало бы запрос секундами.
const db = new Database(new sqlite3.oo1.DB(":memory:"), { sqlite3, stepLimit: 5_000 });
try {
  db.connect().execute(
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c");
  ответ.runaway = "запрос досчитал -- предела нет";
} catch (err) {
  ответ.runaway = String(err && err.message);
}
// Предел -- на **запрос**, а не на всю сессию. Иначе приложение, поработавшее
// час, начинало бы обрываться на обычных выборках: остаток счётчика съеден
// прошлыми запросами, и виноватым выглядит последний.
//
// Запрос нарочно дорогой: на дешёвом сторож не зовётся ни разу, счётчик не
// двигается, и проверка проходит на любой реализации -- в том числе на той,
// где сброса нет вовсе (проверено мутацией: первая редакция была пустой).
const db2 = new Database(new sqlite3.oo1.DB(":memory:"), { sqlite3, stepLimit: 2_000_000 });
const con2 = db2.connect();
con2.execute("CREATE TABLE t(x INTEGER)");
con2.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 20000) "
             + "INSERT INTO t SELECT i FROM n");
const полный = stepBudget(2_000_000);
con2.execute("SELECT count(*) FROM t WHERE x % 7 = 0");
const съедено = полный - db2._stepsLeft;
db2.resetStepLimit();
ответ.perQuery = { budget: полный, spent: съедено, afterReset: db2._stepsLeft };

process.stdout.write(JSON.stringify(ответ));

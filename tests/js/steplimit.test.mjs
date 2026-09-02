/**
 * Предел шагов у базы устройства: убегающий запрос обязан обрываться.
 *
 * Без предела неудачное условие по связи вешает приложение наглухо, и снаружи
 * это выглядит не ошибкой, а «зависло»: жаловаться будет тот, кто формулу не
 * писал и починить её не может.
 *
 * Правило было записано дважды -- у питоновской базы и у той, что на
 * устройстве. Сторожила его только питоновская. Проверено мутацией: снятый
 * предел в `db.js` оставлял **всю сюиту зелёной**, то есть беззащитной была
 * живая половина.
 *
 * Арифметика проверяется отдельно от обрыва и без часов. Спутай здесь шаги
 * с вызовами сторожа -- предел выйдет в тысячу раз выше названного, 20
 * миллиардов шагов вместо 20 миллионов, и убегающий запрос срежется через 177
 * секунд. Ровно то «зависло», от которого предел и заводили.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  Database, STEP_LIMIT, STEP_TICK, stepBudget,
} from "../../src/runtime/db.js";
import { sqlite } from "./помощь.mjs";

describe("предел шагов", () => {
  it("предел называется шагами -- значит и считает шаги", () => {
    assert.equal(stepBudget(), Math.floor(STEP_LIMIT / STEP_TICK));
    assert.equal(stepBudget(2_000_000), 2_000,
                 "предел в 2 млн шагов -- это 2 000 вызовов сторожа");
  });

  it("предел стоит по умолчанию, а не только когда его задали", async () => {
    // Проверки ниже задают свой предел -- маленький, чтобы обрыв был быстрым.
    // На умолчании они поэтому ничего не говорят, и снятое умолчание оставляло
    // их зелёными: приложение осталось бы без предела, а «зависло» вернулось.
    const sqlite3 = await sqlite();
    const db = new Database(new sqlite3.oo1.DB(":memory:"), { sqlite3 });
    assert.equal(db._stepsLeft, stepBudget(), "по умолчанию предела нет");
    assert.ok(Number.isFinite(STEP_LIMIT) && STEP_LIMIT > 0, STEP_LIMIT);
  });

  it("убегающий запрос прерывается, а не считает вечно", async () => {
    const sqlite3 = await sqlite();
    // Предел маленький нарочно: правило от величины не зависит, а боевое
    // значение резало бы запрос секундами.
    const db = new Database(new sqlite3.oo1.DB(":memory:"), { sqlite3, stepLimit: 5_000 });
    let ответ = "запрос досчитал -- предела нет";
    try {
      db.connect().execute(
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) "
        + "SELECT count(*) FROM c");
    } catch (о) {
      ответ = String(о && о.message);
    }
    assert.match(ответ.toLowerCase(), /interrupted/, ответ);
  });

  it("предел -- на запрос, а не на всю сессию", async () => {
    // Копись он -- приложение, поработавшее час, начинало бы обрываться на
    // обычных выборках, и виноватым выглядел бы последний запрос, а не все
    // прошлые вместе.
    const sqlite3 = await sqlite();
    const db = new Database(new sqlite3.oo1.DB(":memory:"),
                            { sqlite3, stepLimit: 2_000_000 });
    const con = db.connect();
    con.execute("CREATE TABLE t(x INTEGER)");
    // Запрос нарочно дорогой: на дешёвом сторож не зовётся ни разу, счётчик не
    // двигается, и проверка проходит на любой реализации -- в том числе на
    // той, где сброса нет вовсе (поймано мутацией: первая редакция была такой).
    con.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n "
                + "WHERE i < 20000) INSERT INTO t SELECT i FROM n");
    const полный = stepBudget(2_000_000);
    con.execute("SELECT count(*) FROM t WHERE x % 7 = 0");
    const съедено = полный - db._stepsLeft;
    db.resetStepLimit();

    assert.ok(съедено > 0, `счётчик не двигался -- проверять нечего: ${съедено}`);
    assert.equal(db._stepsLeft, полный);
  });
});

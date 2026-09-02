/**
 * Определения в базе устройства: отпечаток, ревизия и «что вам не доехало».
 *
 * Правила были записаны дважды -- у питоновского писателя и у того, что на
 * устройстве. Сторожила их только питоновская запись. Проверено мутацией: и
 * «ревизия растёт только на настоящую правку», и сам её рост можно было снять
 * в `defs.js`, оставив **всю сюиту зелёной**.
 *
 * Почему эти правила важны:
 *
 * * **отпечаток от смысла, а не от записи.** Переставь ключи в документе -- и
 *   обмен повёз бы то же самое ещё раз, всем устройствам;
 * * **ревизия растёт только на настоящую правку.** По ней устройство решает,
 *   чьё определение новее; растущая на пустом месте делает старое новым;
 * * **`changedSince` отвечает на вопрос доставки.** Ответь она «всё» -- обмен
 *   возит определения кругами; ответь «ничего» -- новое не доезжает вовсе.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { Database } from "../../src/runtime/db.js";
import {
  allDefs, changedSince, fingerprint, get, put,
} from "../../src/runtime/defs.js";
import { sqlite } from "./помощь.mjs";

const ВИД = {
  type: "view", name: "X", children: [], crumbs: null, dismiss: null,
  model: null, state: [], title: "X", title_is_code: false,
};

describe("определения в базе", () => {
  let db;
  let выкладки;

  before(async () => {
    const sqlite3 = await sqlite();
    db = new Database(new sqlite3.oo1.DB(":memory:"), { sqlite3 });
    выкладки = {
      first: put(db, "view", "X", ВИД),
      again: put(db, "view", "X", ВИД),
      changed: put(db, "view", "X", { ...ВИД, title: "Другой" }),
    };
  });

  it("отпечаток -- от смысла, а не от записи", () => {
    assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }),
                 "переставленные ключи дали другой отпечаток");
    assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }),
                    "изменение значения отпечаток не заметил");
  });

  it("положить тот же документ дважды -- не правка", () => {
    // Иначе каждая сборка возила бы всем устройствам то же самое заново.
    assert.equal(выкладки.first, true, "первая выкладка не признана правкой");
    assert.equal(выкладки.again, false, "повтор того же признан правкой");
    assert.equal(выкладки.changed, true, "настоящая правка не признана правкой");
  });

  it("ревизия растёт только на настоящую правку", () => {
    // По ней устройство решает, чьё определение новее.
    const ревизии = Object.fromEntries(allDefs(db).map((r) => [r.name, r.revision]));
    assert.equal(ревизии.X, 2,
                 `три выкладки, из них две разные -> ревизия 2: ${JSON.stringify(ревизии)}`);
  });

  it("лежит последнее написанное", () => {
    assert.equal(get(db, "view", "X").title, "Другой");
  });

  it("changedSince отвечает на вопрос доставки", () => {
    // Собеседнику везём только то, чего у него нет.
    const свои = Object.fromEntries(
      allDefs(db).map((r) => [`${r.kind}/${r.name}`, r.fingerprint]));
    assert.equal(changedSince(db, {}).length, 1, "не знающему ничего не повезли ничего");
    assert.equal(changedSince(db, свои).length, 0, "знающему всё повезли лишнее");
  });

  it("вид определения -- закрытый список: чужой не ложится молча", () => {
    assert.throws(() => put(db, "выдумка", "x", {}), /выдумка/);
  });
});

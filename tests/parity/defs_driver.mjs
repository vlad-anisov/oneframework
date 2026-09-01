/**
 * Определения в базе устройства: отпечаток, ревизия и «что вам ещё не доехало».
 *
 * Правила были записаны дважды -- у питоновского писателя (`model/defs.py`) и
 * здесь. Сторожила их только питоновская запись. Проверено мутацией
 * 21.08.2026: и «ревизия растёт только на настоящую правку», и сам рост можно
 * было снять, оставив всю сюиту зелёной. Беззащитной была живая половина.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { Database } from "../../src/runtime/db.js";
import { allDefs, changedSince, fingerprint, get, put } from "../../src/runtime/defs.js";

const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const db = new Database(new sqlite3.oo1.DB(":memory:"), { sqlite3 });

const ВИД = {
  type: "view", name: "X", children: [], crumbs: null, dismiss: null,
  model: null, state: [], title: "X", title_is_code: false,
};

const ответ = {};

// Отпечаток -- от смысла, а не от записи: порядок ключей ничего не значит.
ответ.fingerprint = {
  sameOrder: fingerprint({ a: 1, b: 2 }) === fingerprint({ b: 2, a: 1 }),
  realChange: fingerprint({ a: 1 }) !== fingerprint({ a: 2 }),
};

// Первая выкладка -- правка; повтор того же -- нет.
ответ.put = {
  first: put(db, "view", "X", ВИД),
  again: put(db, "view", "X", ВИД),
  changed: put(db, "view", "X", { ...ВИД, title: "Другой" }),
};

ответ.revisions = allDefs(db).map((r) => [r.name, r.revision]);
ответ.stored = get(db, "view", "X");

// Что собеседнику ещё не доехало: сравнение по отпечаткам, без разбора тела.
const свои = Object.fromEntries(allDefs(db).map((r) => [`${r.kind}/${r.name}`, r.fingerprint]));
ответ.changedSince = {
  nothingKnown: changedSince(db, {}).length,
  allKnown: changedSince(db, свои).length,
};

try {
  put(db, "выдумка", "x", {});
  ответ.unknownKind = "принято";
} catch (err) {
  ответ.unknownKind = String(err && err.message);
}

process.stdout.write(JSON.stringify(ответ));

/**
 * Часы устройства переживают перезапуск: узел тот же, отметка растёт.
 *
 * Номер узла говорит, **кто именно** правил запись. Заведись он заново при
 * каждом запуске -- сервер обмена перестал бы узнавать своего, и changeset'ы
 * возвращались бы отправителю. Отметка, начавшая сначала, делает свежую правку
 * старее чужой давнишней: слияние по колонкам выберет не то значение, и никто
 * ничего не скажет.
 *
 * Правило было записано дважды и сторожилось только на питоновской базе.
 * Проверено мутацией 21.08.2026: снятое сохранение узла и снятое сохранение
 * часов -- по 698 зелёных проверок.
 */
import { readFileSync, writeFileSync } from "node:fs";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { Database } from "../../src/runtime/db.js";
import { makeModels } from "../../src/runtime/fields.js";

const ввод = JSON.parse(await new Promise((готово) => {
  let б = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", (к) => (б += к));
  process.stdin.on("end", () => готово(б || "{}"));
}));

const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const модели = makeModels(ввод.schema);
const модель = модели[ввод.model];

/** Открыть базу из файла, поработать и выгрузить обратно -- как перезапуск. */
function сеанс(файл, дело) {
  const h = new sqlite3.oo1.DB(":memory:");
  try {
    const байты = new Uint8Array(readFileSync(файл));
    if (байты.length) {
      const p = sqlite3.wasm.allocFromTypedArray(байты);
      sqlite3.capi.sqlite3_deserialize(
        h.pointer, "main", p, байты.length, байты.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE
          | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    }
  } catch { /* файла ещё нет -- первый сеанс */ }
  const db = new Database(h, { sqlite3 });
  db.ensureSchema([модель]);
  const итог = дело(db);
  db.commit();
  writeFileSync(файл, Buffer.from(sqlite3.capi.sqlite3_js_db_export(h.pointer)));
  return итог;
}

const первый = сеанс(ввод.file, (db) => {
  const id = db.create(модель, ввод.values);
  return { id, node: db.getMeta("hlc:node"), stamp: db.read(модель, id).hlc };
});

const второй = сеанс(ввод.file, (db) => {
  db.write(модель, первый.id, ввод.change);
  return { node: db.getMeta("hlc:node"), stamp: db.read(модель, первый.id).hlc };
});

process.stdout.write(JSON.stringify({ первый, второй }));

/**
 * Часы устройства переживают перезапуск: узел тот же, отметка растёт.
 *
 * Номер узла говорит, **кто именно** правил запись. Заведись он заново при
 * каждом запуске -- сервер обмена перестал бы узнавать своего, и changeset'ы
 * возвращались бы отправителю. Отметка, начавшая сначала, делает свежую правку
 * старее чужой давнишней: слияние по колонкам выберет не то значение, и никто
 * ничего не скажет.
 *
 * Правило было записано дважды -- у питоновской базы и у той, что на
 * устройстве, -- и сторожилось только на питоновской. Проверено мутацией
 * 21.08.2026: снятое сохранение узла и снятое сохранение часов оставляли по
 * 698 зелёных проверок.
 *
 * «Перезапуск» здесь настоящий: база выгружается байтами в файл и поднимается
 * из него заново, как это делает устройство между запусками приложения.
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "../../src/runtime/db.js";
import { makeModels } from "../../src/runtime/fields.js";
import { подопытноеTodo, sqlite } from "./помощь.mjs";

let сеансы = null;

before(async () => {
  const sqlite3 = await sqlite();
  const пакет = await подопытноеTodo();
  const модели = makeModels({ models: пакет.models, types: пакет.types });
  const модель = модели.TodoLine;
  const файл = path.join(mkdtempSync(path.join(tmpdir(), "часы-")), "device.db");

  /** Открыть базу из файла, поработать и выгрузить обратно -- как перезапуск. */
  const сеанс = (дело) => {
    const h = new sqlite3.oo1.DB(":memory:");
    if (existsSync(файл)) {
      const байты = new Uint8Array(readFileSync(файл));
      if (байты.length) {
        const p = sqlite3.wasm.allocFromTypedArray(байты);
        sqlite3.capi.sqlite3_deserialize(
          h.pointer, "main", p, байты.length, байты.length,
          sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE
            | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
      }
    }
    const db = new Database(h, { sqlite3 });
    db.ensureSchema([модель]);
    const итог = дело(db);
    db.commit();
    writeFileSync(файл, Buffer.from(sqlite3.capi.sqlite3_js_db_export(h.pointer)));
    return итог;
  };

  const первый = сеанс((db) => {
    const id = db.create(модель, { text: "До перезапуска" });
    return { id, node: db.getMeta("hlc:node"), stamp: db.read(модель, id).hlc };
  });
  const второй = сеанс((db) => {
    db.write(модель, первый.id, { text: "После" });
    return { node: db.getMeta("hlc:node"), stamp: db.read(модель, первый.id).hlc };
  });
  сеансы = { первый, второй };
});

test("устройство сохраняет свой узел через перезапуск", () => {
  // Два устройства с одним номером узла перестают видеть друг друга молча.
  const { первый, второй } = сеансы;
  assert.ok(первый.node, "узел не записан вовсе");
  assert.equal(второй.node, первый.node, "после перезапуска узел стал другим");
});

test("отметка растёт через перезапуск", () => {
  // Оговорка, без которой проверка кажется сильнее, чем есть: между сеансами
  // идут настоящие часы, поэтому вторая отметка больше первой и **без**
  // сохранённой `hlc:last`. Мутация «часы не сохраняются» её не роняет
  // (проверено). Питоновская проверка, стоявшая здесь до 21.08.2026, была
  // ровно такой же и тем же слабым местом обладала -- переезд ничего не
  // потерял.
  //
  // Настоящая работа `hlc:last` -- монотонность, когда настенные часы пошли
  // назад или две правки попали в одну миллисекунду. Проверить это можно
  // только управляя часами, и такой проверки у нас нет ни на одной стороне.
  // Долг записан здесь, чтобы его было видно.
  const { первый, второй } = сеансы;
  assert.ok(второй.stamp > первый.stamp, `${первый.stamp} -> ${второй.stamp}`);
});

test("отметка несёт узел", () => {
  // По нему разрешается ничья при равном времени.
  assert.ok(сеансы.первый.stamp.endsWith(сеансы.первый.node));
});

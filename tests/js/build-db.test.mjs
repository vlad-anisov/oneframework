/**
 * Базу приложения пишет тот же код, что стоит на устройстве.
 *
 * Писали двое: сборка на питоне (`model/storage.py`) и устройство на
 * JavaScript. Формат один, реализации две -- расхождение видно только на
 * обмене, у пользователя. Питоновский писатель удалён; правила остались, и
 * проверяются они на том, что вышло.
 *
 * Приложений три, и все объявлены привязкой на JavaScript. Раньше здесь брались
 * `todo`, `gtasks` и `kitchen` -- каждое отдельным процессом, потому что реестр
 * моделей в питоне глобален и ключуется именем класса: загрузи два примера в
 * один процесс, и посев запишет строки в классы соседа, причём молча. У
 * привязки на JavaScript такого реестра нет, и оговорка вместе с ним ушла.
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { собратьБазу, подопытноеTodo, sqlite } from "./помощь.mjs";

/** Что в базе: форма таблиц, определения, записи и мета. */
async function содержимое(файл) {
  const sqlite3 = await sqlite();
  const h = new sqlite3.oo1.DB(":memory:");
  const байты = new Uint8Array(readFileSync(файл));
  const p = sqlite3.wasm.allocFromTypedArray(байты);
  sqlite3.capi.sqlite3_deserialize(
    h.pointer, "main", p, байты.length, байты.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
  const выбрать = (sql) => h.selectObjects(sql);
  const таблицы = Object.fromEntries(
    выбрать("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
      .map((r) => [r.name, r.sql]));
  const определения = выбрать(
    'SELECT "kind","name","fingerprint","revision" FROM "_oneframework_def" ORDER BY "kind","name"');
  const мета = Object.fromEntries(
    выбрать('SELECT "key","value" FROM "_oneframework_meta"').map((r) => [r.key, r.value]));
  let записей = 0;
  for (const имя of Object.keys(таблицы)) {
    if (имя.startsWith("_oneframework") || имя.startsWith("sqlite")) continue;
    записей += выбрать(`SELECT COUNT(*) AS n FROM "${имя}"`)[0].n;
  }
  h.close();
  return { таблицы, определения, мета, записей };
}

const собрано = {};

before(async () => {
  const { declare } = await import("../../../oneframework-js/index.mjs");
  const { пакет } = await import("../fixtures/parity_app.mjs");
  const { application: todo } = await import("../../../oneframework-examples/todo-js/app.mjs");
  for (const [имя, п] of [["богатый", пакет()], ["todo", await подопытноеTodo()],
                          ["notes", declare((await import("../../examples/notes-js/app.mjs")).default)]]) {
    собрано[имя] = await содержимое(собратьБазу(п));
  }
  void todo;
});

for (const имя of ["богатый", "todo", "notes"]) {
  test(`у каждой модели своя таблица: ${имя}`, () => {
    // Таблица на модель -- то, из-за чего обмен ломается тише всего. Раньше
    // здесь сверялись две реализации DDL; теперь она одна, и проверяется её
    // результат.
    const { таблицы } = собрано[имя];
    const свои = Object.keys(таблицы)
      .filter((т) => !т.startsWith("_oneframework") && !т.startsWith("sqlite"));
    assert.ok(свои.length, "ни одной таблицы приложения");
    // Колонка версий -- у таблиц **записей**. У таблицы связи её нет и быть не
    // может: там нет записи, там две ссылки, и сливаются они наличием строки,
    // а не версией колонки. Различаются по ключу `id`.
    const записи = свои.filter((т) => таблицы[т].includes('"id"'));
    assert.ok(записи.length, `ни одной таблицы записей среди ${свои}`);
    for (const т of записи) {
      assert.ok(таблицы[т].includes('"_cv"'), `${т}: нет колонки версий`);
    }
  });

  test(`у каждого определения отпечаток и ревизия: ${имя}`, () => {
    // Отпечаток решает, поедет ли определение обменом; ревизия -- какое новее.
    // Пустой отпечаток означал бы, что не поедет ничего либо поедет всё, и оба
    // случая молчаливые.
    const { определения } = собрано[имя];
    assert.ok(определения.length, "определений нет вовсе");
    for (const о of определения) {
      assert.equal((о.fingerprint || "").length, 16, `${о.name} без отпечатка`);
      assert.ok(о.revision >= 1, `${о.name} без ревизии`);
    }
    const виды = new Set(определения.map((о) => о.kind));
    for (const в of ["types", "model", "view"]) assert.ok(виды.has(в), `не хватает ${в}`);
  });

  test(`база не несёт личности устройства: ${имя}`, () => {
    // `hlc:node` обязан быть разным у разных устройств. Оставь его в собранной
    // базе -- и все клиенты вышли бы в обмен под одним номером узла, то есть
    // перестали бы видеть друг друга, ничего не сказав.
    const { мета } = собрано[имя];
    assert.ok(!("hlc:node" in мета), "личность устройства уехала в сборку");
    assert.ok(!("hlc:last" in мета), "часы уехали в сборку");
  });
}

test("посеянные записи на месте", () => {
  // Пустая база выглядит как рабочая.
  assert.ok(собрано.todo.записей > 0, "посев не доехал");
});

test("посев оставляет отметку", () => {
  // Без неё вторая сборка посеяла бы всё заново.
  const отметки = Object.keys(собрано.todo.мета).filter((к) => к.startsWith("seeded:"));
  assert.ok(отметки.length, `посев не отмечен: ${Object.keys(собрано.todo.мета)}`);
});

test("привязка без демо-данных объявляет это пустым разделом", () => {
  // Пустой раздел -- законный ответ, отсутствие раздела -- потеря: «данных
  // нет» и «раздел потеряли» стали бы неразличимы.
  assert.equal(собрано.notes.записей, 0);
});

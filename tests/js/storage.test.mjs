/**
 * Схема и связи -- у той базы, что стоит на устройстве.
 *
 * Файл сверял две реализации доступа к SQLite: питоновскую (`model/storage.py`)
 * и ту, что на устройстве. Сверка была настоящей, пока писали обе. С 21.08.2026
 * пишет одна -- базу приложения собирает `src/build-db.mjs`, -- и
 * сверять стало не с чем.
 *
 * Правила остались, и они не про совпадение, а про поведение:
 *
 * * имена таблиц связей собираются **из схемы**, а не объявляются: там две
 *   реализации однажды и разошлись бы молча;
 * * удаление записи обнуляет входящие ссылки, а не оставляет висящие.
 *
 * Ожидания записаны числами, а не «как у соседа»: сосед мог бы ошибаться так же.
 *
 * Подопытное приложение объявлено здесь, а не взято у примера: спор идёт про
 * четыре рода связей, и приложение, где они все есть разом, короче любого
 * настоящего.
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";

import { Database } from "../../src/runtime/db.js";
import { makeModels } from "../../src/runtime/fields.js";
import { sqlite } from "./помощь.mjs";

let ку = null;   // кухня: база, модели и всё, что из неё вычитали

before(async () => {
  const { declare, app, Screen, Row, view, model, string, many2one, many2many, one2many } =
    await import("../../../oneframework-js/index.mjs");

  const Метка = model("Label", { fields: { name: string("Имя") } });
  const Фирма = model("Company", { fields: { name: string("Имя") } });
  const Паспорт = model("Passport", { fields: { number: string("Номер") } });
  const Задача = model("Task", {
    fields: { title: string("Заглавие"), labels: many2many(Метка, "Метки") },
  });
  const Контакт = model("Contact", {
    fields: {
      name: string("Имя"),
      company: many2one(Фирма, "Фирма"),
      // Один-к-одному -- та же колонка, которой нельзя повториться.
      passport: many2one(Паспорт, "Паспорт", { unique: true }),
      notes: one2many("Note", "contact", "Заметки"),
    },
  });
  const Заметка = model("Note", {
    fields: { text: string("Текст"), contact: many2one(Контакт, "Контакт") },
  });
  const Список = view("Список", { model: Задача, ui: (r) => Row(r.title()) });
  const пакет = declare(app({
    title: "Связи", models: [Метка, Фирма, Паспорт, Задача, Контакт, Заметка],
    views: [Список], screens: [Screen(Список)], root: Список,
  }));

  const sqlite3 = await sqlite();
  const модели = makeModels({ models: пакет.models, types: пакет.types });
  const db = new Database(new sqlite3.oo1.DB(":memory:"), { sqlite3 });
  db.ensureSchema(Object.values(модели));

  // Ключи заданы, а не выданы: свой ключ расходится всегда и ничего не говорит
  // о правильности.
  const строки = {
    Label: [{ id: "k-l1", name: "Срочно" }, { id: "k-l2", name: "Дом" }],
    Task: [{ id: "k-t1", title: "Первая" }, { id: "k-t2", title: "Вторая" }],
    // У первого контакта две заметки, у второго ни одной: без пустого случая
    // проверка прошла бы и на реализации, которая всегда возвращает всё подряд.
    Contact: [{ id: "k-c1", name: "Первый" }, { id: "k-c2", name: "Второй" }],
    Note: [{ id: "k-n1", text: "раз", contact: "k-c1" },
           { id: "k-n2", text: "два", contact: "k-c1" }],
  };
  for (const [имя, набор] of Object.entries(строки)) {
    for (const с of набор) db.create(модели[имя], с);
  }

  const схема = db.connect()
    .execute("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => [r.name, r.sql]);

  // Порядок важен: удаление идёт последним, и проверяется именно то, что оно
  // оставило после себя.
  db.setMany2many(модели.Task.field("labels"), "k-t1", ["k-l1", "k-l2"]);
  db.setMany2many(модели.Task.field("labels"), "k-t2", ["k-l2"]);
  db.unlink(модели.Label, "k-l1");

  const связи = {};
  for (const [м, поле, id] of [["Task", "labels", "k-t1"], ["Task", "labels", "k-t2"],
                               ["Contact", "notes", "k-c1"], ["Contact", "notes", "k-c2"]]) {
    const f = модели[м].field(поле);
    const строки_ = f.ftype === "many2many" ? db.readMany2many(f, id) : db.readOne2many(f, id);
    связи[`${поле}:${id}`] = строки_.map((r) => r.id);
  }

  const до = db.connect().one("PRAGMA schema_version").schema_version;
  db.ensureSchema(Object.values(модели));
  const после = db.connect().one("PRAGMA schema_version").schema_version;

  const фирма = db.create(модели.Company, { name: "Фирма" });
  const кто = db.create(модели.Contact, { name: "Сотрудник", company: фирма });
  db.unlink(модели.Company, фирма);
  const висячая = db.read(модели.Contact, кто).company;

  const индексы = db.connect()
    .execute(`PRAGMA index_list("${модели.Contact.table}")`).map((r) => [r.name, r.unique]);

  const паспорт = db.create(модели.Passport, { number: "AA-1" });
  db.create(модели.Contact, { name: "Владелец", passport: паспорт });
  let второй = null;
  const настоящий = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    db.create(модели.Contact, { name: "Второй", passport: паспорт });
    второй = "принято";
  } catch (беда) { второй = String(беда && беда.message); }
  finally { process.stderr.write = настоящий; }

  ку = { схема, связи, версия: { до, после }, висячая, индексы, второй };
});

test("имя таблицы связи выводится из схемы", () => {
  // Выводится, а не объявляется -- значит его надо видеть.
  const связи = ку.схема.filter(([имя]) => имя.endsWith("_rel")).map(([имя]) => имя);
  assert.ok(связи.length, `ни одной таблицы связи: ${ку.схема.map(([и]) => и)}`);
});

test("связи записаны так, как просили", () => {
  assert.deepEqual(ку.связи["labels:k-t2"], ["k-l2"]);
});

test("удаление записи чистит связи, которые на неё указывали", () => {
  // Вторая половина не менее важна: `k-l2` никто не удалял, и без неё проверка
  // проходила бы и на реализации, которая чистит вообще всё.
  const все = Object.entries(ку.связи).filter(([к]) => к.startsWith("labels:"));
  assert.ok(все.every(([, ids]) => !ids.includes("k-l1")), JSON.stringify(ку.связи));
  assert.deepEqual(ку.связи["labels:k-t1"], ["k-l2"],
                   "уцелевшая связь пропала вместе с удалённой");
});

test("один-ко-многим читается обратной колонкой потомка", () => {
  // Дорога своя, и сторожить её надо отдельно: сломанный `readOne2many` до
  // 21.08.2026 оставлял всю сюиту зелёной -- ни одна проверка не заметила бы,
  // что список потомков стал пустым.
  assert.deepEqual([...ку.связи["notes:k-c1"]].sort(), ["k-n1", "k-n2"]);
  assert.deepEqual(ку.связи["notes:k-c2"], [], "у второго контакта заметок нет");
});

test("один-к-одному -- колонка с уникальным индексом", () => {
  // Без индекса один паспорт достаётся двоим, и заметно это становится не
  // сразу. Именно **уникальный**: на той же колонке живёт обычный индекс
  // связи, и судить по одному имени нельзя -- первая редакция так и делала и
  // мутацию не поймала.
  assert.ok(ку.индексы.some(([имя, уник]) => имя.includes("passport_id") && уник),
            JSON.stringify(ку.индексы));
});

test("владелец у одного-к-одному ровно один", () => {
  // Схема схемой, а держит её база -- поэтому попыткой.
  assert.match(ку.второй ?? "", /UNIQUE/);
});

test("удаление записи обнуляет ссылки на неё", () => {
  // Висячая ссылка показывает связь с записью, которой нет: экран рисует
  // пустоту вместо имени, а причину видно только в базе. До 21.08.2026 правило
  // на устройстве не сторожил никто -- снятое обнуление оставляло 690 зелёных.
  assert.equal(ку.висячая, null);
});

test("второй заход ensureSchema не трогает схему", () => {
  // Дороже, чем «не упасть»: `ensureSchema` приводит таблицу к объявлению
  // пересозданием, а решает, надо ли, сверкой своего `CREATE TABLE` с тем, что
  // запомнила SQLite -- слово в слово. Разойдись эти строки хоть пробелом -- и
  // ошибки не будет: будет тихая переливка **всех** таблиц на каждом запуске,
  // на каждом устройстве. Считает сама SQLite: `schema_version` растёт на DDL.
  assert.equal(ку.версия.после, ку.версия.до, JSON.stringify(ку.версия));
});

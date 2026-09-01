/**
 * Хранилище и модели вместе, на настоящей SQLite.
 *
 * Проверяется не приведение значений по отдельности (это делает
 * test_js_fields_parity) и не SQL по отдельности (test_js_query_parity), а то,
 * что три слоя стыкуются: схема заводится, записи пишутся, домен доезжает до
 * базы и возвращает те же строки, что у питона.
 *
 * В node OPFS нет, поэтому база в памяти. Слою моделей это безразлично -- VFS
 * ниже него, -- а на устройстве та же самая база лежит в OPFS через
 * `opfs-sahpool`, и разница только в том, чем открыли.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { makeModels } from "../../src/runtime/fields.js";
import { Database } from "../../src/runtime/db.js";
import { QueryContext, buildSelect, compileDomain, compileOrder } from "../../src/runtime/query.js";

const input = JSON.parse(await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => resolve(buf));
}));

const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const handle = new sqlite3.oo1.DB(":memory:");

const models = makeModels(input.schema);
const db = new Database(handle);
const wanted = input.models.map((n) => models[n]);
db.ensureSchema(wanted);

// Записи создаются с заданными ключами и отметками, чтобы обе стороны получили
// побайтно одно и то же: свой id и своя отметка расходятся всегда и ничего не
// говорят о правильности.
for (const [model, rows] of Object.entries(input.rows)) {
  for (const row of rows) db.create(models[model], row);
}

const out = { schema: [], queries: [] };
for (const row of db.connect().execute(
  "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
)) {
  out.schema.push([row.name, row.sql]);
}

for (const q of input.queries) {
  const model = models[q.model];
  const ctx = new QueryContext(model, q.state || {});
  const [sql, params] = buildSelect(
    model, ctx, [compileDomain(q.domain ?? null, ctx)],
    compileOrder(q.order || [], ctx), q.limit ? { limit: q.limit } : {},
  );
  out.queries.push({
    sql,
    params,
    rows: db.query(model, sql, params).map((r) => ({ ...r })),
  });
}

// Связи: то, чего запрос по одной таблице не проверяет. Many2many живёт в
// отдельной таблице, One2many -- запросом по чужой колонке, а удаление обязано
// обнулить входящие ссылки. Всё это -- имена таблиц и колонок, собранные из
// схемы, и разойтись они могут молча.
for (const op of input.ops || []) {
  const model = models[op.model];
  if (op.op === "set_many2many") {
    db.setMany2many(model.field(op.field), op.id, op.ids);
  } else if (op.op === "unlink") {
    db.unlink(model, op.id);
  }
}
out.relations = [];
for (const probe of input.probes || []) {
  const model = models[probe.model];
  const field = model.field(probe.field);
  const rows =
    field.ftype === "many2many"
      ? db.readMany2many(field, probe.id)
      : db.readOne2many(field, probe.id);
  out.relations.push({
    model: probe.model,
    field: probe.field,
    id: probe.id,
    ids: rows.map((r) => r.id),
  });
}
out.after = [];
for (const q of input.after || []) {
  const model = models[q.model];
  out.after.push(db.all(model).map((r) => ({ ...r })));
}

const canonical = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
};
// Второй заход `ensureSchema` обязан не тронуть схему. Решает он это сверкой
// своего `CREATE TABLE` с тем, что запомнила SQLite -- слово в слово. Разойдись
// эти строки хоть пробелом, ошибки не будет: будет тихая переливка всех таблиц
// на каждом запуске, на каждом устройстве. Считает сама SQLite: `schema_version`
// растёт на любом DDL.
{
  const до = db.connect().one("PRAGMA schema_version").schema_version;
  db.ensureSchema(Object.values(models));
  const после = db.connect().one("PRAGMA schema_version").schema_version;
  out.schemaVersion = { before: до, after: после };
}

// Удаление обнуляет входящие ссылки, а не оставляет висящие. Без этого строка
// показывает связь с записью, которой нет: экран рисует пустоту вместо имени, а
// причину видно только в базе.
out.dangling = null;
if (models.Company && models.Contact) {
  const фирма = db.create(models.Company, { name: "Фирма" });
  const кто = db.create(models.Contact, { name: "Сотрудник", company: фирма });
  db.unlink(models.Company, фирма);
  out.dangling = { company: db.read(models.Contact, кто).company };
}

// Один-к-одному: колонка у владельца плюс **уникальный индекс**. Без индекса
// один паспорт достаётся двоим, и заметно это становится не сразу.
out.indexes = {};
for (const имя of Object.keys(models)) {
  const m = models[имя];
  // Имя и **признак уникальности**: по одному имени судить нельзя -- на той
  // же колонке живёт обычный индекс связи, и его имя тоже её содержит.
  out.indexes[имя] = db.connect()
    .execute(`PRAGMA index_list("${m.table}")`).map((r) => [r.name, r.unique]);
}

// И сама уникальность -- попыткой. Схема схемой, а держит её база.
out.secondOwner = null;
if (models.Contact && models.Passport) {
  const паспорт = db.create(models.Passport, { number: "AA-1" });
  db.create(models.Contact, { name: "Первый", passport: паспорт });
  // Отказ здесь ожидаемый, и сама SQLite печатает его в stderr мимо
  // `printErr`. Проверка сверяет stderr на пустоту -- она ловит настоящие
  // жалобы, -- поэтому на время ожидаемого отказа вывод глушится.
  const настоящий = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    db.create(models.Contact, { name: "Второй", passport: паспорт });
    out.secondOwner = "принято";
  } catch (err) {
    out.secondOwner = String(err && err.message);
  } finally {
    process.stderr.write = настоящий;
  }
}

process.stdout.write(canonical(out));

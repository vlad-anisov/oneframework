/**
 * Сборщик базы приложения: план от питона -> файл SQLite.
 *
 * Зачем это здесь, а не в питоне. Базу приложения писали двое -- сборка на
 * питоне и устройство на JavaScript, -- и писать они обязаны побайтно одно и
 * то же: отпечатки определений, отметки часов, ключи записей, форму таблиц.
 * Две реализации одного формата расходятся молча, и видно это становится на
 * первом же обмене, а не в прогоне.
 *
 * Теперь пишет один -- **тот же код, что стоит на устройстве**: `db.js`,
 * `defs.js`, `fields.js` из `web/src/runtime`. Питон говорит, что класть
 * (`oneframework/cli/plan.py`), и в этом остаётся языком объявления.
 *
 * База собирается в памяти и выгружается байтами: у сборки `sqlite-wasm` под
 * node файлового VFS нет. Для сборки это и не нужно -- файл пишется один раз,
 * целиком.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { Database } from "./core/runtime/db.js";
import { ensureTable, put } from "./core/runtime/defs.js";
import { makeModels } from "./core/runtime/fields.js";
import { LOGIC_TABLE, ensureTable as ensureLogicTable } from "./core/runtime/logic.js";
import { PUBLISHER_META } from "./core/runtime/keys.js";
import { buildPlan } from "./build/plan.mjs";

const вход = JSON.parse(await new Promise((готово) => {
  let буфер = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (к) => (буфер += к));
  process.stdin.on("end", () => готово(буфер || "{}"));
}));

/**
 * На входе -- пакет объявления либо готовый план.
 *
 * Пакет узнаётся по номеру договора. Так писателя зовёт всё, кому нужна база
 * из приложения.
 *
 * Готовый план принимается ради проверок: `tests/test_build_db.py` дописывает
 * в него рукописное объявление действия, а через пакет такого не выразить.
 */
const план = "oneframework" in вход
  ? { ...buildPlan(вход), file: вход.file }
  : вход;

const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const ответ = {};
try {
  // Файл может уже существовать: выкладка идёт поверх базы, которая у
  // пользователя уже есть, и определения в ней надо обновить, а не потерять
  // вместе с данными.
  const handle = new sqlite3.oo1.DB(":memory:");
  if (план.file && existsSync(план.file)) {
    const байты = new Uint8Array(readFileSync(план.file));
    if (байты.length > 19 && (байты[18] === 2 || байты[19] === 2)) {
      throw new Error(`База ${план.file} в режиме WAL -- в память такая не поднимается`);
    }
    if (байты.length) {
      const p = sqlite3.wasm.allocFromTypedArray(байты);
      sqlite3.capi.sqlite3_deserialize(
        handle.pointer, "main", p, байты.length, байты.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE
          | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    }
  }
  // Журнал DELETE, а не WAL: файл уезжает выгрузкой байтов, а базу с
  // WAL-заголовком обратно в память не поднять -- журнала рядом нет.
  const db = new Database(handle, { sqlite3, journal: "DELETE" });

  const модели = makeModels(план.schema);
  db.ensureSchema(Object.values(модели));
  ensureTable(db);

  // Порядок определений -- как прислал питон: по нему считается ревизия.
  // Таблица логики заводится только если логика есть -- ровно как делала
  // выкладка на питоне. Приложение без логики её не носит, и лишняя пустая
  // таблица разошлась бы с тем, что уже лежит у пользователей.
  if ((план.defs || []).some(([вид]) => вид === "action")) ensureLogicTable(db);

  const выложено = [];
  for (const [вид, имя, документ] of план.defs || []) {
    if (put(db, вид, имя, документ)) выложено.push(имя);
  }

  // Посев -- по отметке: она и решает, сеять ли. База может быть не пустой
  // (она у пользователя уже есть), и второй посев положил бы те же записи ещё
  // раз -- то есть упал бы на ключе.
  //
  // Ключи записей приходят готовыми, от привязки: посев пользуется ими на
  // месте (`tag = db.create(...)`), и они обязаны быть одинаковыми на всех
  // клиентах.
  let строк = 0;
  for (const посев of план.seeds || []) {
    // Отметка своя либо прежней схемы имени: приложение, посеянное старой
    // версией каркаса, не должно сеять заново из-за переименования отметки.
    const посеяно = [посев.mark, ...(посев.also || [])].some((к) => db.getMeta(к));
    if (посеяно) { db.setMeta(посев.mark, "1"); continue; }
    for (const [имяМодели, строки] of Object.entries(посев.rows || {})) {
      const m = модели[имяМодели];
      if (!m) throw new Error(`В схеме нет модели ${имяМодели}`);
      for (const строка of строки) { db.create(m, строка); строк += 1; }
    }
    // Связи -- после строк того же посева: обе стороны уже должны лежать.
    for (const св of посев.links || []) {
      const m = модели[св.model];
      if (!m) throw new Error(`В схеме нет модели ${св.model}`);
      const f = m.fields[св.field];
      if (!f) throw new Error(`У ${св.model} нет поля ${св.field}`);
      db.setMany2many(f, св.owner, св.ids);
    }
    db.setMeta(посев.mark, "1");
  }

  if (план.publisher) db.setMeta(PUBLISHER_META, план.publisher);

  // Личность устройства -- не сборки. Обе строки заводит база при первом
  // обращении к часам, а собирается она здесь один раз на всех: оставь их --
  // и все клиенты вышли бы в обмен под одним номером узла, то есть перестали
  // бы видеть друг друга, ничего об этом не сказав.
  //
  // Сначала коммит, потом очистка, потом ещё коммит -- и порядок этот не
  // формальность. `commit()` сам дописывает `hlc:last`, если часы за
  // транзакцию тикали, и очистка перед ним стиралась той же строкой обратно.
  // У приложения с посевом флаг успевал сброситься промежуточным коммитом, и
  // база выходила чистой; у приложения без посева -- нет, и часы сборочной
  // машины уезжали к пользователю. Замерено 02.09.2026 при переносе проверки
  // на JavaScript: питоновская брала три приложения, и все три были с посевом.
  //
  // Своего `deleteMeta` у базы нет и заводить его ради сборки не за чем:
  // устройству стирать свою личность незачем, а таблица здесь одна и та же.
  db.commit();
  db.connect().execute(
    'DELETE FROM "_oneframework_meta" WHERE "key" IN (?,?)', ["hlc:node", "hlc:last"]);

  db.commit();
  writeFileSync(план.file, Buffer.from(sqlite3.capi.sqlite3_js_db_export(handle.pointer)));
  ответ.ok = { defs: выложено.length, rows: строк, file: план.file };
} catch (err) {
  ответ.error = `${err && err.name}: ${err && err.message}`;
  ответ.stack = String((err && err.stack) || "").split("\n").slice(0, 5).join("\n");
}
process.stdout.write(JSON.stringify(ответ));

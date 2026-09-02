/**
 * Журнал базы на устройстве: он обязан быть на диске.
 *
 * Про `journal_mode = MEMORY` документация SQLite говорит без обиняков: если
 * приложение упало посреди транзакции, база «very likely go corrupt». На
 * устройстве в этой базе лежит единственная копия неотправленной работы --
 * цена падения несоизмерима с экономией на записи журнала.
 *
 * Режим выбран замером, а не по документации. Проба на настоящем
 * `opfs-sahpool` в Chrome (300 транзакций на режим):
 *
 *     delete    работает,  684 мс
 *     truncate  работает,  511 мс
 *     persist   работает,  525 мс
 *     memory    работает,  139 мс  -- журнала на диске нет
 *     wal       ОТКАЗ: PRAGMA возвращает `delete`, режим не меняется
 *     off       работает,  136 мс  -- журнала нет вовсе
 *
 * WAL на этом VFS невозможен: разделяемой памяти у него нет. Взят `delete` --
 * умолчание SQLite и то, к чему VFS откатывается сам.
 *
 * Проверяется не проба, а её вывод. База берётся файловая: у баз в памяти
 * журнал всегда `memory` и другим быть не может.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { Database } from "../../src/runtime/db.js";
import { sqlite } from "./помощь.mjs";

/** Режимы, которые переживают падение посреди транзакции. */
const НАДЁЖНЫЕ = new Set(["delete", "truncate", "persist", "wal"]);

describe("журнал базы устройства", () => {
  let db;
  let режим;
  let строк;

  before(async () => {
    const sqlite3 = await sqlite();
    db = new Database(new sqlite3.oo1.DB("/journal-probe.db"));
    const con = db.connect();
    режим = con.scalar("PRAGMA journal_mode");

    con.execute("DROP TABLE IF EXISTS t");
    con.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    db.transaction((c) => c.execute("INSERT INTO t(v) VALUES ('раз')"));
    try {
      db.transaction((c) => {
        c.execute("INSERT INTO t(v) VALUES ('два')");
        throw new Error("обрыв на середине");
      });
    } catch { /* ровно этого и ждём */ }
    строк = con.scalar("SELECT COUNT(*) FROM t");
  });

  it("журнал лежит на диске", () => {
    // Раньше здесь стоял `MEMORY`, и падение стоило бы всей базы целиком.
    assert.ok(НАДЁЖНЫЕ.has(режим), `журнал без диска: ${режим}`);
  });

  it("транзакция, оборвавшаяся на середине, не оставляет следа", () => {
    // То, ради чего журнал и заводят: половина пакета не значит ничего.
    assert.equal(строк, 1);
  });
});

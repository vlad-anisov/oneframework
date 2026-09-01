/**
 * Какой журнал ставит `Database` на устройстве.
 *
 * База не `:memory:`: у баз в памяти журнал всегда `memory` и другим быть не
 * может, поэтому проверять на них нечего. Файл в Emscripten-FS ведёт себя как
 * настоящий -- `PRAGMA journal_mode` на нём работает.
 *
 * Заодно проверяется то, ради чего журнал и нужен: откат отменённой
 * транзакции. Без журнала на диске откатывать нечем.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { Database } from "../../src/runtime/db.js";

const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const db = new Database(new sqlite3.oo1.DB("/journal-probe.db"));
const con = db.connect();

const out = { mode: con.scalar("PRAGMA journal_mode") };

con.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
db.transaction((c) => c.execute("INSERT INTO t(v) VALUES ('раз')"));
try {
  db.transaction((c) => {
    c.execute("INSERT INTO t(v) VALUES ('два')");
    throw new Error("обрыв на середине");
  });
} catch {
  /* ровно этого и ждём */
}
out.rows = con.scalar("SELECT COUNT(*) FROM t");

process.stdout.write(JSON.stringify(out));

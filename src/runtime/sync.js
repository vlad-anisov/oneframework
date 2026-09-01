/**
 * Обмен изменениями между устройствами и сервером. Было парой к `oneframework/model/sync.py` (удалён 21.08.2026).
 *
 * Слияние здесь почти не написано -- оно уже есть в самой SQLite. Расширение
 * *session* записывает всё, что изменилось, в **changeset** и накладывает его на
 * другую базу. Ключевое свойство: changeset для UPDATE несёт только те
 * неключевые колонки, которые действительно менялись.
 *
 * Из этого НЕ следует, что две правки в разные поля одной записи накладываются
 * молча: любая наша запись трогает минимум три колонки -- само поле, `hlc` и
 * `updated_at`, -- значит две правки одной записи пересекаются всегда, и
 * разрешение спора исполняется на каждой встречной правке.
 *
 * Что остаётся нашим -- три вещи, которых в changeset нет: **порядок** (его
 * задают гибридные логические часы), **разрешение настоящего спора** (разбирается
 * по колонкам, а не целиком, и по версии каждой колонки -- см. `VERSION_COLUMN`
 * в db.js) и **учёт наложенного** (по отпечатку).
 *
 * Перенесено как перевод, а не как переосмысление: сборка `sqlite-wasm` собрана
 * с `ENABLE_SESSION`, и её changeset побайтно совпадает с тем, что делает APSW.
 * Значит сервер на питоне и устройство на JS говорят одним форматом, и любая
 * вольность здесь была бы вольностью против него.
 *
 * Особое место -- `_resolve`: он написан вопреки готовому примеру APSW
 * намеренно. Тот возвращает решение на всю строку, и `OMIT` выбрасывает
 * колонки, которые ни с чем не спорили.
 */

import {
  allDefs, changedSince, ensureTable as ensureDefTable, fingerprint, put,
} from "./defs.js";
import { VERSION_COLUMN, dumpVersions, loadVersions } from "./db.js";
import { ClockError, check as checkStamp } from "./hlc.js";
import * as keys from "./keys.js";
import { ensureTable as ensureLogicTable } from "./logic.js";
import { sha256Hex } from "./sha256.js";

export class SyncError extends Error {}

//: Версия формата обмена. Едет в каждом конверте: первый же несовпавший формат
//: иначе выглядит пустым экраном без диагностики.
export const PROTOCOL = 1;

const OUT_TABLE = "_oneframework_sync_out";
const IN_TABLE = "_oneframework_sync_in";

//: Служебные таблицы обмена в changeset не попадают: очередь -- это разговор о
//: правках, а не правка.
const PRIVATE = ["_oneframework_sync_", "_oneframework_meta"];

const isPrivate = (table) => PRIVATE.some((p) => table.startsWith(p));

const digest = (blob) => sha256Hex(blob).slice(0, 32);

//: «Колонку UPDATE не трогал» -- не значение, а его отсутствие, и путать это с
//: SQL NULL нельзя: `null` в changeset -- полноправное новое значение колонки.
const NO_CHANGE = Symbol("no_change");

const b64encode = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const b64decode = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * Доступ к расширению session. Держится отдельно, потому что это единственное
 * место, где нужен низкоуровневый C-API sqlite-wasm: всё остальное обходится
 * объектным `oo1`.
 */
export class SessionApi {
  constructor(sqlite3) {
    this.capi = sqlite3.capi;
    this.wasm = sqlite3.wasm;
  }

  open(dbPointer) {
    const { capi, wasm } = this;
    const stack = wasm.pstack.pointer;
    try {
      const pp = wasm.pstack.allocPtr();
      const rc = capi.sqlite3session_create(dbPointer, "main", pp);
      if (rc) throw new SyncError(`sqlite3session_create rc=${rc}`);
      const session = wasm.peekPtr(pp);
      capi.sqlite3session_attach(session, null);
      capi.sqlite3session_table_filter(
        session, (_ctx, name) => (isPrivate(name) ? 0 : 1), 0);
      return session;
    } finally {
      wasm.pstack.restore(stack);
    }
  }

  close(session) {
    this.capi.sqlite3session_delete(session);
  }

  isEmpty(session) {
    return Boolean(this.capi.sqlite3session_isempty(session));
  }

  changeset(session) {
    const { capi, wasm } = this;
    const stack = wasm.pstack.pointer;
    try {
      const pn = wasm.pstack.alloc(4);
      const pp = wasm.pstack.allocPtr();
      const rc = capi.sqlite3session_changeset(session, pn, pp);
      if (rc) throw new SyncError(`sqlite3session_changeset rc=${rc}`);
      const n = wasm.peek32(pn);
      const ptr = wasm.peekPtr(pp);
      const blob = n ? wasm.heap8u().slice(ptr, ptr + n) : new Uint8Array(0);
      if (ptr) capi.sqlite3_free(ptr);
      return blob;
    } finally {
      wasm.pstack.restore(stack);
    }
  }

  /** Разница с другой базой -- ею снимается первый снимок. */
  diff(session, fromDb, table) {
    const { capi, wasm } = this;
    const stack = wasm.pstack.pointer;
    try {
      const pErr = wasm.pstack.allocPtr();
      return capi.sqlite3session_diff(session, fromDb, table, pErr);
    } finally {
      wasm.pstack.restore(stack);
    }
  }

  apply(dbPointer, blob, onConflict) {
    const { capi, wasm } = this;
    const ptr = wasm.allocFromTypedArray(blob);
    try {
      const rc = capi.sqlite3changeset_apply_v2(
        dbPointer, blob.byteLength, ptr, 0,
        (_ctx, reason, iter) => onConflict(reason, iter), 0, 0, 0, 0);
      if (rc) throw new SyncError(`sqlite3changeset_apply_v2 rc=${rc}`);
    } finally {
      wasm.dealloc(ptr);
    }
  }

  /**
   * Какие таблицы трогает changeset -- не накладывая его.
   *
   * Нужно серверу: определения и модули едут от издателя, а не с устройства, и
   * решать это надо **до** наложения. После наложения «как было» не
   * восстанавливается: changeset ложится вместе с разрешением споров.
   *
   * Было парой к `split_guarded` в `oneframework/server.py` (удалён). Второго
   * прохода -- пересборки очищенного блоба -- здесь нет, и это разница, а не
   * недоделка: см. `src/server.mjs`.
   */
  tablesOf(blob) {
    const { capi, wasm } = this;
    const ptr = wasm.allocFromTypedArray(blob);
    const stack = wasm.pstack.pointer;
    const итератор = wasm.pstack.allocPtr();
    const имя = wasm.pstack.allocPtr();
    const колонок = wasm.pstack.alloc(4);
    const операция = wasm.pstack.alloc(4);
    const косвенно = wasm.pstack.alloc(4);
    const имена = new Set();
    try {
      if (capi.sqlite3changeset_start(итератор, blob.byteLength, ptr)) return [];
      const it = wasm.peekPtr(итератор);
      try {
        while (capi.sqlite3changeset_next(it) === capi.SQLITE_ROW) {
          if (capi.sqlite3changeset_op(it, имя, колонок, операция, косвенно)) break;
          имена.add(wasm.cstrToJs(wasm.peekPtr(имя)));
        }
      } finally {
        capi.sqlite3changeset_finalize(it);
      }
    } finally {
      wasm.pstack.restore(stack);
      wasm.dealloc(ptr);
    }
    return [...имена].sort();
  }

  /** Копия спорного изменения: сам итератор живёт только внутри колбэка. */
  conflictOf(reason, iter) {
    const { capi, wasm } = this;
    const stack = wasm.pstack.pointer;
    let table, nCol, op, pk;
    try {
      const pzTab = wasm.pstack.allocPtr();
      const pnCol = wasm.pstack.alloc(4);
      const pOp = wasm.pstack.alloc(4);
      const pbInd = wasm.pstack.alloc(4);
      const rc = capi.sqlite3changeset_op(iter, pzTab, pnCol, pOp, pbInd);
      if (rc) throw new SyncError(`sqlite3changeset_op rc=${rc}`);
      table = wasm.cstrToJs(wasm.peekPtr(pzTab));
      nCol = wasm.peek32(pnCol);
      op = wasm.peek32(pOp);
      const ppk = wasm.pstack.allocPtr();
      const pnpk = wasm.pstack.alloc(4);
      capi.sqlite3changeset_pk(iter, ppk, pnpk);
      const pkPtr = wasm.peekPtr(ppk);
      pk = [];
      for (let i = 0; i < nCol; i++) if (wasm.peek8(pkPtr + i)) pk.push(i);
    } finally {
      wasm.pstack.restore(stack);
    }

    // Сторона изменения либо есть целиком, либо её нет вовсе: у INSERT нет
    // «до», у DELETE нет «после», и accessor отвечает на это SQLITE_MISUSE.
    // Тогда вся сторона -- null, как `None` у APSW. Массив из пустот вместо
    // null стоил бы дорого: ключ спора берётся из «до», и на вставке
    // `UPDATE ... WHERE "id" = ?` уходил бы с пустым ключом -- ноль строк, ноль
    // ошибок, разрешение спора не состоялось, а отчёт говорит, что состоялось.
    const side = (fn) => {
      const values = [];
      for (let i = 0; i < nCol; i++) {
        const st = wasm.pstack.pointer;
        try {
          const pp = wasm.pstack.allocPtr();
          if (fn(iter, i, pp)) return null;
          const v = wasm.peekPtr(pp);
          // Успех при нулевом указателе -- это `apsw.no_change`: колонка,
          // которой UPDATE не касался. SQL NULL так не выглядит, у него свой
          // sqlite3_value. Пусто бывает только у «после».
          values.push(v ? capi.sqlite3_value_to_js(v, true) : NO_CHANGE);
        } finally {
          wasm.pstack.restore(st);
        }
      }
      return values;
    };

    const old = side(capi.sqlite3changeset_old);
    const current = side(capi.sqlite3changeset_conflict);
    const after = side(capi.sqlite3changeset_new);
    return {
      reason, table, op, pk, old, current,
      new: after && after.map((v) => (v === NO_CHANGE ? null : v)),
      changed: after && after.map((v) => v !== NO_CHANGE),
    };
  }
}

/**
 * Сессия SQLite, которая пишет changeset за нас. Живёт на соединении и
 * снимается в исходящую очередь при каждом коммите -- *внутри той же
 * транзакции*, что и сами данные.
 */
export class Tracker {
  constructor(db, api) {
    this.db = db;
    this.api = api;
    this.session = null;
    //: Наложение чужого changeset не должно вернуться отправителю как наша
    //: собственная правка -- на это время учёт выключается.
    this.suspended = false;
    this._open();
  }

  _open() {
    this.session = this.api.open(this.db.connect().handle.pointer);
  }

  close() {
    if (this.session !== null) {
      this.api.close(this.session);
      this.session = null;
    }
  }

  beforeCommit(db) {
    if (this.suspended || this.session === null) return;
    if (this.api.isEmpty(this.session)) return;
    const blob = this.api.changeset(this.session);
    if (!blob.length) return;
    // Своя отметка у каждого changeset: по ней его будут упорядочивать там,
    // куда он приедет, а внутри changeset времени нет вовсе.
    db.connect().execute(
      `INSERT INTO "${OUT_TABLE}" ("id","stamp","blob") VALUES (?,?,?)`,
      [digest(blob), db.stamp(), blob],
    );
  }

  afterCommit() {
    this._restart();
  }

  rolledBack() {
    this._restart();
  }

  _restart() {
    if (this.session === null) return;
    this.api.close(this.session);
    this._open();
  }
}

export function ensureTables(db) {
  const con = db.connect();
  con.execute(
    `CREATE TABLE IF NOT EXISTS "${OUT_TABLE}" (` +
      '"seq" INTEGER PRIMARY KEY AUTOINCREMENT, "id" TEXT NOT NULL, ' +
      '"stamp" TEXT NOT NULL, "blob" BLOB NOT NULL)',
  );
  con.execute(
    `CREATE TABLE IF NOT EXISTS "${IN_TABLE}" (` +
      '"id" TEXT PRIMARY KEY, "stamp" TEXT, "at" TEXT)',
  );
  return con;
}

/**
 * Имена таблиц, которые едут changeset'ом. Один список на обе надобности: по
 * нему снимается снимок и по нему же считается отпечаток схемы. Пара к
 * `synced_tables` в `oneframework/model/sync.py` (удалён).
 */
export function syncedTables(con) {
  return con
    .execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((r) => r.name)
    .filter((name) => !isPrivate(name) && !name.startsWith("sqlite_"));
}

/**
 * Физическая раскладка синхронизируемых таблиц -- как её видит сама база: имя
 * таблицы и упорядоченный список `(колонка, тип SQL)`. Пара к `table_layout` в
 * oneframework/model/sync.py, удалён.
 *
 * Спрашивается `PRAGMA table_info`, а не объявление приложения. Объявление
 * говорит, какой таблица задумана, а changeset ложится в ту, какая есть;
 * разойтись им хватало одного `ALTER TABLE ADD COLUMN`.
 */
export function tableLayout(db) {
  const con = db.connect();
  return syncedTables(con)
    .sort()
    .map((name) => [
      name,
      con.execute(`PRAGMA table_info("${name}")`).map((c) => [c.name, c.type]),
    ]);
}

/**
 * Отпечаток схемы этой базы -- по раскладке таблиц, а не по документу модели.
 *
 * changeset адресует колонки **местом** в таблице, значит сторожить надо ровно
 * место, и ровно то, которое в базе. Документ модели сторожил не то: правка
 * подписи поля останавливала обмен всему парку, а перестановка колонок его не
 * трогала. Объявленная раскладка сторожила почти то: устройство, пережившее
 * `ALTER TABLE ADD COLUMN`, и поставленное заново давали один отпечаток при
 * разных физических раскладках -- тихая порча с отчётом `applied: true`.
 */
export function schemaVersion(db) {
  return fingerprint(tableLayout(db));
}

/**
 * Сверить отпечатки схем и отказать, если они не сошлись. Пара к
 * `check_schema` в `oneframework/model/sync.py` (удалён) -- и **та же** запись правила, а
 * не похожая на неё.
 *
 * Записей было две, и здешняя была слабее серверной: `mine && theirs && mine
 * !== theirs`. Ответ без поля `schema`, с `null` или с пустой строкой выключал
 * проверку целиком, а сервер такой конверт уже отвергал. Достаточно было
 * сверстника, который поля не шлёт: старой сборки, чужой реализации, кого
 * угодно -- аутентификации у обмена нет.
 *
 * Направление ничего не меняет: changeset ссылается на колонки по их **месту**
 * в таблице, и наложенный вслепую кладёт значения не в свои поля -- без спора,
 * без ошибки и без строки в отчёте. Замерено на двух версиях с переставленными
 * колонками: `title` уехал в `note`, `note` в `title`, ноль конфликтов.
 *
 * Отсутствие отпечатка -- это отказ, а не разрешение.
 */
export function checkSchema(mine, theirs) {
  if (!theirs) {
    throw new SyncError(
      "Конверт без отпечатка схемы. Он обязателен: changeset ссылается на "
      + "колонки по их месту в таблице, и наложить его вслепую значит молча "
      + "испортить данные.",
    );
  }
  if (mine !== theirs) {
    throw new SyncError(
      "Схемы разошлись: changeset ссылается на колонки по их месту в таблице, "
      + "и наложить его на другую схему нельзя. Нужна одинаковая версия "
      + "приложения на обеих сторонах.",
    );
  }
}

/**
 * Включить учёт изменений. `initial` решает судьбу того, что уже лежит: сессия
 * пишет с этой минуты, и задачи, заведённые раньше, без первого снимка не
 * уехали бы никогда.
 */
export function enable(db, api, initial = true) {
  ensureTables(db);
  // Как и в питоне: таблицы определений и логики обязаны быть на каждом
  // устройстве, участвующем в обмене. Изменение таблицы, которой у получателя
  // нет, changeset выбрасывает молча -- первый вид не доезжал вовсе. Заодно от
  // них зависит отпечаток схемы: он считается по тому, что в базе есть.
  ensureDefTable(db);
  ensureLogicTable(db);
  db.commit();
  db.tracker = new Tracker(db, api);
  if (initial && db.getMeta("sync:cursor") === null) {
    const blob = snapshot(db, api);
    if (blob.length) {
      db.transaction((con) => {
        con.execute(
          `INSERT INTO "${OUT_TABLE}" ("id","stamp","blob") VALUES (?,?,?)`,
          [digest(blob), db.clock().stamp(), blob],
        );
      });
    }
    db.setMeta("sync:cursor", 0);
    db.commit();
  }
  return db.tracker;
}

/**
 * Всё, что в базе уже есть, одним changeset-ом: сравнением с пустой базой того
 * же устройства. Пустая сторона превращает разницу в «вставить всё».
 */
export function snapshot(db, api) {
  const con = db.connect();
  const wanted = new Set(syncedTables(con));
  const tables = con
    .execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
    .filter((r) => wanted.has(r.name));
  if (!tables.length) return new Uint8Array(0);

  con.execute("ATTACH DATABASE ':memory:' AS oneframework_base");
  try {
    const session = api.open(con.handle.pointer);
    for (const { name, sql } of tables) {
      const cut = sql.indexOf("(");
      if (cut < 0) continue;
      const head = sql.slice(0, cut);
      const tail = sql.slice(cut);
      const quoted = `"${name}"`;
      if (!head.includes(quoted)) continue;   // не нашего изготовления
      con.execute(head.replace(quoted, `oneframework_base.${quoted}`) + tail);
      api.diff(session, "oneframework_base", name);
    }
    const blob = api.changeset(session);
    api.close(session);
    return blob;
  } finally {
    con.execute("DETACH DATABASE oneframework_base");
  }
}

// --------------------------------------------------------------------------
// исходящее
// --------------------------------------------------------------------------
export function outgoing(db) {
  db.commit();
  const con = ensureTables(db);
  return con
    .execute(`SELECT "id","stamp","blob" FROM "${OUT_TABLE}" ORDER BY "seq" ASC`)
    .map((r) => ({ id: r.id, stamp: r.stamp, blob: b64encode(r.blob) }));
}

/**
 * Сколько changeset'ов ждёт отправки. Спрашивается часто -- на каждый кадр
 * признака состояния, -- поэтому считается, а не выгружается.
 */
export function pendingCount(db) {
  const con = ensureTables(db);
  const row = con.one(`SELECT COUNT(*) AS n FROM "${OUT_TABLE}"`);
  return row ? Number(row.n) : 0;
}

export function forget(db, ids) {
  if (!ids || !ids.length) return;
  const con = ensureTables(db);
  const marks = ids.map(() => "?").join(", ");
  db.transaction(() => {
    con.execute(`DELETE FROM "${OUT_TABLE}" WHERE "id" IN (${marks})`, ids);
  });
}

/** Один запрос обмена: и отдать своё, и попросить чужое. */
export function envelope(db) {
  ensureTables(db);
  const defs = {};
  for (const row of allDefs(db)) defs[`${row.kind}/${row.name}`] = row.fingerprint;
  return {
    protocol: PROTOCOL,
    node: db.clock().node,
    // Отпечаток считается здесь и сейчас, а не берётся из меты: списанная
    // однажды копия расходится с базой ровно в тот раз, когда это важно --
    // после обновления, добавившего поле.
    schema: schemaVersion(db),
    cursor: Number(db.getMeta("sync:cursor") || 0),
    changes: outgoing(db),
    defs,
  };
}

/**
 * Проверить подпись конверта -- своим ключом, а не приехавшим.
 *
 * Ключ из конверта доказывает только то, что подписавший умеет подписывать.
 * Он сверяется со своим и служит диагностикой: «подписано не тем» понятнее, чем
 * «подпись не сходится». Пара к `verify_envelope` в `oneframework/model/sync.py, удалён`.
 *
 * Ключа у устройства нет -- проверять не с чем, и это состояние прежней сборки,
 * а не разрешение.
 */
export async function verifyEnvelope(db, payload) {
  const known = keys.publisherKey(db);
  if (known === null) return false;
  const sig = (payload || {}).sig;
  if (!sig) {
    throw new SyncError(
      "Конверт без подписи. Это устройство знает ключ издателя, а значит "
        + "собеседник обязан подписывать: неподписанное приехало не от него. "
        + "Если сервер ещё старый -- обновлять надо сервер, а не отключать "
        + "проверку.",
    );
  }
  if (sig.key && sig.key !== known) {
    throw new SyncError(
      `Конверт подписан ключом ${sig.key.slice(0, 16)}…, а этому устройству `
        + `известен ${known.slice(0, 16)}…. Подписать умеет кто угодно; значение `
        + "имеет только то, чьим ключом.",
    );
  }
  const body = { ...payload };
  delete body.sig;
  try {
    await keys.verify(known, keys.ENVELOPE, body, sig.sig);
  } catch (err) {
    throw new SyncError(`Конверт обмена не принят: ${err.message || err}`);
  }
  return true;
}

/**
 * Сверить отметки changeset'ов конверта. Пара к `check_stamps` в
 * `oneframework/model/sync.py, удалён`.
 *
 * `stamp` -- единственное поле конверта, которого не проверял никто, и
 * единственное, которым меряется «кто последний». Сервер кладёт его в журнал
 * как есть, журнал раздаётся всем, каждое устройство подтягивает по нему свои
 * часы и сравнивает с ним свои строки. Одно поле из провода правит порядок во
 * всём парке -- и правит необратимо: поднятое уходит в `hlc:last`.
 *
 * Само правило -- в `hlc.check`: годность отметки описана там, где описана
 * отметка. Здесь -- только место, где спрашивают, и спрашивают до наложения и
 * обо всём конверте разом.
 */
export function checkStamps(changes) {
  for (const change of changes || []) {
    try {
      checkStamp((change || {}).stamp);
    } catch (err) {
      if (!(err instanceof ClockError)) throw err;
      const key = (change || {}).id || "?";
      throw new SyncError(`changeset ${key} не принят. ${err.message}`);
    }
  }
}

// --------------------------------------------------------------------------
// наложение
// --------------------------------------------------------------------------
const columnsOf = (con, table) =>
  con.execute(`PRAGMA table_info("${table}")`).map((r) => r.name);

/**
 * Чем меряется «позже» в этой таблице. У записей приложения это `hlc`, у
 * определений -- номер ревизии. У таблицы связи мерять нечего, и не нужно:
 * одинаковая пара с двух сторон -- это одно и то же, а не спор.
 */
function orderColumn(columns) {
  for (const name of ["hlc", "revision"]) if (columns.includes(name)) return name;
  return null;
}

/** Наложить один чужой changeset. Возвращает отчёт. */
export function applyChangeset(db, api, blob, stamp, node = null) {
  const capi = api.capi;
  const con = ensureTables(db);
  const key = digest(blob);
  if (con.one(`SELECT 1 AS one FROM "${IN_TABLE}" WHERE "id" = ?`, [key])) {
    return { applied: false, reason: "already" };
  }

  const conflicts = [];
  const onConflict = (reason, iter) => {
    // Сюда попадает только то, что SQLite наложить не смогла. Ответ всегда
    // «пропусти»: решение принимается ниже, где видны и колонки, и отметки.
    if (reason === capi.SQLITE_CHANGESET_DATA || reason === capi.SQLITE_CHANGESET_CONFLICT) {
      conflicts.push(api.conflictOf(reason, iter));
    }
    return capi.SQLITE_CHANGESET_OMIT;
  };

  // Выключенные внешние ключи, снятый учёт и одна транзакция -- это
  // `db.applying`, и почему именно эти три, написано там.
  let resolved = [];
  db.applying(() => {
    api.apply(con.handle.pointer, blob, onConflict);
    resolved = conflicts.map((c) => resolveOne(con, capi, c));
    db.receiveStamp(stamp);
    con.execute(
      `INSERT OR IGNORE INTO "${IN_TABLE}" ("id","stamp","at") VALUES (?,?,?)`,
      [key, stamp, db.clock().stamp()],
    );
  });

  return {
    applied: true,
    conflicts: conflicts.length,
    fields: resolved.reduce((a, b) => a + b, 0),
    node,
  };
}

/** Разобрать один спор. Возвращает, сколько колонок принято у чужой стороны. */
function resolveOne(con, capi, conflict) {
  const columns = columnsOf(con, conflict.table);
  if (!columns.length) return 0;
  const pk = conflict.pk.map((i) => columns[i]);
  // Ключ берётся из «до», а не из «после»: в UPDATE изменившиеся колонки
  // перечислены, а неизменившиеся -- нет, и ключ как раз не меняется никогда.
  const source = conflict.old !== null ? conflict.old : conflict.new;
  const where = pk.map((c) => `"${c}" = ?`).join(" AND ");
  const keys = pk.map((c) => source[columns.indexOf(c)]);

  if (conflict.op === capi.SQLITE_DELETE) {
    // Удаление побеждает: восстановить запись из чужого UPDATE нечем, а правило
    // обязано быть одинаковым на всех узлах.
    con.execute(`DELETE FROM "${conflict.table}" WHERE ${where}`, keys);
    return 1;
  }
  if (conflict.new === null) return 0;

  const order = orderColumn(columns);
  let mine = null;
  let theirs = null;
  if (order !== null) {
    const index = columns.indexOf(order);
    if (conflict.current !== null) mine = conflict.current[index];
    theirs = conflict.changed[index]
      ? conflict.new[index]
      : (conflict.old !== null ? conflict.old[index] : null);
  }
  const newer = order !== null && mine !== null && theirs !== null && theirs > mine;

  const [mineCv, theirsCv] = columnVersions(columns, conflict);

  const taken = {};
  columns.forEach((column, index) => {
    if (pk.includes(column) || !conflict.changed[index]) return;
    if (column === VERSION_COLUMN) return;   // не выбирается, а сливается -- ниже
    const mineAt = mineCv[column];
    const theirsAt = theirsCv[column];
    let take;
    if (mineAt !== undefined && theirsAt !== undefined) {
      // Обе стороны помнят, когда писали **в эту колонку**, -- спор решается
      // прямо здесь и правильно даже тогда, когда значения совпали.
      take = theirsAt > mineAt;
    } else {
      // Версии нет хотя бы у одной стороны: запись заведена до появления
      // колонки версий, либо это колонка, которую никто не помечает поимённо
      // (`hlc`, `updated_at`). Тогда -- прежнее правило.
      const ancestor = conflict.old !== null ? conflict.old[index] : null;
      const current = conflict.current !== null ? conflict.current[index] : null;
      const untouched = conflict.old !== null && current === ancestor;
      take = untouched || newer;
    }
    if (take) taken[column] = conflict.new[index];
  });

  // Версии сливаются поэлементным максимумом, а не достаются победителю
  // целиком: у каждой стороны в карте есть колонки, о которых вторая не знает,
  // и выбор одной карты стёр бы их.
  const merged = { ...mineCv };
  let moved = false;
  for (const [column, at] of Object.entries(theirsCv)) {
    if (merged[column] === undefined || at > merged[column]) {
      merged[column] = at;
      moved = true;
    }
  }
  if (columns.includes(VERSION_COLUMN) && moved) {
    taken[VERSION_COLUMN] = dumpVersions(merged);
  }

  const names = Object.keys(taken);
  if (!names.length) return 0;
  con.execute(
    `UPDATE "${conflict.table}" SET ${names.map((c) => `"${c}" = ?`).join(", ")} ` +
      `WHERE ${where}`,
    [...names.map((c) => taken[c]), ...keys],
  );
  // Карта версий -- учёт, а не поле: в счёт принятых колонок она не идёт.
  return names.length - (VERSION_COLUMN in taken ? 1 : 0);
}

/**
 * Карты версий обеих сторон: наша и та, что приехала. Наша -- текущее значение
 * колонки версий, чужая -- то, каким её видит changeset: новым, если сторона
 * его меняла, иначе тем, что было у неё до правки. Так же берётся и отметка
 * строки.
 */
function columnVersions(columns, conflict) {
  const index = columns.indexOf(VERSION_COLUMN);
  if (index < 0) return [{}, {}];     // таблица без версий -- например `_oneframework_def`
  const mine = conflict.current !== null ? loadVersions(conflict.current[index]) : {};
  const raw = conflict.changed[index]
    ? conflict.new[index]
    : (conflict.old !== null ? conflict.old[index] : null);
  return [mine, loadVersions(raw)];
}

// --------------------------------------------------------------------------
// приём ответа
// --------------------------------------------------------------------------
export async function receive(db, api, response) {
  if (response.error) throw new SyncError(String(response.error));
  // Подпись проверяется до всего остального: ответ несёт и определения, и
  // строки таблицы модулей, то есть исполняемый код. Асинхронность приходит
  // отсюда -- `crypto.subtle` синхронного пути не имеет, -- и это цена, которую
  // платит только приём обмена: он и так живёт за сетью.
  await verifyEnvelope(db, response);
  if (response.protocol !== PROTOCOL) {
    throw new SyncError(`Формат обмена ${response.protocol} против нашего ${PROTOCOL}.`);
  }
  checkSchema(schemaVersion(db), response.schema);
  checkStamps(response.changes);

  const node = db.clock().node;
  const report = { applied: 0, skipped: 0, conflicts: 0 };
  for (const change of response.changes || []) {
    if (change.node === node) {
      report.skipped += 1;          // наше же, вернувшееся кругом
      continue;
    }
    const outcome = applyChangeset(db, api, b64decode(change.blob), change.stamp,
                                   change.node ?? null);
    if (outcome.applied) {
      report.applied += 1;
      report.conflicts += outcome.conflicts;
    } else {
      report.skipped += 1;
    }
  }
  // Счётчик не для отчёта: по нему воркер решает, пересобирать ли рантайм.
  // Без него приехавший вид ложился в базу и ждал перезапуска.
  report.defs = 0;
  for (const entry of response.defs || []) {
    put(db, entry.kind, entry.name, entry.doc);
    report.defs += 1;
  }
  // Сервер не принимает от клиента виды, модели и модули -- он их публикует, а
  // не получает. Отвергнутое доходит до отчёта и дальше до человека: отказ, о
  // котором знает только сервер, для устройства неотличим от успеха.
  if (response.refused) report.refused = response.refused;
  forget(db, response.accepted || []);
  if (response.cursor !== null && response.cursor !== undefined) {
    db.setMeta("sync:cursor", Number(response.cursor));
  }
  db.commit();
  return report;
}

/** Определения, которых у собеседника нет или которые у него разошлись. */
export function defsFor(db, known) {
  return changedSince(db, known || {});
}

//: `exchange` -- круг обмена одним вызовом -- удалён 21.08.2026: его не звал
//: никто. Круг делает воркер (`worker.js`), и делает его в два шага нарочно:
//: между «отдать» и «наложить» стоит настоящая сеть, а её ответ надо
//: проверить, прежде чем накладывать.

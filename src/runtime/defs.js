/**
 * Определения приложения как записи в базе. Пара к oneframework/model/defs.py.
 *
 * Здесь рантайм их в основном **читает**: модели и документы видов кладёт в базу
 * питон при сборке, а устройство берёт их оттуда и по ним работает. Запись
 * нужна ровно для одного случая -- определения, приехавшие обменом: они лежат в
 * обычной таблице и едут тем же changeset-ом, что задачи, без отдельного канала.
 */

// Каноническая запись и отпечаток считаются здесь же, без WASM: правило
// вернулось в оба языка, а сторожит его RFC 8785 и сверка с питоном.
import { canonical, canonicalMany, fingerprint } from "./canon.js";
/** Прогрев, потерявший смысл вместе с переходом границы. См. `canon.js`. */
const prime = () => null;

// Каноническая запись и отпечаток -- одно правило на обе стороны, и живёт оно
// в WASM (`core/`, хост -- `core.js`). Здесь они только пересылаются наружу:
// код, который их звал, звать не перестал, а второй реализации больше нет.
export { canonical, canonicalMany, fingerprint, prime };

export const DEF_TABLE = "_oneframework_def";

/**
 * Раскладка таблицы определений: имя колонки, тип, остальное объявление. Одно
 * объявление и на DDL, и на отпечаток схемы -- разойдись они, страж перестал бы
 * замечать перестановку колонок ровно в той таблице, ради которой он и
 * сторожит. Пара к `DEF_COLUMNS` в oneframework/model/defs.py, и совпадать обязана
 * до порядка: changeset ложится по НОМЕРУ колонки, а не по имени.
 */
export const DEF_COLUMNS = [
  ["kind", "TEXT", "NOT NULL"],
  ["name", "TEXT", "NOT NULL"],
  ["fingerprint", "TEXT", "NOT NULL"],
  ["doc", "TEXT", "NOT NULL"],
  ["revision", "INTEGER", "NOT NULL DEFAULT 1"],
  ["hlc", "TEXT", "NOT NULL DEFAULT ''"],
];

const KINDS = new Set(["types", "model", "view", "action"]);

export function ensureTable(db) {
  const con = db.connect();
  const columns = DEF_COLUMNS.map(([n, t, rest]) => `"${n}" ${t} ${rest}`).join(", ");
  con.execute(
    `CREATE TABLE IF NOT EXISTS "${DEF_TABLE}" ` +
      `(${columns}, PRIMARY KEY ("kind", "name"))`,
  );
  // База, созданная до появления колонки. Порядок колонок обязан совпасть с
  // питоновским: changeset ложится по номеру колонки, а не по имени, и при
  // разошедшемся порядке значения молча попадают не в свои колонки.
  const names = con.execute(`PRAGMA table_info("${DEF_TABLE}")`).map((r) => r.name);
  if (!names.includes("hlc")) {
    con.execute(`ALTER TABLE "${DEF_TABLE}" ADD COLUMN "hlc" TEXT NOT NULL DEFAULT ''`);
  }
  return con;
}

/**
 * Записать определение. Возвращает true, если оно изменилось: ревизия растёт
 * только на настоящем изменении, иначе пересборка того же приложения выглядела
 * бы для обмена правкой.
 */
export function put(db, kind, name, doc) {
  if (!KINDS.has(kind)) throw new Error(`Неизвестный вид определения: ${kind}`);
  const con = ensureTable(db);
  // Один переход границы на оба ответа: канонический текст ложится в базу, а
  // отпечаток решает, ложиться ли ему вообще. Спросить их порознь значило бы
  // заплатить за переход дважды за то же самое.
  const [text, fp] = canonicalMany([doc])[0];
  const row = con.one(
    `SELECT "fingerprint", "revision" FROM "${DEF_TABLE}" WHERE "kind" = ? AND "name" = ?`,
    [kind, name],
  );
  if (row && row.fingerprint === fp) return false;
  const revision = row ? row.revision + 1 : 1;
  con.execute(
    `INSERT INTO "${DEF_TABLE}" ("kind","name","fingerprint","doc","revision","hlc") ` +
      'VALUES (?,?,?,?,?,?) ON CONFLICT("kind","name") DO UPDATE SET ' +
      '"fingerprint" = excluded."fingerprint", "doc" = excluded."doc", ' +
      '"revision" = excluded."revision", "hlc" = excluded."hlc"',
    [kind, name, fp, text, revision, db.stamp()],
  );
  return true;
}

export function get(db, kind, name) {
  const row = ensureTable(db).one(
    `SELECT "doc" FROM "${DEF_TABLE}" WHERE "kind" = ? AND "name" = ?`, [kind, name],
  );
  return row ? JSON.parse(row.doc) : null;
}

/** Все определения без тела: список нужен для сверки, а не для чтения. */
export function allDefs(db, kind = null) {
  const con = ensureTable(db);
  let sql = `SELECT "kind","name","fingerprint","revision" FROM "${DEF_TABLE}"`;
  const args = [];
  if (kind !== null) {
    sql += ' WHERE "kind" = ?';
    args.push(kind);
  }
  return con.execute(`${sql} ORDER BY "kind", "name"`, args);
}

/**
 * Что у нас новее, чем у собеседника: сравнение отпечатков, без разбора тела.
 *
 * Убиралась 20.08.2026 как мёртвая -- и была мертва честно: единственным её
 * читателем был сервер, а сервер написан на питоне. Вернулась вместе с
 * сервером на JS. Мораль в обход не заворачивается: «никто не зовёт» и «никому
 * не нужно» -- разные вещи, и различает их не обход, а знание, чего в дереве
 * ещё нет.
 */
export function changedSince(db, known) {
  const out = [];
  for (const row of allDefs(db)) {
    if ((known || {})[`${row.kind}/${row.name}`] !== row.fingerprint) {
      out.push({ ...row, doc: get(db, row.kind, row.name) });
    }
  }
  return out;
}

/** Документы видов из базы -- то, по чему рантайм рисует. */
export function loadDocuments(db) {
  const out = Object.create(null);
  for (const row of allDefs(db, "view")) out[row.name] = get(db, "view", row.name);
  return out;
}

/** Схема приложения из базы: типы плюс модели, в форме `app_schema`. */
export function loadSchema(db) {
  const types = get(db, "types", "_") || {};
  const models = allDefs(db, "model").map((r) => get(db, "model", r.name));
  return { version: 1, types, models };
}

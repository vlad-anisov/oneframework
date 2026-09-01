/**
 * Доступ к SQLite -- пара к oneframework/model/storage.py, удалён.
 *
 * Здесь база уже не внутри интерпретатора, а своя: `@sqlite.org/sqlite-wasm`
 * поверх OPFS. Из этого следует единственное ограничение, которое видно
 * снаружи: **всё это живёт в воркере**. Синхронный доступ к OPFS
 * (`createSyncAccessHandle`) на главном потоке не существует, а в воркере он
 * есть -- поэтому вызовы ниже остались синхронными, ровно как в питоне, и
 * выворачивать модели в промисы не пришлось.
 *
 * Заголовков COOP/COEP при этом не нужно: VFS `opfs-sahpool` обходится без
 * SharedArrayBuffer, что для Capacitor-вебвью и решает дело.
 */

import { Clock, nodeId } from "./hlc.js";
import { newId } from "./ids.js";

/** Ключ записи на проводе и в SQL -- строка. */
function key(value) {
  return typeof value === "string" ? value : String(value);
}

/**
 * Версии колонок: карта «имя колонки -> отметка часов последней **местной**
 * записи в неё». Колонка каркаса, а не поле приложения: в документ модели она
 * не входит, при чтении записи не отдаётся и в интерфейсе не существует.
 *
 * Нужна затем, что иначе «местная сторона эту колонку не трогала» приходится
 * выводить сравнением значения с предком, а такое сравнение не отличает «не
 * трогала» от «трогала дважды и вернула как было». Разбор спора -- в
 * `sync.js`, пара к `VERSION_COLUMN` в oneframework/model/storage.py, удалён.
 */
export const VERSION_COLUMN = "_cv";

/** Карта версий из колонки. Пусто -- это «версий нет», а не поломка. */
export function loadVersions(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};                        // не наша запись -- значит версий нет
  }
}

/**
 * Карта версий в колонку. Запись каноническая -- ключи по порядку, разделители
 * без пробелов, ровно как `json.dumps(..., sort_keys=True, separators=(",",":"))`.
 * Карта едет в changeset обычной строкой, и разойдись две реализации хоть
 * пробелом, changeset питона и JS перестали бы совпадать побайтно.
 */
export function dumpVersions(versions) {
  const names = Object.keys(versions).sort();
  return `{${names.map((n) => `${JSON.stringify(n)}:${JSON.stringify(versions[n])}`).join(",")}}`;
}

/**
 * Соединение с тем же лицом, что у питоновского: `execute` отдаёт строки
 * словарями. Весь остальной код написан на `row.title`, и подстраивать его под
 * форму драйвера было бы ровно тем, чего этот слой не допускает.
 */
/**
 * Набор не прошёл проверку бизнес-логики. Пара к `oneframework.errors.ValidationError`.
 *
 * Ошибок держится **список**, а не первая: набор -- это и одна карточка, и
 * импорт тысячи строк, и человеку, поправившему одну строку из тысячи, не место
 * в очереди из тысячи заходов.
 */
export class ValidationError extends Error {
  constructor(errors) {
    super(errors.map((e) => String(e.message ?? e)).join("; "));
    this.name = "ValidationError";
    this.errors = errors.map((e) => ({ ...e }));
  }
}

export class Connection {
  constructor(handle) {
    this.handle = handle;
    //: Открыта ли наша транзакция. Своим флагом, а не вопросом к SQLite:
    //: границу задаём мы, и она обязана совпадать с тем, что считает Database.
    this._open = false;
  }

  /**
   * Параметры бывают **позиционными** (массив, `?`) и **именованными**
   * (объект, `:имя`). Второе нужно объявленным действиям: правило и правка
   * склеиваются в один оператор, и позиция параметра в нём заранее неизвестна.
   * Питон обе формы принимает давно; здесь объект молча пропускался -- у него
   * нет `length`, -- и запрос уходил в базу с непривязанными параметрами.
   */
  execute(sql, params = []) {
    const stmt = this.handle.prepare(sql);
    try {
      if (params && !Array.isArray(params) && typeof params === "object") {
        stmt.bind(namedParams(params));
      } else if (params && params.length) stmt.bind(normalizeParams(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.get({}));
      return rows;
    } finally {
      stmt.finalize();
    }
  }

  /** Строки массивами значений -- пара к `[tuple(r) for r in ...]`. */
  rows(sql, params = []) {
    const stmt = this.handle.prepare(sql);
    try {
      if (params && params.length) stmt.bind(normalizeParams(params));
      const out = [];
      while (stmt.step()) out.push(stmt.get([]));
      return out;
    } finally {
      stmt.finalize();
    }
  }

  /** Первая строка или null -- пара к `cur.fetchone()`. */
  one(sql, params = []) {
    const rows = this.execute(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** Единственное значение первой строки. */
  scalar(sql, params = []) {
    const row = this.one(sql, params);
    if (row === null) return null;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : null;
  }

  executeMany(sql, rows) {
    const stmt = this.handle.prepare(sql);
    try {
      for (const params of rows) {
        stmt.reset();
        stmt.bind(normalizeParams(params));
        stmt.step();
      }
    } finally {
      stmt.finalize();
    }
  }

  totalChanges() {
    return this.handle.changes(true, false);
  }

  begin() {
    this.handle.exec("BEGIN");
    this._open = true;
  }

  /**
   * Закрыть транзакцию, если она была. Питоновский `con.commit()` вне
   * транзакции -- пустая операция, и здесь должно быть так же: `COMMIT` без
   * `BEGIN` не просто отказывает, он ещё и печатает отказ в stderr, а вызывают
   * его на каждом сохранении.
   */
  commit() {
    if (!this._open) return;
    this._open = false;
    this.handle.exec("COMMIT");
  }

  rollback() {
    if (!this._open) return;
    this._open = false;
    try {
      this.handle.exec("ROLLBACK");
    } catch {
      /* SQLite уже откатила сама -- например, на отказе уникальности */
    }
  }

  close() {
    this.handle.close();
  }
}

/** Именованные параметры так, как их ждёт sqlite-wasm: с двоеточием в ключе. */
function namedParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    const name = key.startsWith(":") ? key : `:${key}`;
    out[name] = value === undefined ? null : (typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  return out;
}

/**
 * `bind` в sqlite-wasm не принимает `undefined` и булево, а питон приводит их
 * молча. Расхождение здесь дало бы не ошибку, а строку, записанную не тем
 * значением.
 */
function normalizeParams(params) {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  });
}

/**
 * Две функции, которыми база начинает вести себя как питон -- он здесь язык
 * объявления формул, и его правила первичны.
 *
 * `oneframework_round` -- округление к чётному на половинах, как `round()` в питоне;
 * встроенный `round` в SQLite округляет от нуля. `oneframework_zero_division` --
 * отказ на делении на ноль: в питоне это ошибка, а SQLite молча отдаёт
 * пустоту, и пустая клетка на экране выглядит как ответ.
 */
function installPyRules(handle) {
  handle.createFunction("oneframework_round", (_ctx, x) => {
    if (x === null || x === undefined) return null;
    const floor = Math.floor(x);
    if (x - floor !== 0.5) return Math.round(Math.abs(x)) * Math.sign(x) || Math.round(x);
    return floor % 2 === 0 ? floor : floor + 1;
  }, { arity: 1, deterministic: true });
  handle.createFunction("oneframework_zero_division", () => {
    throw new Error("division by zero");
  }, { arity: 0, deterministic: true });
}

//: Через сколько шагов вычислителя звать сторожа. Пара к `step_tick` в
//: `oneframework/model/storage.py, удалён`.
export const STEP_TICK = 1000;

//: Сколько шагов вычислителя SQLite позволено одному запросу. Формулу пишет
//: автор приложения, а считает её база **на устройстве пользователя**: без
//: предела неудачное условие по связи вешает вкладку наглухо, и снаружи это
//: выглядит не ошибкой, а «зависло». Величина та же, что у сервера, -- иначе
//: одна и та же формула проходила бы на одной стороне и падала на другой.
//:
//: Выбрана замером 20.08.2026. Здесь стояло 20 000 000, и счётчик уменьшался
//: **на вызов сторожа**, а не на шаг: настоящий предел был в тысячу раз выше
//: названного, и убегающий запрос резался через 177 секунд. На миллионе строк
//: самый тяжёлый законный запрос -- группировка, 12 миллионов шагов; взято
//: двести, то есть шестнадцатикратный запас, и рез меньше чем за две секунды.
export const STEP_LIMIT = 200_000_000;

/**
 * Сколько раз позвать сторожа, чтобы получился названный предел **шагов**.
 *
 * Вынесено отдельной работой ради проверки: до 20.08.2026 счётчик уменьшался на
 * вызов, и предел был в тысячу раз выше названного -- убегающий запрос резался
 * через 177 секунд вместо мгновения. Арифметику можно спросить прямо, не
 * дожидаясь этих секунд.
 */
export function stepBudget(limit = STEP_LIMIT, tick = STEP_TICK) {
  return Math.max(1, Math.floor(limit / tick));
}

/**
 * Привести таблицу к объявленной раскладке -- пересозданием, а не ALTER.
 *
 * Пара к `reshape_table` в oneframework/model/storage.py, удалён. Правило целиком
 * записано там: почему пересоздание, почему сверяется весь `CREATE TABLE`, а
 * не список имён, и какой ценой это куплено. Здесь -- тот же порядок теми же
 * словами SQLite; разойдись языки в нём, устройство и сервер разошлись бы
 * отпечатком схемы, то есть обмен встал бы на ровном месте.
 */
export function reshapeTable(db, table, columns) {
  const con = db.connect();
  const ddl = `CREATE TABLE "${table}" (${columns.join(", ")})`;
  const known = con.scalar(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table],
  );
  if (known === null) {
    con.execute(ddl);
    return;
  }
  if (known === ddl) return;

  const tmp = `${table}__reshape`;
  // `legacy_alter_table` здесь своя: без неё переименование переписало бы
  // ссылки на эту таблицу в чужих объявлениях. Остальное -- выключенные
  // внешние ключи, снятый на время учёт обмена и одна транзакция -- это
  // `db.applying`, и второй записи тому правилу здесь не нужно.
  con.execute("PRAGMA legacy_alter_table = ON");
  try {
    db.applying(() => {
      con.execute(`DROP TABLE IF EXISTS "${tmp}"`);
      con.execute(`CREATE TABLE "${tmp}" (${columns.join(", ")})`);
      const present = new Set(
        con.execute(`PRAGMA table_info("${table}")`).map((r) => r.name),
      );
      const keep = con.execute(`PRAGMA table_info("${tmp}")`)
        .map((r) => r.name).filter((c) => present.has(c));
      if (keep.length) {
        const common = keep.map((c) => `"${c}"`).join(", ");
        con.execute(`INSERT INTO "${tmp}" (${common}) SELECT ${common} FROM "${table}"`);
      }
      con.execute(`DROP TABLE "${table}"`);
      con.execute(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
    });
  } finally {
    con.execute("PRAGMA legacy_alter_table = OFF");
  }
}

export class Database {
  constructor(handle, { requestFlush = null, flushNow = null, sqlite3 = null,
                        journal = "DELETE", stepLimit = STEP_LIMIT } = {}) {
    //: Модуль SQLite целиком -- он нужен для предела работы запроса, который
    //: живёт в C-API, а не в объектной обёртке.
    this._sqlite3 = sqlite3;
    //: Предел шагов -- настройкой, как у питоновской базы. Проверке нужен
    //: маленький: убегающий запрос при боевом пределе резался бы секундами, а
    //: правило от величины не зависит.
    this.stepLimit = stepLimit;
    installPyRules(handle);
    this.con = new Connection(handle);
    this.models = [];
    //: Кто снимает изменения для обмена; ставится sync.js. Без него база
    //: работает как раньше и про обмен ничего не знает.
    this.tracker = null;
    //: Кто проверяет набор перед записью -- `(modelName, records) -> errors`.
    //: Ставится снаружи (`logic.js`, `validator`); `null` -- правил нет. База не
    //: знает ни про WASM, ни про объявления действий, и знать не должна: она
    //: знает только то, что перед записью кого-то спрашивают. Пара к
    //: `Database.validator` в `oneframework/model/storage.py, удалён`.
    this.validator = null;
    this._validating = false;
    this._depth = 0;
    this._clock = null;
    this._clockDirty = false;
    this._requestFlush = requestFlush || (() => {});
    this._flushNow = flushNow || (() => {});
    // Регистр -- питоновский, а не ASCII-шный: `upper` у SQLite оставляет
    // «крыша» как есть и ничего об этом не говорит.
    this.con.handle.createFunction("pylower", (_ctx, v) =>
      typeof v === "string" ? v.toLowerCase() : v);
    this.con.handle.createFunction("pyupper", (_ctx, v) =>
      typeof v === "string" ? v.toUpperCase() : v);
    this.con.handle.createFunction("pycasefold", (_ctx, v) =>
      typeof v === "string" ? v.toLowerCase() : v);
    this.installStepLimit();
    this.con.handle.exec("PRAGMA foreign_keys = ON");
    // Журнал -- на диске, а не в памяти. Про `MEMORY` документация SQLite
    // говорит прямо: если приложение упало посреди транзакции, база «very
    // likely go corrupt». Здесь лежит единственная копия неотправленной работы
    // устройства -- цена падения несоизмерима с экономией на записи журнала.
    //
    // Режим измерен, а не выбран по документации. Проба на `opfs-sahpool`
    // (Chrome, 300 транзакций на режим):
    //
    //     delete    работает,  684 мс
    //     truncate  работает,  511 мс
    //     persist   работает,  525 мс
    //     memory    работает,  139 мс  -- журнала на диске нет
    //     wal       ОТКАЗ: PRAGMA возвращает `delete`, режим не меняется
    //     off       работает,  136 мс  -- журнала нет вовсе
    //
    // WAL на этом VFS невозможен: разделяемой памяти у него нет. Из
    // работающих и переживающих падение -- `delete`, `truncate` и `persist`.
    // Взят `delete`: он же умолчание SQLite, он же то, к чему VFS откатывается
    // сам, и его сохранность не зависит от того, долговечно ли на этой
    // файловой системе усечение файла. Разница с `truncate` -- 0.6 мс на
    // транзакцию, и это не та цена, за которую покупают такой довод.
    //
    // Режим не хранится в файле, кроме WAL, поэтому ставится на каждом
    // соединении -- то есть здесь.
    //
    // Признак заведён 20.08.2026 ради сервера на node. Там база живёт **в
    // памяти** -- поднимается из файла байтами и выгружается обратно, потому
    // что у сборки `sqlite-wasm` под node нет ни OPFS, ни файлового VFS. Файла
    // для журнала у такой базы нет вовсе, и `journal_mode = DELETE` отказывает
    // `SQLITE_CANTOPEN`. Довод выше от этого не отменяется: он про устройство,
    // где неотправленная работа лежит в единственном экземпляре. У сервера
    // экземпляр не единственный -- то же самое есть на устройствах, откуда оно
    // приехало, -- и цена падения там другая.
    this.con.handle.exec(`PRAGMA journal_mode = ${journal}`);
  }

  connect() {
    return this.con;
  }

  commit() {
    this._finish();
    this._requestFlush();
  }

  flushNow() {
    this._finish();
    this._flushNow();
  }

  // -- транзакция ---------------------------------------------------------
  /**
   * Одна граница «всё или ничего». Вложенность считается, а не открывает
   * вторую транзакцию: `create` внутри обработчика события обязан попасть в
   * транзакцию обработчика, а не завести свою.
   */
  transaction(fn) {
    const con = this.connect();
    if (this._depth) {
      this._depth += 1;
      try {
        return fn(con);
      } finally {
        this._depth -= 1;
      }
    }
    con.begin();
    this._depth = 1;
    const written = con.totalChanges();
    let out;
    try {
      out = fn(con);
    } catch (err) {
      this._depth = 0;
      this._clockDirty = false;
      con.rollback();
      if (this.tracker !== null) this.tracker.rolledBack(this);
      throw err;
    }
    this._depth = 0;
    this._finish();
    // Просить хранилище сброситься на каждое нажатие -- плата ни за что:
    // обработчик события открывает транзакцию всегда, а поиск по букве или
    // переключение вкладки ничего не пишет.
    if (con.totalChanges() !== written) this._requestFlush();
    return out;
  }

  /**
   * Граница правки, которая не едет по проводу: одна транзакция, внешние ключи
   * выключены, учёт снят. Было парой к `applying` в `oneframework/model/sync.py, удалён`.
   *
   * Два случая, и оба обязаны выставить всё три ровно один раз на границу:
   *
   * * **наложение чужого changeset.** Внешние ключи мешают: порядок изменений
   *   внутри changeset не наш, а удаление родителя и обнуление ссылок на него
   *   -- две разные строки одного changeset. Учёт снят, иначе наложенное чужое
   *   вернулось бы отправителю как наша собственная правка;
   * * **пересоздание таблицы** (`reshapeTable`). Это `DROP TABLE`, а сессия
   *   обмена снимает changeset с таблицы, которой к концу транзакции нет:
   *   sqlite отвечает `SQLITE_SCHEMA`, и обновление падает сообщением, в
   *   котором нет ни слова о перекладке. Ехать перекладке и незачем -- на
   *   другом конце её сделает своя `ensureSchema`, а changeset'ом это
   *   выглядело бы как «пользователь удалил и завёл заново всё, что имел».
   *
   * Вложенность узнаётся по состоянию, а не по счётчику: границу снаружи
   * открывает кто угодно, и снять чужие настройки на выходе значило бы вернуть
   * ключи и учёт посреди ещё не закрытой транзакции.
   */
  applying(fn) {
    const con = this.connect();
    const tracker = this.tracker;
    const outermost = this._depth === 0;
    const held = tracker !== null && !tracker.suspended;
    if (outermost) con.execute("PRAGMA foreign_keys = OFF");
    if (held) tracker.suspended = true;
    try {
      return this.transaction(fn);
    } finally {
      if (held) {
        tracker.suspended = false;
        tracker._restart();
      }
      if (outermost) con.execute("PRAGMA foreign_keys = ON");
    }
  }

  /**
   * Закрыть транзакцию: сначала учёт изменений, потом COMMIT. Порядок именно
   * такой -- changeset обязан лечь в исходящую очередь внутри той же
   * транзакции, что и данные, иначе падение между двумя коммитами оставит
   * правку, о которой обмен никогда не узнает.
   */
  _finish() {
    const con = this.con;
    if (con === null) return;
    if (this.tracker !== null) this.tracker.beforeCommit(this);
    if (this._clockDirty && this._clock !== null) {
      this.setMeta("hlc:last", this._clock.stamp());
      this._clockDirty = false;
    }
    con.commit();
    if (this.tracker !== null) this.tracker.afterCommit(this);
  }

  // -- отметки порядка ----------------------------------------------------
  clock() {
    if (this._clock === null) {
      let node = this.getMeta("hlc:node");
      if (!node) {
        node = nodeId();
        this.setMeta("hlc:node", node);
      }
      this._clock = new Clock({ node, last: this.getMeta("hlc:last") });
    }
    return this._clock;
  }

  stamp() {
    const value = this.clock().tick();
    this._clockDirty = true;
    return value;
  }

  receiveStamp(stamp) {
    const value = this.clock().receive(stamp);
    this._clockDirty = true;
    return value;
  }

  // -- схема --------------------------------------------------------------
  /**
   * Завести недостающие таблицы и привести имеющиеся к объявлению.
   *
   * Именно привести, а не дополнить. Прежде здесь было «только добавлять»:
   * снятое приложением поле сохраняло данные пользователя. Обещание оказалось
   * несовместимым с обменом -- см. `reshapeTable`.
   *
   * Перевода старых числовых ключей на UUID здесь нет -- он однократный и уже
   * прошёл там, где был нужен (см. migrate_to_uuid в питоне).
   */
  ensureSchema(models) {
    const con = this.connect();
    for (const model of models) {
      if (!this.models.includes(model)) this.models.push(model);
    }
    for (const model of models) {
      const cols = ['"id" TEXT PRIMARY KEY NOT NULL'];
      for (const f of model.storedFields()) {
        if (f.name === "id") continue;
        cols.push(`"${f.column}" ${f.sqlType}`);
      }
      // Версии колонок -- последней колонкой, и это не украшение: changeset
      // адресует значения номером колонки, поэтому место обязано быть одним и
      // тем же в питоне, в JS и в базе, доставшейся от прошлой версии.
      cols.push(`"${VERSION_COLUMN}" TEXT`);
      reshapeTable(this, model.table, cols);
    }
    // Уникальность One2one объявляется после таблиц, чтобы порядок моделей
    // ничего не решал.
    for (const model of models) {
      for (const rel of model.relations()) {
        if (rel.unique) {
          con.execute(
            `CREATE UNIQUE INDEX IF NOT EXISTS "uq_${model.table}_${rel.column}" ` +
              `ON "${model.table}" ("${rel.column}") WHERE "${rel.column}" IS NOT NULL`,
          );
        } else {
          // Индекс по ссылочной колонке -- обязанность схемы, а не того, кто
          // пишет запрос. Замерено на 300 списках и 3000 задачах: 38,85 мс без
          // него против 0,65 с ним.
          con.execute(
            `CREATE INDEX IF NOT EXISTS "ix_${model.table}_${rel.column}" ` +
              `ON "${model.table}" ("${rel.column}")`,
          );
        }
      }
    }
    for (const model of models) {
      for (const field of model.virtualFields()) {
        if (field.ftype !== "many2many") continue;
        const [table, ownCol, otherCol] = field.relation();
        const other = field.resolveComodel();
        con.execute(
          `CREATE TABLE IF NOT EXISTS "${table}" (` +
            `"${ownCol}" TEXT NOT NULL REFERENCES "${model.table}"(id) ON DELETE CASCADE, ` +
            `"${otherCol}" TEXT NOT NULL REFERENCES "${other.table}"(id) ON DELETE CASCADE, ` +
            `PRIMARY KEY ("${ownCol}", "${otherCol}"))`,
        );
      }
    }
    this.commit();
  }

  // -- проверка перед записью ---------------------------------------------
  /**
   * Спросить бизнес-логику про весь набор разом.
   *
   * Один вызов на набор, а не на строку: переход через границу стоит на
   * порядки дороже самой проверки. Повторный заход не пускается -- проверка
   * сама читает и пишет через ту же базу, и без замка первая же её запись
   * позвала бы проверку снова.
   */
  _validate(model, records) {
    if (!this.validator || this._validating || !records.length) return;
    this._validating = true;
    let errors;
    try {
      errors = this.validator(model.name, records);
    } finally {
      this._validating = false;
    }
    if (errors && errors.length) throw new ValidationError(errors);
  }

  // -- запись -------------------------------------------------------------
  /** Создать набор. Проверка -- одна на весь набор, до первого INSERT. */
  createMany(model, records) {
    const rows = records.map((r) => ({ ...(r || {}) }));
    this._validate(model, rows);
    return this.transaction(() => rows.map((r) => this._insert(model, r)));
  }

  /**
   * Изменить набор: `[[recordId, values], ...]`.
   *
   * Проверке отдаётся **запись целиком**, а не правка: правило вроде «у
   * выполненной задачи должна быть дата выполнения» -- утверждение о записи, и,
   * увидев одну колонку, проверка ответила бы про запись, которой нет.
   */
  writeMany(model, patches) {
    const real = patches.filter(([, v]) => v && Object.keys(v).length);
    if (real.length) {
      const current = this.readMany(model, real.map(([id]) => id));
      this._validate(model, real.map(([id, v]) => ({ ...(current[id] || { id }), ...v })));
    }
    this.transaction(() => {
      for (const [recordId, values] of patches) this._update(model, recordId, values);
    });
  }

  create(model, values = null) {
    return this.createMany(model, [values])[0];
  }

  _insert(model, values) {
    const vals = { ...(values || {}) };
    const row = {};
    const now = nowStamp();
    // Ключ придумывается здесь, а не базой: счётчик, выданный SQLite,
    // уникален только внутри одного файла.
    const recordId = key(vals.id || newId());
    const stamp = vals.hlc || this.stamp();
    for (const [name, f] of Object.entries(model.fields)) {
      if (!f.stored) continue;
      if (name === "id") {
        row.id = recordId;
        continue;
      }
      if (name === "hlc") {
        row.hlc = stamp;
        continue;
      }
      if (name === "created_at" || name === "updated_at") {
        row[f.column] = vals[name] || now;
        continue;
      }
      const raw = name in vals ? vals[name] : f.default();
      row[f.column] = f.toDb(raw);
    }
    const cols = Object.keys(row).map((c) => `"${c}"`).join(", ");
    const marks = Object.keys(row).map(() => "?").join(", ");
    this.transaction((con) => {
      con.execute(
        `INSERT INTO "${model.table}" (${cols}) VALUES (${marks})`,
        Object.values(row),
      );
    });
    return recordId;
  }

  write(model, recordId, values) {
    this.writeMany(model, [[recordId, values]]);
  }

  _update(model, recordId, values) {
    if (!values || !Object.keys(values).length) return;
    const row = {};
    for (const [name, raw] of Object.entries(values)) {
      const f = model.field(name);
      if (f.system || !f.stored) continue;
      row[f.column] = f.toDb(raw);
    }
    const touched = Object.keys(row);
    row.updated_at = nowStamp();
    // Каждая запись помечается, и по этой отметке слияние решает «кто позже».
    row.hlc = this.stamp();
    // Та же отметка кладётся отдельно на каждую тронутую колонку. Без этого «я
    // эту колонку не трогал» пришлось бы выводить сравнением значения с
    // предком, а такое сравнение не отличает «не трогал» от «поправил дважды и
    // вернул как было» -- и вторая правка теряется навсегда.
    if (touched.length) {
      row[VERSION_COLUMN] = this._bumpVersions(model.table, recordId, touched, row.hlc);
    }
    const assignments = Object.keys(row).map((c) => `"${c}" = ?`).join(", ");
    this.transaction((con) => {
      con.execute(
        `UPDATE "${model.table}" SET ${assignments} WHERE "id" = ?`,
        [...Object.values(row), key(recordId)],
      );
    });
  }

  unlink(model, recordId) {
    this.transaction((con) => {
      // Входящие ссылки обнуляются, чтобы ни одна строка не осталась с
      // висящей связью.
      for (const other of this.models) {
        for (const rel of other.relations()) {
          if (rel.resolveComodel() !== model || rel.ondelete !== "set null") continue;
          const stamp = this.stamp();
          // По строке, а не одним UPDATE: у каждой своя карта версий, а
          // обнуление ссылки -- такая же местная правка колонки, как любая
          // другая. Не пометь мы её, чужая старая ссылка вернула бы на место
          // связь с удалённой записью.
          const owners = con
            .execute(`SELECT "id" FROM "${other.table}" WHERE "${rel.column}" = ?`,
                     [key(recordId)])
            .map((r) => r.id);
          for (const owner of owners) {
            con.execute(
              `UPDATE "${other.table}" SET "${rel.column}" = NULL, "hlc" = ?, ` +
                `"${VERSION_COLUMN}" = ? WHERE "id" = ?`,
              [stamp, this._bumpVersions(other.table, owner, [rel.column], stamp), owner],
            );
          }
        }
      }
      con.execute(`DELETE FROM "${model.table}" WHERE "id" = ?`, [key(recordId)]);
    });
  }

  /** Карта версий записи с *columns*, помеченными отметкой *stamp*. */
  _bumpVersions(table, recordId, columns, stamp) {
    const row = this.connect().one(
      `SELECT "${VERSION_COLUMN}" AS cv FROM "${table}" WHERE "id" = ?`,
      [key(recordId)],
    );
    const versions = loadVersions(row ? row.cv : null);
    for (const column of columns) versions[column] = stamp;
    return dumpVersions(versions);
  }

  // -- чтение -------------------------------------------------------------
  /**
   * Строки модели. `extra` -- имена вычисленных колонок из проекции.
   *
   * Вычисляемое поле колонки в таблице не имеет, но в **выборке** имеет:
   * значение приезжает вместе со строкой. Без этого списка оно потерялось бы
   * молча -- разбор строки идёт по объявленным полям модели.
   */
  query(model, sql, params, extra = []) {
    this.resetStepLimit();
    return this.connect()
      .execute(sql, params)
      .map((r) => rowToObject(model, r, extra));
  }

  /**
   * Строки массивами, в том порядке, в каком их называет проекция.
   *
   * Пара к `query`, и смысл её в том, чего она не делает: ни модели, ни имён
   * колонок, ни преобразования. Список просит те несколько значений, из
   * которых сделаны его строки, и получает их; а запросу, у которого колонки --
   * выражения (`visible=`, посчитанное в SQL), называть их всё равно нечем.
   */
  select(sql, params) {
    this.resetStepLimit();
    return this.connect().rows(sql, params);
  }

  read(model, recordId) {
    const row = this.connect().one(
      `SELECT ${columnList(model)} FROM "${model.table}" WHERE "id" = ?`,
      [key(recordId)],
    );
    return row ? rowToObject(model, row) : null;
  }

  readMany(model, ids) {
    if (!ids || !ids.length) return {};
    const marks = ids.map(() => "?").join(", ");
    const rows = this.connect().execute(
      `SELECT ${columnList(model)} FROM "${model.table}" WHERE "id" IN (${marks})`,
      ids.map(key),
    );
    const out = {};
    for (const r of rows) out[r.id] = rowToObject(model, r);
    return out;
  }

  all(model, order = '"id" ASC') {
    return this.connect()
      .execute(`SELECT ${columnList(model)} FROM "${model.table}" ORDER BY ${order}`)
      .map((r) => rowToObject(model, r));
  }

  count(model) {
    return this.connect().scalar(`SELECT COUNT(*) FROM "${model.table}"`);
  }

  /**
   * Сколько записей отвечает уже скомпилированному условию. Своим запросом, а
   * не длиной `query(...)`: агрегат в виде спрашивают по разу на каждую копию
   * повторителя, и читать ради счёта целые строки -- та цена, которая видна
   * только на настоящем списке.
   */
  countWhere(model, whereSql, params, alias = "t") {
    let sql = `SELECT COUNT(*) FROM "${model.table}" ${alias}`;
    if (whereSql) sql += ` WHERE ${whereSql}`;
    return this.connect().scalar(sql, params);
  }

  maxValue(model, fieldName) {
    const f = model.field(fieldName);
    return this.connect().scalar(
      `SELECT MAX("${f.column}") FROM "${model.table}"`,
    );
  }

  // -- служебные записи ---------------------------------------------------
  _ensureMetaTable() {
    const con = this.connect();
    con.execute(
      'CREATE TABLE IF NOT EXISTS "_oneframework_meta" ("key" TEXT PRIMARY KEY, "value" TEXT)',
    );
    return con;
  }

  getMeta(k) {
    const row = this._ensureMetaTable().one(
      'SELECT "value" FROM "_oneframework_meta" WHERE "key" = ?',
      [k],
    );
    return row ? row.value : null;
  }

  /**
   * Предел работы на запрос. Считается **на запрос**, а не на жизнь вкладки:
   * считай он подряд, приложение однажды перестало бы отвечать, и виноват был
   * бы не тяжёлый запрос, а их количество.
   */
  installStepLimit(sqlite3 = this._sqlite3) {
    const capi = sqlite3 && sqlite3.capi;
    // Молчать здесь можно: без модуля базу заводит оснастка сверки, а не
    // приложение. Приложение передаёт модуль всегда и **проверяет ответ** --
    // громкость там, где она уместна (`worker.js`).
    if (!capi || !capi.sqlite3_progress_handler) return false;
    // Шаг обработчика крупный: сам вызов дороже шага вычислителя, и мерить
    // каждый значило бы платить за предел больше, чем он спасает. Поэтому
    // вызовов сторожу положено во столько же раз меньше, чем шагов, -- иначе
    // счётчик считает вызовы, а называется шагами.
    this._stepsLeft = stepBudget(this.stepLimit);
    capi.sqlite3_progress_handler(this.con.handle, STEP_TICK,
      () => (--this._stepsLeft <= 0 ? 1 : 0), 0);
    return true;
  }

  resetStepLimit() {
    if (this._stepsLeft !== undefined) this._stepsLeft = stepBudget(this.stepLimit);
  }

  setMeta(k, value) {
    this._ensureMetaTable().execute(
      'INSERT INTO "_oneframework_meta" ("key","value") VALUES (?,?) ' +
        'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"',
      [k, String(value)],
    );
  }

  // -- связи --------------------------------------------------------------
  readOne2many(field, ownerId, order = null) {
    const co = field.resolveComodel();
    const inverse = field.inverseField();
    const sql =
      `SELECT ${columnList(co)} FROM "${co.table}" WHERE "${inverse.column}" = ?` +
      ` ORDER BY ${order || '"id" ASC'}`;
    return this.connect()
      .execute(sql, [key(ownerId)])
      .map((r) => rowToObject(co, r));
  }

  readMany2many(field, ownerId) {
    const co = field.resolveComodel();
    const [table, ownCol, otherCol] = field.relation();
    const rows = this.connect().execute(
      `SELECT ${columnList(co, "c")} FROM "${table}" r ` +
        `JOIN "${co.table}" c ON c."id" = r."${otherCol}" ` +
        `WHERE r."${ownCol}" = ? ORDER BY c."id" ASC`,
      [key(ownerId)],
    );
    return rows.map((r) => rowToObject(co, r));
  }

  setMany2many(field, ownerId, ids) {
    const [table, ownCol, otherCol] = field.relation();
    this.transaction((con) => {
      con.execute(`DELETE FROM "${table}" WHERE "${ownCol}" = ?`, [key(ownerId)]);
      con.executeMany(
        `INSERT OR IGNORE INTO "${table}" ("${ownCol}", "${otherCol}") VALUES (?, ?)`,
        (ids || []).map((i) => [key(ownerId), key(i)]),
      );
    });
  }

  linkMany2many(field, ownerId, otherId, linked = true) {
    const [table, ownCol, otherCol] = field.relation();
    this.transaction((con) => {
      if (linked) {
        con.execute(
          `INSERT OR IGNORE INTO "${table}" ("${ownCol}", "${otherCol}") VALUES (?, ?)`,
          [key(ownerId), key(otherId)],
        );
      } else {
        con.execute(
          `DELETE FROM "${table}" WHERE "${ownCol}" = ? AND "${otherCol}" = ?`,
          [key(ownerId), key(otherId)],
        );
      }
    });
  }
}

/** Строка базы -> запись: только хранимые поля, каждое через своё приведение. */
function rowToObject(model, row, extra = []) {
  const out = {};
  for (const [name, f] of Object.entries(model.fields)) {
    if (!f.stored) continue;
    out[name] = f.fromDb(row[f.column]);
  }
  for (const name of extra) out[name] = row[name];
  return out;
}

function columnList(model, alias = null) {
  const prefix = alias ? `${alias}.` : "";
  return Object.values(model.fields)
    .filter((f) => f.stored)
    .map((f) => `${prefix}"${f.column}"`)
    .join(", ");
}

/**
 * Микросекундная точность, как у питоновского `Datetime.now`: отметки с
 * точностью до миллисекунды совпадают у записей, созданных в одном цикле, и
 * «сначала новые» начинает выглядеть случайным.
 */
function nowStamp() {
  const d = new Date();
  const iso = d.toISOString().slice(0, -1);
  return `${iso}000Z`;
}

export { rowToObject, columnList, nowStamp, key };

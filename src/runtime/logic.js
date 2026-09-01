/**
 * Бизнес-логика в WASM: хост на стороне браузера. Питоновская половина
 * (`oneframework/wasm/`) удалена 21.08.2026 -- здесь она единственная.
 *
 * Логика пишется на любом языке, компилируется в WASM, лежит блобом в SQLite
 * рядом с данными и исполняется **офлайн** -- движком самого браузера, без
 * единой сетевой загрузки и без единой зависимости. Здесь три части, и они те
 * же самые, что у питона, файл в файл:
 *
 * * `Api` -- десять вызовов, которые логика имеет право сделать
 *   (было `oneframework/wasm/api.py`, удалён). Ни SQLite, ни экрана модуль не касается;
 * * `LogicModule` -- разметка кадра и работа с чужой памятью
 *   (`oneframework/wasm/host.py, удалён`). Отличие ровно одно: `WebAssembly` вместо
 *   `wasmtime` и `TextEncoder` вместо `.encode()`;
 * * чтение модулей из базы (питоновская выкладка удалена).
 *
 * Договор целиком записан в `protocol/logic.json`. Тесты, закреплявшие его и
 * одинаковость ответов двух хостов, унесли вместе с рантаймом WASM на стороне
 * питона: пары у этого файла больше нет, и назвать сторожа нечем.
 *
 * Чего здесь нет и не может быть: **топлива**. У WebAssembly в браузере нет
 * счётчика инструкций, поэтому потолок времени тут задаётся только тем, что
 * рантайм и так живёт в воркере, а воркер можно прервать. Это записано в
 * `protocol/logic.json` (`limits.missing`), а не умолчано.
 */

import { QueryContext, buildSelect, compileDomain, compileOrder } from "./query.js";
import { now as nowStamp } from "./fields.js";
import * as keys from "./keys.js";
import { sha256Hex } from "./sha256.js";
import {
  declarativeAction, isDeclarative, isJs, isPython, isWasm,
} from "../rel/action.js";

/** Версия ABI: разметка кадра. Гость обязан объявить такую же. */
export const ABI = 1;

/** Версия договора: содержимое кадра. Не то же, что ABI, -- см. api.py. */
export const PROTOCOL = "1.0";

/** Замороженный список вызовов. Всё, чего здесь нет, логике недоступно. */
export const OPS = [
  "read", "search", "count", "create", "write", "unlink",
  "call", "schema", "now", "log",
];

/** Потолок одного чтения -- тот же, что у питона. */
export const MAX_RECORDS = 10000;

export const LOGIC_TABLE = "_oneframework_logic";

/** Вид определения, которым объявлено действие; в `KINDS` он уже есть. */
export const MANIFEST_KIND = "action";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ApiError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details || {};
  }

  frame() {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

export class WasmError extends Error {
  constructor(message) {
    super(message);
    this.name = "WasmError";
  }
}

// --------------------------------------------------------------------------
// значения
// --------------------------------------------------------------------------
function scaleOf(field) {
  const digits = field.digits || [16, 2];
  return 10 ** digits[1];
}

/**
 * Округление половины к чётному -- как `round()` в питоне, а не `Math.round`.
 *
 * `Math.round(12.5)` даёт 13, `round(12.5)` в питоне -- 12. Это ровно копейка
 * разницы на сумме, попавшей между копейками, и она не даёт ни ошибки, ни
 * следа: устройство и сервер просто считают по-разному. Подстраивается JS,
 * потому что деньги ведёт питон, а не наоборот.
 */
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Значение из базы -> значение на проводе. Пара к `to_wire` в api.py. */
export function toWire(field, value) {
  if (value === null || value === undefined) return null;
  if (field.ftype === "monetary") return roundHalfEven(Number(value) * scaleOf(field));
  if (field.ftype === "boolean") return Boolean(value);
  if (field.ftype === "many2one" || field.ftype === "one2one") return String(value);
  return value;
}

/** Значение с провода -> значение для базы. */
export function fromWire(field, value) {
  if (value === UNSET_MARK) return UNSET_MARK;
  if (value === null || value === undefined) return null;
  if (field.ftype === "monetary") return Number(value) / scaleOf(field);
  if (field.ftype === "boolean") return Boolean(value);
  return value;
}

//: «Не выбрано». Своим значением, а не `undefined`: `undefined` в JS означает
//: заодно «ключа нет», а это по договору другой смысл (см. `absent`).
const UNSET_MARK = Symbol("unset");

/** Развернуть зарезервированную форму `{"unset": true}`. */
function decode(value) {
  if (value && typeof value === "object" && !Array.isArray(value)
      && value.unset === true && Object.keys(value).length === 1) {
    return UNSET_MARK;
  }
  return value;
}

// --------------------------------------------------------------------------
// десять вызовов
// --------------------------------------------------------------------------
export class Api {
  /**
   * @param db      база рантайма (`db.js`)
   * @param models  модели, собранные `makeModels`
   * @param docs    документы моделей для вызова `schema` -- те самые, что
   *                лежат в `_oneframework_def`. Отдаются снаружи, а не читаются
   *                отсюда: у логики один источник схемы с остальным рантаймом
   * @param now     часы; у WASM их нет, а тест обязан уметь закрепить «сегодня»
   * @param actions что доступно через `call`
   */
  constructor(db, models, { docs = null, now = null, actions = null,
                            maxRecords = MAX_RECORDS } = {}) {
    this.db = db;
    this.models = {};
    for (const model of Array.isArray(models) ? models : Object.values(models)) {
      this.models[model.name] = model;
    }
    this.docs = docs || {};
    this._now = now || (() => nowStamp());
    this.actions = { ...(actions || {}) };
    this.maxRecords = maxRecords;
    this.logs = [];
  }

  /**
   * Запрос -> кадр ответа. Исключение наружу не выпускается никогда: сорванный
   * вызов через границу теряет и сообщение, и место, где это случилось, а
   * логика обязана узнать об отказе и решить, что делать.
   */
  dispatch(request) {
    try {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new ApiError("bad_request", "Запрос должен быть объектом.");
      }
      const op = request.op;
      if (!OPS.includes(op)) {
        throw new ApiError(
          "unknown_op",
          `Неизвестный вызов ${JSON.stringify(op)}. Доступны: ${OPS.join(", ")}.`,
        );
      }
      // Вызов пакетный по построению, значит и граница «всё или ничего»
      // проходит по вызову: набор из тысячи записей, упавший на пятисотой, не
      // имеет права оставить пятьсот.
      return { ok: this.db.transaction(() => this.run(op, request)) };
    } catch (err) {
      if (err instanceof ApiError) return err.frame();
      // То же правило, что у питона: отказ фреймворка приезжает кодом по имени
      // своего класса, а безымянная поломка -- `internal`.
      const code = err && err.name && err.name !== "Error"
        ? err.name.toLowerCase()
        : "internal";
      return { error: { code, message: String((err && err.message) || err) } };
    }
  }

  run(op, request) {
    switch (op) {
      case "read": return this.opRead(request);
      case "search": return this.opSearch(request);
      case "count": return this.opCount(request);
      case "create": return this.opCreate(request);
      case "write": return this.opWrite(request);
      case "unlink": return this.opUnlink(request);
      case "call": return this.opCall(request);
      case "schema": return this.opSchema(request);
      case "now": return this.opNow(request);
      case "log": return this.opLog(request);
      default: throw new ApiError("unknown_op", `Неизвестный вызов ${op}.`);
    }
  }

  // -- вспомогательное ----------------------------------------------------
  model(name) {
    const model = this.models[name];
    if (!model) {
      throw new ApiError(
        "unknown_model",
        `Модель ${JSON.stringify(name)} этому приложению неизвестна. `
          + `Есть: ${Object.keys(this.models).sort().join(", ")}.`,
      );
    }
    return model;
  }

  field(model, name) {
    const field = model.fields[name];
    if (!field) {
      throw new ApiError(
        "unknown_field", `У модели ${model.name} нет поля ${JSON.stringify(name)}.`,
        { model: model.name, field: name },
      );
    }
    return field;
  }

  required(request, key) {
    if (!(key in request)) {
      throw new ApiError(
        "bad_request",
        `В вызове ${JSON.stringify(request.op)} нет обязательного ключа `
          + `${JSON.stringify(key)}.`,
      );
    }
    return request[key];
  }

  selected(model, request) {
    const asked = request.fields;
    if (!asked || !asked.length) {
      return [model.fieldList.filter((f) => f.stored).map((f) => f.name), []];
    }
    const stored = [];
    const virtual = [];
    for (const name of asked) {
      (this.field(model, name).stored ? stored : virtual).push(name);
    }
    // Связь-набор читается по владельцу: ключ нужен нам самим, а логика
    // спросила `tags`, а не `id`.
    if (virtual.length && !stored.includes("id")) stored.unshift("id");
    return [stored, virtual];
  }

  rowToWire(model, row, names) {
    const out = {};
    for (const name of names) out[name] = toWire(model.fields[name], row[name]);
    return out;
  }

  attachVirtual(model, records, names) {
    for (const name of names) {
      const field = model.fields[name];
      for (const record of records) {
        const rows = field.ftype === "one2many"
          ? this.db.readOne2many(field, record.id)
          : this.db.readMany2many(field, record.id);
        record[name] = rows.map((r) => r.id);
      }
    }
  }

  values(model, raw) {
    const values = {};
    const links = {};
    for (const [name, given] of Object.entries(raw || {})) {
      const field = this.field(model, name);
      const value = decode(given);
      if (value === UNSET_MARK) continue;       // «не выбрано» -- не трогаем
      if (field.ftype === "many2many") {
        links[name] = (value || []).map(String);
        continue;
      }
      if (field.ftype === "one2many") {
        throw new ApiError(
          "readonly_field",
          `${model.name}.${name} -- обратная сторона связи, она пишется со `
            + "стороны потомка.",
          { model: model.name, field: name },
        );
      }
      if (field.system) {
        throw new ApiError(
          "readonly_field", `${model.name}.${name} ведёт фреймворк, его не пишут.`,
          { model: model.name, field: name },
        );
      }
      values[name] = fromWire(field, value);
    }
    return [values, links];
  }

  // -- вызовы -------------------------------------------------------------
  opRead(request) {
    const model = this.model(request.model);
    const ids = (this.required(request, "ids") || []).map(String);
    if (ids.length > this.maxRecords) {
      throw new ApiError("too_many", `За раз читается не больше ${this.maxRecords} записей.`);
    }
    const [stored, virtual] = this.selected(model, request);
    const found = this.db.readMany(model, ids);
    // Порядок ответа -- порядок запроса: логика сопоставляет по позиции.
    const records = ids.filter((id) => found[id])
      .map((id) => this.rowToWire(model, found[id], stored));
    this.attachVirtual(model, records, virtual);
    return { records };
  }

  opSearch(request) {
    const model = this.model(request.model);
    const ctx = new QueryContext(model);
    const asked = request.limit;
    const limit = asked === undefined || asked === null
      ? this.maxRecords
      : Math.min(Number(asked), this.maxRecords);
    let where;
    let orderSql;
    try {
      orderSql = compileOrder(request.order || [], ctx);
      where = [compileDomain(request.domain ?? null, ctx)];
    } catch (err) {
      throw new ApiError("bad_domain", String(err.message || err));
    }
    const [sql, params] = buildSelect(model, ctx, where, orderSql,
                                      { limit, offset: request.offset ?? null });
    const rows = this.db.query(model, sql, params);
    const [stored, virtual] = this.selected(model, request);
    const records = rows.map((row) => this.rowToWire(model, row, stored));
    this.attachVirtual(model, records, virtual);
    return { records };
  }

  opCount(request) {
    const model = this.model(request.model);
    const ctx = new QueryContext(model);
    let part;
    try {
      part = compileDomain(request.domain ?? null, ctx);
    } catch (err) {
      throw new ApiError("bad_domain", String(err.message || err));
    }
    const [sql, params] = part || [null, []];
    return { count: this.db.countWhere(model, sql, params, ctx.alias) };
  }

  opCreate(request) {
    const model = this.model(request.model);
    const records = this.required(request, "records") || [];
    if (records.length > this.maxRecords) {
      throw new ApiError("too_many", `За раз создаётся не больше ${this.maxRecords} записей.`);
    }
    // Набор кладётся набором, а не строкой за строкой: проверка при сохранении
    // сама уходит за границу, и по записи за раз она стоила бы перехода на
    // строку -- ровно того, ради чего эта граница пакетна.
    const prepared = records.map((raw) => this.values(model, raw));
    const ids = this.db.createMany(model, prepared.map(([values]) => values));
    ids.forEach((id, i) => {
      for (const [name, targets] of Object.entries(prepared[i][1])) {
        this.db.setMany2many(model.fields[name], id, targets);
      }
    });
    return { ids };
  }

  opWrite(request) {
    const model = this.model(request.model);
    const records = this.required(request, "records") || [];
    if (records.length > this.maxRecords) {
      throw new ApiError("too_many", `За раз пишется не больше ${this.maxRecords} записей.`);
    }
    const patches = [];
    const linkage = [];
    for (const entry of records) {
      if (entry.id === undefined || entry.id === null) {
        throw new ApiError("bad_request", "В наборе для записи есть элемент без id.");
      }
      const [values, links] = this.values(model, entry.values);
      patches.push([entry.id, values]);
      linkage.push([entry.id, links]);
    }
    this.db.writeMany(model, patches);
    for (const [id, links] of linkage) {
      for (const [name, targets] of Object.entries(links)) {
        this.db.setMany2many(model.fields[name], id, targets);
      }
    }
    return { written: records.length };
  }

  opUnlink(request) {
    const model = this.model(request.model);
    const ids = (this.required(request, "ids") || []).map(String);
    for (const id of ids) this.db.unlink(model, id);
    return { deleted: ids.length };
  }

  opCall(request) {
    const name = this.required(request, "action");
    const action = this.actions[name];
    if (!action) {
      throw new ApiError(
        "unknown_action",
        `Действие ${JSON.stringify(name)} не зарегистрировано. `
          + `Есть: ${Object.keys(this.actions).sort().join(", ") || "—"}.`,
      );
    }
    return action(request.args || {});
  }

  opSchema(request) {
    const doc = (name) => {
      const found = this.docs[name];
      if (!found) {
        throw new ApiError(
          "unknown_model",
          `Документа модели ${JSON.stringify(name)} у рантайма нет.`,
        );
      }
      return found;
    };
    if (request.model === undefined || request.model === null) {
      return { models: Object.keys(this.models).map(doc) };
    }
    this.model(request.model);
    return doc(request.model);
  }

  opNow() {
    return { now: this._now() };
  }

  opLog(request) {
    this.logs.push(String(request.message ?? ""));
    return {};
  }
}

// --------------------------------------------------------------------------
// исполнение модуля
// --------------------------------------------------------------------------
// Здесь стоял `LogicModule` -- разворот модуля WASM, разметка кадра и работа
// с чужой памятью. Модулей больше нет (16.08.2026): действия описываются
// данными, и разворачивать нечего. См. `src/rel/action.js`.

// --------------------------------------------------------------------------
// модули, лежащие в базе
// --------------------------------------------------------------------------
export function ensureTable(db) {
  const con = db.connect();
  con.execute(
    `CREATE TABLE IF NOT EXISTS "${LOGIC_TABLE}" (`
      + '"digest" TEXT NOT NULL PRIMARY KEY, "bytes" BLOB NOT NULL, '
      + '"size" INTEGER NOT NULL, "abi" INTEGER NOT NULL, '
      + '"language" TEXT NOT NULL DEFAULT \'\', "hlc" TEXT NOT NULL DEFAULT \'\')',
  );
  return con;
}

/**
 * Отказать, если подпись модуля не сходится, -- или пропустить, если ключа нет.
 *
 * Ключа нет -- проверять не с чем, и это не разрешение, а состояние прежней
 * сборки: устройство, поставленное до появления подписи, обязано работать как
 * работало. Питоновская пара (`check_signature`) удалена вместе с выкладкой.
 */
export async function checkSignature(db, digest, signature) {
  const key = keys.publisherKey(db);
  if (key === null) return false;
  try {
    await keys.verify(key, keys.MODULE, digest, signature);
  } catch (err) {
    throw new WasmError(
      `Модуль ${digest.slice(0, 12)}… не принят: ${err.message || err} `
        + "Исполняемый код без доказанного издателя на устройство не кладётся.",
    );
  }
  return true;
}

//: `receiveModules` жил здесь -- приём **байтов** модуля обменом с проверкой
//: отпечатка и подписи. Байты модулей убраны 16.08.2026 вместе с рантаймом
//: WASM: действия едут объявлениями, той же дорогой, что модели и виды.
//: Отправляющая половина ушла тогда же, принимающая осталась и не звалась
//: ни разу.
function fromBase64(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Объявления действий: они лежат в `_oneframework_def` видом `action`. */
export function manifests(db) {
  return db.connect()
    .execute(
      'SELECT "doc" FROM "_oneframework_def" WHERE "kind" = ? ORDER BY "name"',
      [MANIFEST_KIND],
    )
    .map((r) => JSON.parse(r.doc));
}

/**
 * Готовый вызов действия из базы: `(args) -> результат`.
 *
 * Ровно та форма, которую ждёт `Api.actions`, и это не совпадение: логика,
 * зовущая `call`, не должна различать, лежит ли вызываемое в соседнем модуле
 * или написано на JS. Различает только хост.
 */
export async function loadAction(db, name, api) {
  const doc = manifests(db).find((m) => m.name === name);
  if (!doc) throw new WasmError(`Действие ${JSON.stringify(name)} не объявлено.`);
  if (isWasm(doc)) return sourceAction(db, doc, api, "wasm");
  if (isJs(doc)) return sourceAction(db, doc, api, "js");
  if (isPython(doc)) return sourceAction(db, doc, api, "python");
  if (!isDeclarative(doc)) {
    throw new WasmError(
      `Объявление ${JSON.stringify(name)} ссылается на точку входа в модуль, ` +
      "а модулей больше нет: действие описывается «rule» и «write».");
  }
  // Ни модуля, ни подписи, ни рантайма WASM. Проверять подпись нечему -- байт
  // нет; объявление приезжает той же дорогой, что модели и виды, и его
  // прикрывает тот же рубеж: сервер отвергает чужие правки таблиц определений.
  return declarativeAction(db, doc, (api && api._now) || nowStamp);
}

/**
 * Действие, считаемое настоящим питоном на устройстве.
 *
 * Рантайм поднимается **при первом вызове**, а не на старте: замерено, подъём
 * стоит секунды, и платить их всем ради возможности, нужной единицам, нельзя.
 * Дальше он остаётся поднятым, и следующие вызовы идут сразу.
 *
 * Записи не передаются пачкой «на всякий случай»: объявление называет, что
 * ему нужно, и кадр собирается по этому имени -- как у остальных действий.
 */
/**
 * Действие, у которого объявление везёт **исходник**.
 *
 * Дорог у исходника две, и различает их только строчка ниже: питон
 * поднимает Pyodide при первом вызове, JavaScript исполняется тем движком,
 * который и так работает. Всё остальное -- сбор кадра, разрешённая запись,
 * ответ -- у них общее, и это не совпадение: кто исполняет, приложение знать
 * не должно.
 */
function sourceAction(db, doc, api, язык) {
  const { source, entry, module: имя_модуля } = doc[язык];
  const run = async (payload = {}) => {
    // Три способа запуска, и различает их только эта развилка. Всё
    // остальное -- сбор кадра, разрешённая запись, ответ -- общее: чем именно
    // считается действие, приложение знать не должно.
    const выполнить = язык === "python"
      ? (await import("./python.js")).runPythonAction
      : язык === "wasm"
        ? (await import("./wasm_action.js")).runWasmAction
        : (await import("./js_action.js")).runJsAction;
    const кадр = { ...payload };
    if (doc.model && Array.isArray(payload.ids)) {
      // Запись отдаётся полем, а не идентификатором: питон на устройстве
      // читать базу не умеет и не должен -- границу держим мы.
      const m = api.model(doc.model);
      кадр.records = payload.ids.map((id) => db.read(m, id)).filter(Boolean);
    }
    const ответ = await выполнить(
      язык === "wasm" ? имя_модуля : source,
      entry || doc.name.split(".").pop(), кадр);
    // Питон **считает**, а пишет хост. Граница здесь не формальность: база у
    // нас ведёт учёт правок для обмена, и запись мимо неё не уехала бы на
    // другие устройства -- разошлись бы молча.
    const записать = doc[язык].writes ? (ответ?.records || []) : [];
    if (записать.length) {
      const m = api.model(doc.model);
      // Своя транзакция: действие асинхронное, и к этой минуте та, в которой
      // его позвали, давно закрыта. Замерено на стенде -- без этого запись
      // просто пропадала: питон считал верно, а поле не менялось.
      db.transaction(() => {
        for (const запись of записать) {
          const { id, ...поля } = запись;
          const разрешённые = {};
          for (const имя of doc[язык].writes) {
            if (имя in поля) разрешённые[имя] = поля[имя];
          }
          if (id && Object.keys(разрешённые).length) db.write(m, id, разрешённые);
        }
      });
    }
    return ответ;
  };
  // Объявление едет **вместе с вызовом**: по нему рантайм собирает кадр и
  // читает ответ. Без него вызов приходит с пустыми руками -- и падает не там,
  // где ошибка.
  run.manifest = doc;
  run.declarative = true;
  return run;
}

/** Как называется проверка набора у модели. Пара к `store.VALIDATE_ACTION`. */
export const VALIDATE_ACTION = (model) => `${model}.validate`;

/**
 * Аргумент точки входа: что сказала кнопка плюс то, что знает экран.
 *
 * Подстановка идёт **по типу из объявления**, а не по имени, угаданному
 * рантаймом: имя аргумента принадлежит модулю, и требовать от него звать набор
 * именно `ids` значило бы протащить соглашение фреймворка внутрь чужого языка.
 * Питоновская пара (`bind_args`) удалена вместе с выкладкой -- здесь
 * единственная реализация.
 */
export function bindArgs(doc, given = null, recordIds = []) {
  const args = { ...(given || {}) };
  const ids = [...recordIds];
  for (const spec of doc.args || []) {
    const name = spec.name;
    if (!name || name in args) continue;
    if (spec.type === "ids") args[name] = ids;
    else if (spec.type === "id" && ids.length) args[name] = ids[0];
  }
  return args;
}

/** Чем отвечает вычисляемое поле -- первым объявленным возвратом. */
export function resultKey(doc) {
  const returns = doc.returns || [];
  return returns.length ? returns[0].name : null;
}

/** Проверка набора перед записью -- `(model, records) -> errors`. */
export function validator(api) {
  return (model, records) => {
    const run = api.actions[VALIDATE_ACTION(model)];
    if (!run) return [];
    // Значения приводятся здесь, а не в базе: деньги на проводе -- целые
    // копейки, и знает об этом граница, а не хранилище.
    const klass = api.models[model];
    const wire = records.map((record) => {
      if (!klass) return { ...record };
      const out = {};
      for (const [name, value] of Object.entries(record)) {
        const field = klass.fields[name];
        out[name] = field ? toWire(field, value) : value;
      }
      return out;
    });
    const answer = run({ model, records: wire }) || {};
    return answer[resultKey(run.manifest) || "errors"] || [];
  };
}

/** Отдать логике все объявленные действия. Возвращает их имена. */
export async function register(db, api) {
  const names = [];
  for (const doc of manifests(db)) {
    // Проверка набора считается **внутри записи**, а запись синхронна:
    // транзакция не умеет дождаться обещания. Действие на исходном языке
    // обещание и возвращает, а `validator` читает у ответа поле с ошибками --
    // у обещания такого поля нет, и проверка молча пропускала бы всё.
    //
    // Отказ громкий и при загрузке, а не тишина при первой записи: проверка,
    // которая ничего не проверяет, хуже отсутствующей -- на неё рассчитывают.
    // Нашёл это разбор со стороны 20.08.2026; своей проверки на этот случай у
    // нас не было ни одной.
    if (doc.name.endsWith(".validate") && (isWasm(doc) || isJs(doc) || isPython(doc))) {
      throw new WasmError(
        `Проверка ${JSON.stringify(doc.name)} написана на исходном языке, а `
        + "считается она внутри записи, где ждать нечем: запись синхронна. "
        + "Опишите проверку «rule» и «write» -- они считаются на месте.",
      );
    }
    // Один экземпляр модуля на действие -- сознательно: экземпляр держит своё
    // состояние, и делить его между действиями значило бы дать одному
    // действию видеть последствия другого.
    api.actions[doc.name] = await loadAction(db, doc.name, api);
    names.push(doc.name);
  }
  return names;
}

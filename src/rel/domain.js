/**
 * Домен -> параметризованный SQL. Без WASM.
 *
 * Последнее, что держало `core.wasm`. Четыре правила, ради которых оно туда
 * когда-то уезжало, перенесены сюда дословно:
 *
 * 1. **UNSET расширяет выборку.** Сравнение с UNSET -- это «нет условия», а не
 *    `IS NULL`. Через `&` часть выпадает, через `|` и `!` поглощает всё
 *    выражение. Именно на этом две прежние копии и разошлись: SQL показывал все
 *    строки, а фронтенд прятал все -- ни исключения, ни записи в журнале.
 * 2. **`null` -- это не UNSET.** Он ставит условие (`IS NULL`), а не снимает.
 * 3. **Голой ссылкой может стоять только boolean.**
 * 4. **Любое пользовательское значение -- параметр `?`.**
 *
 * Два места, где JavaScript пришлось **отучать** от родных привычек, и оба --
 * ровно те, на которых копии расходятся молча:
 *
 * * `Boolean([])` в JS -- истина, в питоне -- ложь. Здесь берётся питоновское
 *   правило: сюда попадает состояние экрана, а оно бывает каким угодно;
 * * `<` в JS приводит типы (`null < false` даёт `false`), а питон на этом
 *   отказывается сравнивать. Здесь отказ воспроизведён: мягкий ответ построил
 *   бы `(1=0)` там, где эталон не отвечает вовсе.
 */

import { canonical } from "../runtime/canon.js";

/** Шесть сравнений. Ровно те, что понимает `Cmp` в `oneframework/model/expr.py`. */
const OPS = new Set(["=", "!=", "<", "<=", ">", ">="]);

/** Оператор переворачивается, когда колонка оказалась справа. */
const FLIP = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "!=": "!=" };

/** «Пользователь ещё не выбирал» -- отдельно от `null`. */
const UNSET = Symbol("unset");

export class DomainError extends Error {}

// --------------------------------------------------------------------------
// документ модели и контекст
// --------------------------------------------------------------------------
class Model {
  constructor(doc) {
    this.table = doc.table || "";
    this.fields = (doc.fields || []).map((item) => ({
      name: item.name || "",
      column: item.column ?? null,
      ftype: item.ftype || "string",
      // Умолчание -- «хранится»: поле без `stored` хост считает колонкой.
      stored: item.stored !== false,
    }));
    this.byName = new Map(this.fields.map((f, i) => [f.name, i]));
  }

  index(name) {
    return this.byName.has(name) ? this.byName.get(name) : null;
  }
}

class Ctx {
  constructor(node) {
    const doc = node || {};
    this.model = doc.model && typeof doc.model === "object" ? new Model(doc.model) : null;
    this.state = doc.state && typeof doc.state === "object" && !Array.isArray(doc.state)
      ? doc.state : {};
    this.alias = doc.alias || "t";
  }

  column(index) {
    const field = this.model.fields[index];
    if (field.column && field.stored) return `${this.alias}."${field.column}"`;
    throw new DomainError(
      `Field '${field.name}' is not stored, so it is not a column.`);
  }

  field(name) {
    if (!this.model) {
      throw new DomainError(
        `'record.${name}' can only be used inside a record/List context.`);
    }
    const index = this.model.index(name);
    if (index === null) throw new DomainError(`Unknown field '${name}' in model.`);
    return index;
  }

  /** Узел документа -> `["col", sql, index]` либо `["val", значение]`. */
  resolve(node) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return ["val", node === undefined ? null : node];
    }
    if (node.unset === true) return ["val", UNSET];
    if (!("op" in node)) {
      if (typeof node.r === "string") {
        const index = this.field(node.r);
        return ["col", this.column(index), index];
      }
      if (typeof node.v === "string") {
        // Ключа нет -- пользователь ещё не выбирал: UNSET, а не NULL.
        if (!Object.prototype.hasOwnProperty.call(this.state, node.v)) return ["val", UNSET];
        const value = this.state[node.v];
        if (value && typeof value === "object" && value.unset === true) return ["val", UNSET];
        return ["val", value === undefined ? null : value];
      }
      if (typeof node.i === "string") {
        throw new DomainError(`Cannot resolve reference item.${node.i}`);
      }
    }
    throw new DomainError(`Cannot resolve reference ${canonical(node)}`);
  }
}

// --------------------------------------------------------------------------
// истинность и сравнение по-питоновски
// --------------------------------------------------------------------------
function truthy(value) {
  if (value === UNSET || value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Имя типа для сообщения об отказе.
 *
 * **Одно расхождение с питоном объявлено:** целое и дробное здесь неразличимы.
 * JSON-число `1.0` разбирается в `1`, и сказать про него «float» неоткуда --
 * питон говорит. Разница видна только в тексте отказа на несравнимых типах, и
 * закреплена тестом, чтобы не считаться недосмотром.
 */
function kindOf(value) {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}

function numeric(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  return null;
}

/** «Меньше» по-питоновски, вместе с отказом. */
function pyLt(a, b) {
  const x = numeric(a);
  const y = numeric(b);
  if (x !== null && y !== null) return x < y;
  if (typeof a === "string" && typeof b === "string") {
    // Python сравнивает строки по кодовым точкам.
    const ax = [...a];
    const bx = [...b];
    for (let i = 0; i < Math.min(ax.length, bx.length); i += 1) {
      const d = ax[i].codePointAt(0) - bx[i].codePointAt(0);
      if (d !== 0) return d < 0;
    }
    return ax.length < bx.length;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (pyLt(a[i], b[i])) return true;
      if (pyLt(b[i], a[i])) return false;
    }
    return a.length < b.length;
  }
  throw new DomainError(
    `'<' not supported between instances of ${kindOf(a)} and ${kindOf(b)}`);
}

/** Обе стороны -- значения: ответ известен заранее. Обе сравниваются всегда. */
function pyCmp(op, a, b) {
  const lt = pyLt(a, b);
  const gt = pyLt(b, a);
  if (op === "=") return !lt && !gt;
  if (op === "!=") return lt || gt;
  if (op === "<") return lt;
  if (op === "<=") return !gt;
  if (op === ">") return gt;
  return !lt;
}

// --------------------------------------------------------------------------
// домен
// --------------------------------------------------------------------------
function flatten(parts, op, out) {
  for (const part of parts) {
    if (part && typeof part === "object" && part.op === op && Array.isArray(part.p)) {
      flatten(part.p, op, out);
    } else {
      out.push(part);
    }
  }
}

function partsOf(node, op) {
  const out = [];
  if (Array.isArray(node.p)) flatten(node.p, op, out);
  return out;
}

export function compileDomain(node, ctx) {
  if (node === null || node === undefined) return [null, []];
  if (typeof node !== "object" || Array.isArray(node)) {
    throw new DomainError(`Cannot compile domain node ${canonical(node)}`);
  }
  const op = typeof node.op === "string" ? node.op : null;

  if (op === "&") {
    const sqls = [];
    let params = [];
    for (const part of partsOf(node, "&")) {
      const [sql, got] = compileDomain(part, ctx);
      // Отсутствующая часть просто выпадает: остальные в силе.
      if (sql !== null) { sqls.push(sql); params = params.concat(got); }
    }
    return sqls.length ? [`(${sqls.join(" AND ")})`, params] : [null, []];
  }

  if (op === "|") {
    const sqls = [];
    let params = [];
    for (const part of partsOf(node, "|")) {
      const [sql, got] = compileDomain(part, ctx);
      // Одна неограниченная ветка делает неограниченным весь OR.
      if (sql === null) return [null, []];
      sqls.push(sql);
      params = params.concat(got);
    }
    return sqls.length ? [`(${sqls.join(" OR ")})`, params] : [null, []];
  }

  if (op === "!") {
    const [sql, params] = compileDomain(node.e ?? null, ctx);
    return sql === null ? [null, []] : [`(NOT ${sql})`, params];
  }

  if (op === "null") {
    const side = ctx.resolve(node.e ?? null);
    if (side[0] === "col") return [`(${side[1]} IS NULL)`, []];
    throw new DomainError("is_null() is only valid on a stored field.");
  }

  if (op !== null && OPS.has(op)) return compileCmp(op, node, ctx);
  if (op !== null) {
    // Кавычки двойные: эталон печатал через Debug-формат Rust.
    throw new DomainError(`Unknown operation ${JSON.stringify(op)} in expression.`);
  }
  if ("r" in node || "v" in node || "i" in node) return compileBare(node, ctx);
  throw new DomainError(`Cannot compile domain node ${canonical(node)}`);
}

function compileCmp(op, node, ctx) {
  const left = ctx.resolve(node.l ?? null);
  const right = ctx.resolve(node.r ?? null);

  // UNSET с любой стороны -- условие снимается целиком.
  if ((left[0] === "val" && left[1] === UNSET) || (right[0] === "val" && right[1] === UNSET)) {
    return [null, []];
  }
  // Две колонки: подставлять нечего, параметров нет.
  if (left[0] === "col" && right[0] === "col") {
    return [`(${left[1]} ${op} ${right[1]})`, []];
  }

  let column;
  let index;
  let value;
  let effective = op;
  if (left[0] === "col") {
    [, column, index] = left;
    value = right[1];
  } else if (right[0] === "col") {
    [, column, index] = right;
    value = left[1];
    effective = FLIP[op] || "=";
  } else {
    return [pyCmp(op, left[1], right[1]) ? "(1=1)" : "(1=0)", []];
  }

  // NULL нельзя сравнить оператором -- в SQL это всегда неизвестность.
  if (value === null) {
    if (effective === "=") return [`(${column} IS NULL)`, []];
    if (effective === "!=") return [`(${column} IS NOT NULL)`, []];
  }
  const field = ctx.model.fields[index];
  return [`(${column} ${effective} ?)`, [{ value, cast: field.name }]];
}

function compileBare(node, ctx) {
  const side = ctx.resolve(node);
  if (side[0] === "val") {
    if (side[1] === UNSET) return [null, []];
    return [truthy(side[1]) ? "(1=1)" : "(1=0)", []];
  }
  const field = ctx.model.fields[side[2]];
  if (field.ftype !== "boolean") {
    throw new DomainError(
      `record.${field.name} is a ${field.ftype} field, so it cannot stand on ` +
      `its own as a condition. Compare it, e.g. record.${field.name} > 0.`);
  }
  return [`(${side[1]} = 1)`, []];
}

// --------------------------------------------------------------------------
// сортировка, поиск, сборка
// --------------------------------------------------------------------------
export function compileOrder(terms, ctx) {
  const parts = [];
  for (const term of terms || []) {
    let reference = term;
    let direction = "asc";
    if (term && typeof term === "object" && term.order !== null && term.order !== undefined) {
      reference = term.order;
      direction = term.dir || "asc";
    }
    const side = ctx.resolve(reference);
    if (side[0] !== "col") {
      throw new DomainError(`Cannot sort by ${canonical(reference)}: not a stored field.`);
    }
    parts.push(`${side[1]} ${direction === "desc" ? "DESC" : "ASC"}`);
  }
  // Устойчивый доводчик, в направлении последнего терма.
  const lastDesc = parts.length > 0 && parts[parts.length - 1].endsWith("DESC");
  parts.push(`${ctx.alias}."id" ${lastDesc ? "DESC" : "ASC"}`);
  return parts.join(", ");
}

export function compileSearch(fields, text, ctx) {
  const needle = (text || "").trim();
  if (!needle || !fields || !fields.length) return [null, []];
  const lowered = needle.toLowerCase();
  const sqls = [];
  const params = [];
  for (const field of fields) {
    const reference = typeof field === "string" ? { r: field } : field;
    const side = ctx.resolve(reference);
    if (side[0] !== "col") continue;
    sqls.push(`INSTR(pylower(${side[1]}), ?) > 0`);
    // Строке искомого `to_db` не нужен: это не значение колонки.
    params.push({ value: lowered, cast: null });
  }
  return sqls.length ? [`(${sqls.join(" OR ")})`, params] : [null, []];
}

/** `id` выносится вперёд намеренно: строки читаются по позиции. */
function storedColumns(model, alias) {
  const out = [];
  for (const wantId of [true, false]) {
    for (const field of model.fields) {
      if (!field.stored || (field.name === "id") !== wantId) continue;
      if (field.column) out.push(`${alias}."${field.column}"`);
    }
  }
  return out;
}

export function buildSelect(op, ctx) {
  if (!ctx.model) throw new DomainError("SELECT нужен документ модели");
  const take = [];
  let cols;
  if (Array.isArray(op.columns)) {
    const sqls = [];
    op.columns.forEach((item, i) => {
      sqls.push(typeof item === "string" ? item : "");
      take.push(["c", i]);
    });
    cols = sqls.join(", ");
  } else {
    cols = storedColumns(ctx.model, ctx.alias).join(", ");
  }

  let sql = `SELECT ${cols} FROM "${ctx.model.table}" ${ctx.alias}`;

  const clauses = [];
  if (Array.isArray(op.where)) {
    op.where.forEach((part, i) => {
      // `null` -- «условия нет», и это не пустая строка.
      if (typeof part === "string") { clauses.push(part); take.push(["w", i]); }
    });
  }
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  if (typeof op.order === "string" && op.order) sql += ` ORDER BY ${op.order}`;

  if (Number.isInteger(op.limit)) {
    sql += " LIMIT ?";
    take.push(["lit", op.limit]);
    // Ноль -- это «с начала», а не отдельная страница.
    if (Number.isInteger(op.offset) && op.offset !== 0) {
      sql += " OFFSET ?";
      take.push(["lit", op.offset]);
    }
  }
  return [sql, take];
}

// --------------------------------------------------------------------------
// разбор запроса и сборка ответа
// --------------------------------------------------------------------------
function compiled([sql, params]) {
  return {
    ok: {
      sql,
      params: params.map((p) => p.value),
      // Параллельно `params`: имя поля, чьим `to_db` хост обязан прогнать
      // значение, либо `null`.
      cast: params.map((p) => p.cast),
    },
  };
}

function one(op, ctx) {
  try {
    const job = op && typeof op === "object" ? op.do : null;
    if (job === "domain") return compiled(compileDomain(op.node ?? null, ctx));
    if (job === "order") {
      return { ok: { sql: compileOrder(Array.isArray(op.terms) ? op.terms : [], ctx) } };
    }
    if (job === "search") {
      return compiled(compileSearch(
        Array.isArray(op.fields) ? op.fields : [], op.text || "", ctx));
    }
    if (job === "select") {
      const [sql, take] = buildSelect(op, ctx);
      return { ok: { sql, take } };
    }
    throw new DomainError(
      `неизвестная работа ${typeof job === "string" ? JSON.stringify(job) : '"<нет>"'}`);
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    // Отказ одной работы -- её собственный кадр, а не отказ всего запроса.
    return { error: { code: "dsl", message: err.message } };
  }
}

/** Домен -> SQL: список работ. Подстановка вместо `core.js::compileQuery`. */
export function compileQuery(payload) {
  const request = JSON.parse(payload);
  const ctx = new Ctx(request.ctx);
  if (!Array.isArray(request.ops)) throw new Error("нужен ключ 'ops' со списком работ");
  return request.ops.map((op) => one(op, ctx));
}

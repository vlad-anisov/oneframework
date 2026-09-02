/**
 * Выражение как данные -> кусок параметризованного SQL.
 *
 * Копий две, и это осознанно. Раньше две копии были бедой: они **вычисляли**
 * ответ, и разойдясь, показывали разные экраны. Здесь они ответ не вычисляют, а
 * **печатают запрос**, а считает его SQLite -- одна и та же сборка 3.53 из
 * бандла на сервере, в браузере и на Android. Поэтому две равносильные записи
 * запроса дадут один ответ, и сверять надо смысл, а не буквы.
 *
 * Но одну вещь сверять надо именно побуквенно -- порядок доводов у
 * коммутативных операций. Планировщик сличает выражение запроса с выражением
 * индекса почти буквально, и `done + total` индекс использует, а `total + done`
 * уже нет. См. `shape` ниже.
 */

export const EXACT_NATIVE = "EXACT_NATIVE";
export const EXACT_ADAPTED = "EXACT_ADAPTED";
export const UNSUPPORTED = "UNSUPPORTED";

export const ROW_SCALAR = "ROW_SCALAR";
export const GROUPED = "GROUPED";
export const RELATIONAL = "RELATIONAL";
export const RECURSIVE = "RECURSIVE";

const RANK = { EXACT_NATIVE: 0, EXACT_ADAPTED: 1, UNSUPPORTED: 2 };
const FORM_RANK = { ROW_SCALAR: 0, GROUPED: 1, RELATIONAL: 2, RECURSIVE: 3 };

const COMMUTATIVE = new Set(["+", "*", "and", "or", "=", "!="]);
const ARITH = new Set(["+", "-", "*", "/", "%", "//", "**", "neg", "abs"]);
const CMP = new Set(["=", "!=", "<", "<=", ">", ">="]);

/** Операции без точного перевода -- и имя недостающего умения. */
/**
 * Слово питона -> текст SQL. Всё точное, без «примерно так же»: `startswith`
 * пишется срезом, а не `LIKE`, потому что `LIKE` считает `%` в образце
 * подстановкой и не различает регистр ASCII.
 */
const STRING_SQL = {
  lower: (a) => `pylower(${a[0]})`,
  upper: (a) => `pyupper(${a[0]})`,
  casefold: (a) => `pycasefold(${a[0]})`,
  length: (a) => `length(${a[0]})`,
  trim: (a) => `trim(${a.join(", ")})`,
  ltrim: (a) => `ltrim(${a.join(", ")})`,
  rtrim: (a) => `rtrim(${a.join(", ")})`,
  replace: (a) => `replace(${a[0]}, ${a[1]}, ${a[2]})`,
  startswith: (a) => `(substr(${a[0]}, 1, length(${a[1]})) = ${a[1]})`,
  endswith: (a) => `(length(${a[1]}) = 0 OR substr(${a[0]}, -length(${a[1]})) = ${a[1]})`,
  text: (a) => `CAST(${a[0]} AS TEXT)`,
  integer: (a) => `CAST(${a[0]} AS INTEGER)`,
  real: (a) => `CAST(${a[0]} AS REAL)`,
};

// Отказы по имени. Регистр отсюда ушёл: его знает питон, и обе стороны
// ставят его своей функцией -- как `round` и деление на ноль.
const MISSING = {
  add_workdays: "workday_calendar",
};

export class DslError extends Error {}

export class Compiled {
  constructor(sql, params = {}, status = EXACT_NATIVE, form = ROW_SCALAR,
              missing = [], reads = []) {
    this.sql = sql;
    this.params = { ...params };
    this.status = status;
    this.form = form;
    this.missing = [...missing];
    this.reads = [...reads];
  }

  /** Собрать узел из детей: худший исход, тяжелейшая форма, всё чтение. */
  merge(others, sql, status = null) {
    const parts = [this, ...others];
    let worst = parts.reduce((a, p) => (RANK[p.status] > RANK[a] ? p.status : a), EXACT_NATIVE);
    if (status !== null && RANK[status] > RANK[worst]) worst = status;
    const params = {};
    for (const p of parts) Object.assign(params, p.params);
    const form = parts.reduce((a, p) => (FORM_RANK[p.form] > FORM_RANK[a] ? p.form : a), ROW_SCALAR);
    const missing = [...new Set(parts.flatMap((p) => p.missing))].sort();
    const reads = [...new Set(parts.flatMap((p) => p.reads))].sort();
    return new Compiled(sql, params, worst, form, missing, reads);
  }

  withMissing(name) {
    return new Compiled(this.sql, this.params, UNSUPPORTED, this.form,
                        [...new Set([...this.missing, name])].sort(), this.reads);
  }
}

// ==========================================================================
// каноническая форма
// ==========================================================================
export function canonical(node) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
  if ("op" in node && COMMUTATIVE.has(node.op) && "args" in node) {
    const args = node.args.map(canonical);
    args.sort((a, b) => (shape(a) < shape(b) ? -1 : shape(a) > shape(b) ? 1 : 0));
    return { ...node, args };
  }
  const out = { ...node };
  if ("args" in node) out.args = node.args.map(canonical);
  for (const key of ["of", "where"]) {
    if (node[key] !== undefined && node[key] !== null) out[key] = canonical(node[key]);
  }
  return out;
}

/**
 * Ключ упорядочивания -- **дословно тот же, что в питоне**, и это условие, а не
 * пожелание. `String(node)` или `JSON.stringify` целиком дали бы другой порядок
 * ключей, и два компилятора напечатали бы одно выражение по-разному: ответы
 * остались бы верными, а индекс по выражению перестал бы применяться на одной
 * из сторон. Расхождение молчаливое, поэтому запись здесь повторена вручную.
 *
 * Ключи объектов у нас -- имена операций и полей, то есть ASCII; на них порядок
 * кодовых точек (питон) и кодовых единиц UTF-16 (JS) совпадает.
 */
export function shape(node) {
  if (node === null) return "null";
  if (Array.isArray(node)) return "[" + node.map(shape).join(",") + "]";
  if (typeof node === "object") {
    const keys = Object.keys(node).sort();
    return "{" + keys.map((k) => `${shape(k)}:${shape(node[k])}`).join(",") + "}";
  }
  if (typeof node === "boolean") return node ? "true" : "false";
  if (typeof node === "string") return JSON.stringify(node);
  if (typeof node === "number") return Number.isInteger(node) ? String(node) : String(node);
  throw new DslError(`нельзя упорядочить: ${node}`);
}

// ==========================================================================
// перевод
// ==========================================================================
export function compileExpr(node, { table = "t", nullable = new Set(), depth = 0 } = {}) {
  if (depth > 64) throw new DslError("выражение слишком глубокое");
  const n = depth === 0 ? canonical(node) : node;

  if (n === null || typeof n !== "object" || Array.isArray(n)) return literal(n);
  // Точка через связь: значение соседней таблицы по ключу. Имя таблицы
  // проставлено на сборке, поэтому схема компилятору не нужна.
  if ("lookup" in n) {
    const key = compileExpr(n.key, { table, nullable, depth: depth + 1 });
    const alias = `l${depth}`;
    const inner = compileExpr(n.get, { table: alias, nullable, depth: depth + 1 });
    const sql = `(SELECT ${inner.sql} FROM "${n.lookup}" "${alias}" `
              + `WHERE "${alias}"."id" = ${key.sql})`;
    return key.merge([inner], sql, EXACT_ADAPTED);
  }
  // Шаблон -- та же склейка, что и `concat`: обе записи языка ведут в один SQL.
  if ("fmt" in n) return compileExpr({ op: "concat", args: n.fmt }, { table, nullable, depth });
  if ("const" in n) return literal(n.const);
  if ("field" in n) return new Compiled(`"${n.t || table}"."${n.field}"`, {}, EXACT_NATIVE, ROW_SCALAR, [], [n.field]);
  // Та же ссылка, что и в доменах: двух записей для «поле записи» язык не
  // заводит -- формула и условие пишутся одинаково.
  //
  // `t` -- имя таблицы, если ссылка **не** отсюда: так помечается поле самой
  // записи внутри подзапроса по связи, иначе оно читалось бы у связанной.
  if ("r" in n && !("op" in n)) {
    return new Compiled(`"${n.t || table}"."${n.r}"`, {}, EXACT_NATIVE, ROW_SCALAR, [], [n.r]);
  }
  if ("param" in n) return new Compiled(`:${n.param}`, { [n.param]: n.value ?? null });
  if ("agg" in n) return aggregate(n, table, nullable, depth);

  let op = n.op;
  if (op === undefined) throw new DslError(`узел без операции: ${JSON.stringify(n)}`);

  // Булевы связки и отрицание приходят в **доменной** записи (`&`/`|` со
  // списком `p`, `!` с `e`): формула и условие пишутся на одном языке.
  let effective = op;
  let args = n.args || [];
  if (op === "&" || op === "|") { effective = op === "&" ? "and" : "or"; args = n.p || []; }
  else if (op === "!") { effective = "not"; args = [n.e]; }
  // Сравнение -- тоже доменной записью: `l` и `r` вместо `args`. Без этого
  // `filtered(lambda t: t.price > 100)` падало бы на пустом списке доводов.
  else if (op === "null") { effective = "is_null"; args = [n.e]; }
  else if (CMP.has(op) && "l" in n) { args = [n.l, n.r]; }
  const kids = args.map((a) => compileExpr(a, { table, nullable, depth: depth + 1 }));

  op = effective;
  if (op in MISSING) {
    const base = kids.length ? kids[0] : new Compiled("NULL");
    return base.merge(kids.slice(1), "NULL", UNSUPPORTED).withMissing(MISSING[op]);
  }
  if (op === "round") return kids[0].merge([], `oneframework_round(${kids[0].sql})`);
  if (op in STRING_SQL) {
    return kids[0].merge(kids.slice(1), STRING_SQL[op](kids.map((k) => k.sql)));
  }
  if (ARITH.has(op)) return arith(op, n, kids);
  if (CMP.has(op)) return kids[0].merge([kids[1]], `(${kids[0].sql} ${sqlCmp(op)} ${kids[1].sql})`);
  if (op === "and" || op === "or") {
    const joiner = op === "and" ? " AND " : " OR ";
    const t = kids.map(truthy);
    return t[0].merge(t.slice(1), "(" + t.map((k) => k.sql).join(joiner) + ")");
  }
  if (op === "not") {
    const inner = truthy(kids[0]);
    return inner.merge([], `(NOT ${inner.sql})`);
  }
  if (op === "is_null") return kids[0].merge([], `(${kids[0].sql} IS NULL)`);
  if (op === "truthy") return truthy(kids[0]);
  if (op === "concat") {
    // `'a' || NULL` даёт NULL -- шаблон обязан склеиваться, а не исчезать.
    const safe = kids.map((k) => new Compiled(`coalesce(${k.sql}, '')`, k.params,
                                              EXACT_ADAPTED, k.form, k.missing, k.reads));
    return safe[0].merge(safe.slice(1), "(" + safe.map((k) => k.sql).join(" || ") + ")",
                         EXACT_ADAPTED);
  }
  if (op === "if") {
    const cond = truthy(kids[0]);
    return cond.merge([kids[1], kids[2]],
      `(CASE WHEN ${cond.sql} THEN ${kids[1].sql} ELSE ${kids[2].sql} END)`);
  }
  throw new DslError(`неизвестная операция: ${op}`);
}

function literal(value) {
  if (value === null || value === undefined) return new Compiled("NULL");
  if (typeof value === "boolean") return new Compiled(value ? "1" : "0");
  if (typeof value === "number") return new Compiled(String(value));
  if (typeof value === "string") return new Compiled("'" + value.replace(/'/g, "''") + "'");
  throw new DslError(`нельзя записать литералом: ${value}`);
}

const sqlCmp = (op) => (op === "!=" ? "<>" : op);

/**
 * Истинность **по правилам питона**, а не по правилам SQL. Расхождений два, и
 * оба молчаливые: `NULL` в SQL -- третье состояние, а на экране третьего нет;
 * и `CASE WHEN 'Дом'` в SQLite приводит текст к числу и даёт ложь, тогда как
 * в питоне непустая строка истинна. Двойной `nullif` сводит ноль и пустую
 * строку к `NULL`, печатая само выражение один раз.
 */
function truthy(kid) {
  // Приведение не чинит отказ: исход остаётся худшим из двух.
  const status = RANK[kid.status] > RANK[EXACT_ADAPTED] ? kid.status : EXACT_ADAPTED;
  return new Compiled(`coalesce(nullif(nullif(${kid.sql}, 0), ''), 0) <> 0`,
                      kid.params, status, kid.form, kid.missing, kid.reads);
}

/**
 * Арифметика с объявленным поведением на краях. Деление требует явной ветки
 * `on_zero`: у SQLite `1/0` -- это `NULL`, и принять это молча значило бы
 * сделать чужую случайность своим правилом.
 */
function arith(op, node, kids) {
  const [left, right] = kids;
  if (op === "neg") return left.merge([], `(-${left.sql})`);
  if (op === "abs") return left.merge([], `abs(${left.sql})`);
  if (op === "**") return left.merge([right], `pow(${left.sql}, ${right.sql})`);
  if (op === "/" || op === "%" || op === "//") {
    // Три деления, и все три отказывают на нуле, как `ZeroDivisionError`.
    // `//` и `%` у питона округляют **вниз**, а не к нулю: расхождение видно
    // только на отрицательных, то есть там, где его не проверяют.
    const body = {
      "/": `CAST(${left.sql} AS REAL) / ${right.sql}`,
      "//": `CAST(floor(CAST(${left.sql} AS REAL) / ${right.sql}) AS INTEGER)`,
      "%": `((${left.sql} % ${right.sql}) + ${right.sql}) % ${right.sql}`,
    }[op];
    const sql = `(CASE WHEN coalesce(${right.sql}, 0) = 0 ` +
                `THEN oneframework_zero_division() ELSE ${body} END)`;
    return left.merge([right], sql, EXACT_ADAPTED);
  }
  return left.merge([right], `(${left.sql} ${op} ${right.sql})`);
}

/**
 * Агрегат здесь только **объявляется**: считает его слитая выборка
 * (`plan.js`). Печатать его коррелированным подзапросом было бы верно
 * семантически и негодно физически -- замерено, 126 мс против 8,7 на 30 000.
 */
function aggregate(node, table, nullable, depth) {
  const kind = node.agg;
  if (!["count", "sum", "exists", "max", "min"].includes(kind)) {
    throw new DslError(`неизвестный агрегат: ${kind}`);
  }
  const inner = node.where !== undefined && node.where !== null
    ? compileExpr(node.where, { table, nullable, depth: depth + 1 }) : null;
  const of = node.of !== undefined && node.of !== null
    ? compileExpr(node.of, { table, nullable, depth: depth + 1 }) : null;
  const empty = node.on_empty !== undefined && node.on_empty !== null
    ? compileExpr(node.on_empty, { table, nullable, depth: depth + 1 }) : null;
  const parts = [inner, of, empty].filter(Boolean);
  const base = new Compiled("", {}, EXACT_NATIVE, GROUPED);
  return base.merge(parts, aggSql(kind, of, inner, empty));
}

/**
 * Пустой набор разбирается по-питоновски: `sum([])` -- ноль, а не «неизвестно»,
 * тогда как SQL отдал бы NULL. У `min`/`max` умолчания нет и в питоне; писаное
 * `min(..., default=0)` приезжает сюда как `on_empty`.
 */
export function aggSql(kind, of, where, empty) {
  const head = kind === "count" || kind === "exists"
    ? "count(*)"
    : `${kind}(${of ? of.sql : "*"})`;
  const sql = head + (where !== null && where !== undefined ? ` FILTER (WHERE ${where.sql})` : "");
  if (empty !== null && empty !== undefined) return `coalesce(${sql}, ${empty.sql})`;
  return kind === "sum" ? `coalesce(${sql}, 0)` : sql;
}

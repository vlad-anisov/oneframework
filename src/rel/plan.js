/**
 * Выборка целиком: экран, правило, изменение набора.
 *
 * Единица компиляции -- не поле. Замерено: 25 списков по пять показателей на
 * 30 000 задач -- 126,04 мс отдельными коррелированными подзапросами против
 * 8,69 мс одной слитой выборкой.
 *
 * Путь доступа здесь только **требуется**, а не создаётся: `CREATE INDEX` во
 * время отрисовки экрана -- это не оптимизация, а авария.
 */

import {
  Compiled, DslError, EXACT_NATIVE, GROUPED, RECURSIVE, UNSUPPORTED, compileExpr,
} from "./compile.js";

export class AccessPath {
  constructor(table, prefix, reason, consumer) {
    this.table = table;
    this.prefix = [...prefix];
    this.reason = reason;
    this.consumer = consumer;
  }

  /** Покрыто ли требование хоть одним из имеющихся индексов. */
  satisfiedBy(indexes) {
    return indexes.some((cols) =>
      this.prefix.every((c, i) => cols[i] === c));
  }

  asJson() {
    return { table: this.table, prefix: [...this.prefix],
             reason: this.reason, consumer: this.consumer };
  }
}

export class Screen {
  constructor(sql, params, fields, access, unsupported) {
    this.sql = sql;
    this.params = params;
    this.fields = fields;          // имя -> [исход, форма]
    this.access = access;
    this.unsupported = unsupported; // имя -> недостающие умения
  }
}

/**
 * Изменение набора, который определило правило. Единственный примитив записи:
 * он не знает ни про потомков, ни про графы.
 */
export class Mutation {
  constructor(table, source, assignments) {
    this.table = table;
    this.source = source;
    this.assignments = { ...assignments };
  }

  compile(ruleSql = null, key = "id") {
    const sets = [];
    const params = {};
    for (const col of Object.keys(this.assignments).sort()) {
      const piece = compileExpr(this.assignments[col]);
      if (piece.status === UNSUPPORTED) {
        throw new DslError(`нельзя записать «${col}»: ${piece.missing.join(", ")}`);
      }
      sets.push(`"${col}" = ${piece.sql}`);
      Object.assign(params, piece.params);
    }
    const head = ruleSql ? ruleSql + "\n" : "";
    const sql = `${head}UPDATE "${this.table}" SET ${sets.join(", ")} ` +
                `WHERE "${key}" IN (SELECT "${key}" FROM ${this.source})`;
    return { sql, params };
  }
}

// ==========================================================================
// экран
// ==========================================================================
export function compileScreen(table, {
  key = "id", rowFields = {}, aggregates = [], nullable = new Set(),
  consumer = "screen",
} = {}) {
  const fields = {};
  const unsupported = {};
  const access = [];
  const params = {};
  const columns = [`"${table}".*`];

  for (const name of Object.keys(rowFields).sort()) {
    const piece = compileExpr(rowFields[name], { table, nullable });
    fields[name] = [piece.status, piece.form];
    Object.assign(params, piece.params);
    if (piece.status === UNSUPPORTED) {
      unsupported[name] = piece.missing;
      // Форма кадра не зависит от того, что удалось перевести.
      columns.push(`NULL AS "${name}"`);
    } else {
      columns.push(`${piece.sql} AS "${name}"`);
    }
  }

  const ctes = [];
  const joins = [];
  for (const [relKey, group] of byRelation(aggregates)) {
    const [model, via] = relKey;
    const alias = `agg__${model}__${via}`;
    const selected = [];
    for (const spec of group) {
      const piece = aggPiece(spec, model);
      fields[spec.name] = [piece.status, GROUPED];
      Object.assign(params, piece.params);
      if (piece.status === UNSUPPORTED) {
        unsupported[spec.name] = piece.missing;
        continue;
      }
      selected.push(`${piece.sql} AS "${spec.name}"`);
    }
    if (!selected.length) {
      for (const spec of group) columns.push(`NULL AS "${spec.name}"`);
      continue;
    }
    ctes.push(`${alias} AS (SELECT "${via}" AS __key, ${selected.join(", ")}` +
              ` FROM "${model}" GROUP BY "${via}")`);
    joins.push(`LEFT JOIN ${alias} ON ${alias}.__key = "${table}"."${key}"`);
    for (const spec of group) {
      if (spec.name in unsupported) {
        columns.push(`NULL AS "${spec.name}"`);
      } else {
        columns.push(`coalesce(${alias}."${spec.name}", ${defaultOf(spec)}) AS "${spec.name}"`);
      }
    }
    access.push(new AccessPath(model, [via], "group_by", `${consumer}.${alias}`));
  }

  const head = ctes.length ? "WITH " + ctes.join(",\n     ") + "\n" : "";
  const sql = head + "SELECT " + columns.join(", ") + `\n  FROM "${table}"` +
              (joins.length ? "\n  " + joins.join("\n  ") : "");
  return new Screen(sql, params, fields, access, unsupported);
}

/** Группировка по паре (модель, связь), с тем же порядком, что в питоне. */
function byRelation(aggregates) {
  const out = new Map();
  for (const spec of aggregates) {
    const k = `${spec.model}\0${spec.via}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(spec);
  }
  return [...out.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, group]) => [k.split("\0"), group]);
}

/**
 * Чем заполнить показатель, когда у строки не нашлось ни одной записи. Для
 * счётчиков это ноль молча; для выражения над агрегатами умолчание обязано
 * быть объявлено -- правильный ответ на пустом наборе знает только автор
 * формулы, и выдуманный ноль тут хуже честного `NULL`.
 */
function defaultOf(spec) {
  if (spec.default !== undefined && spec.default !== null) {
    return compileExpr(spec.default).sql;
  }
  return ["count", "exists", "sum"].includes(spec.agg) ? "0" : "NULL";
}

/**
 * Показатель -- либо один агрегат, либо **выражение над агрегатами**. Второе
 * нужно чаще, чем кажется: «процент готовности» -- арифметика над двумя
 * счётчиками, и считать её снаружи значило бы вернуть поштучный путь.
 */
function aggPiece(spec, model) {
  if (spec.expr !== undefined && spec.expr !== null) {
    return compileExpr(spec.expr, { table: model });
  }
  const node = { agg: spec.agg };
  if (spec.where !== undefined && spec.where !== null) node.where = spec.where;
  if (spec.of !== undefined && spec.of !== null) node.of = spec.of;
  return compileExpr(node, { table: model });
}

// ==========================================================================
// правило
// ==========================================================================
/**
 * Линейное рекурсивное правило -> один `WITH RECURSIVE`.
 *
 * Неподвижная точка считается только по ключевым колонкам. Замерено на кольце
 * `1→2→3→4→1`: `UNION` по одному ключу завершается за сотые доли миллисекунды,
 * а с колонкой глубины или пути -- **не завершается вовсе**, потому что каждая
 * итерация даёт новую строку.
 */
export function compileRule(rule) {
  const name = rule.name;
  const table = rule.table;
  const key = rule.id || "id";
  const via = rule.via;
  const extra = (rule.columns || []).filter((c) => c !== key);
  if (extra.length && !("max_depth" in rule)) {
    throw new DslError(
      `правило «${name}»: колонки ${extra} меняются на каждом шаге, и с ними ` +
      "рекурсия на кольце не завершится. Нужен явный «max_depth» либо " +
      "вычисление этих колонок вне рекурсии");
  }
  const seed = compileExpr(rule.seed);
  const params = { ...seed.params };
  const where = rule.where ?? null;
  let stepCond = "";
  if (where !== null) {
    const piece = compileExpr(where, { table: "t" });
    if (piece.status === UNSUPPORTED) {
      throw new DslError(
        `правило «${name}»: условие шага непереводимо (${piece.missing.join(", ")})`);
    }
    Object.assign(params, piece.params);
    stepCond = ` AND ${piece.sql}`;
  }

  let cols, seedSel, childSel, stepSel, guard;
  if ("max_depth" in rule) {
    cols = `${key}, __depth`;
    stepSel = `t."${key}", d.__depth + 1`;
    guard = ` AND d.__depth < ${parseInt(rule.max_depth, 10)}`;
    seedSel = `${seed.sql}, 0`;
    childSel = `"${key}", 0`;
  } else {
    cols = key;
    stepSel = `t."${key}"`;
    guard = "";
    seedSel = seed.sql;
    childSel = `"${key}"`;
  }

  let start;
  if (rule.include_seed) {
    // Корень входит в набор сам, дети находятся шагом: у `d` уже есть с чем
    // соединяться. Это и есть форма «задача вместе с поддеревом».
    start = `  SELECT ${seedSel}\n`;
  } else {
    const seedWhere = where === null ? "" : ` AND ${compileExpr(where, { table }).sql}`;
    start = `  SELECT ${childSel} FROM "${table}" WHERE "${via}" = ${seed.sql}${seedWhere}\n`;
  }

  const sql =
    `WITH RECURSIVE ${name}(${cols}) AS (\n` +
    start +
    `  UNION\n` +
    `  SELECT ${stepSel} FROM "${table}" t JOIN ${name} d ON t."${via}" = d.${key}` +
    `${stepCond}${guard}\n` +
    `)`;
  const piece = new Compiled(sql, params, EXACT_NATIVE, RECURSIVE, [], [via, key]);
  const access = [new AccessPath(table, [via], "recursive_step", `rule.${name}`)];
  return { piece, access };
}

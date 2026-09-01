/**
 * Вычисляемое поле как объявление -> колонка выборки. Близнец
 * Единственная реализация: питоновская удалена 21.08.2026.
 *
 * Раньше `compute=` держал только имя действия, и рантайм звал модуль **по
 * одной записи**: 194,8 мс на список из трёхсот. Теперь объявление
 * компилируется в колонку, и значение приезжает вместе со строкой.
 *
 * Имя действия остаётся рабочим: то, что в SQL не выражается (арифметика
 * календаря), обязано иметь дорогу. Разница видна по типу: строка -- действие,
 * объект -- объявление.
 *
 * Параметров у объявления пока не бывает: литералы печатаются в текст, а всё,
 * что требует значения снаружи, отклоняется по имени.
 */

import { EXACT_ADAPTED, GROUPED, UNSUPPORTED, Compiled, compileExpr } from "./compile.js";
import { AccessPath } from "./plan.js";

export function declarationOf(field) {
  const decl = field && field.compute;
  return decl && typeof decl === "object" ? decl : null;
}

/** Вычисляемые поля модели -> `{columns, access, refused}`. */
/**
 * Имена моделей, от которых зависят вычисляемые поля этой модели.
 *
 * Нужны для подписки экрана: готовность списка меняется от правки **задачи**, а
 * экран подписан на списки. Без этой подписки число осталось бы вчерашним --
 * ни ошибки, ни следа, просто неверная цифра.
 */
export function modelsRead(model) {
  const names = new Set();
  for (const field of Object.values(model.fields || {})) {
    const decl = declarationOf(field);
    if (!decl) continue;
    for (const agg of aggregates(decl, [])) if (agg.model) names.add(agg.model);
    if (decl.related && decl.related.model) names.add(decl.related.model);
  }
  return names;
}

/** Все агрегаты по связанной модели внутри выражения. */
function aggregates(node, found) {
  if (Array.isArray(node)) { for (const x of node) aggregates(x, found); return found; }
  if (node && typeof node === "object") {
    if ("agg" in node && node.model) found.push(node);
    for (const v of Object.values(node)) aggregates(v, found);
  }
  return found;
}

/** Изнутри подзапроса агрегат теряет модель и связь: она уже в `WHERE`. */
/**
 * Ссылка вне агрегата говорит о самой записи: внутри подзапроса её надо
 * пометить чужим псевдонимом, иначе поле прочиталось бы у связанной модели.
 */
function innerOf(node, outer) {
  if (Array.isArray(node)) return node.map((x) => innerOf(x, outer));
  if (node && typeof node === "object") {
    if ("r" in node && !("op" in node) && outer) return { ...node, t: outer };
    if ("agg" in node && node.model) {
      const out = { agg: node.agg };
      if (node.domain !== undefined && node.domain !== null) out.where = node.domain;
      // Колонка суммы читается изнутри подзапроса, где связь уже в `WHERE`.
      if (node.of !== undefined && node.of !== null) out.of = node.of;
      if (node.on_empty !== undefined && node.on_empty !== null) out.on_empty = node.on_empty;
      return out;
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, innerOf(v, outer)]));
  }
  return node;
}

/** Выражение над связанной моделью -> один коррелированный подзапрос. */
function overRelation(decl, aggs, model, alias, models) {
  const pairs = [...new Set(aggs.map((a) => `${a.model} ${a.via || ""}`))];
  if (pairs.length !== 1) {
    return { piece: new Compiled("NULL", {}, UNSUPPORTED, GROUPED, ["mixed_relations"], []), path: null };
  }
  const [modelName, via] = pairs[0].split(" ");
  if (!via) {
    return { piece: new Compiled("NULL", {}, UNSUPPORTED, GROUPED, ["aggregate_without_via"], []), path: null };
  }
  const other = resolve(modelName, models);
  const column = viaColumn(other, via);
  const head = compileExpr(innerOf(decl, alias), { table: "a" });
  if (head.status === UNSUPPORTED || Object.keys(head.params).length) return { piece: head, path: null };
  const sub = `(SELECT ${head.sql} FROM "${other.table}" a WHERE a."${column}" = ${alias}."id")`;
  return {
    piece: new Compiled(sub, {}, EXACT_ADAPTED, GROUPED),
    path: new AccessPath(other.table, [column], "related_aggregate", `${model.name}.${modelName}`),
  };
}

export function computedColumns(model, alias = "t", models = null) {
  const columns = [];
  const access = [];
  const refused = {};
  for (const field of Object.values(model.fields || {})) {
    const decl = declarationOf(field);
    if (!decl) continue;
    let piece;
    let path = null;
    const aggs = aggregates(decl, []);
    if (aggs.length) {
      const got = overRelation(decl, aggs, model, alias, models);
      piece = got.piece; path = got.path;
    } else if ("related" in decl) {
      const got = related(decl, model, alias, models);
      piece = got.piece; path = got.path;
    } else {
      piece = compileExpr(decl, { table: alias });
    }
    if (Object.keys(piece.params).length) {
      piece = new Compiled("NULL", {}, UNSUPPORTED, piece.form,
                           ["parameters_not_wired"], piece.reads);
    }
    if (piece.status === UNSUPPORTED) {
      // Отказ виден колонкой NULL: экран не рассыпается из-за одной формулы.
      refused[field.name] = piece.missing;
      columns.push([field.name, "NULL"]);
      continue;
    }
    columns.push([field.name, piece.sql]);
    if (path) access.push(path);
  }
  return { columns, access, refused };
}

/** Показатель по связанной модели -> коррелированный подзапрос. */
function related(decl, model, alias, models) {
  const spec = decl.related;
  const other = resolve(spec.model, models);
  const column = viaColumn(other, spec.via);
  const inner = "a";
  const parts = [`${inner}."${column}" = ${alias}."id"`];

  if (spec.where !== undefined && spec.where !== null) {
    const piece = compileExpr(spec.where, { table: inner });
    if (piece.status === UNSUPPORTED || Object.keys(piece.params).length) return { piece, path: null };
    parts.push(piece.sql);
  }

  let kind = spec.agg || "count";
  let head;
  if (spec.expr !== undefined && spec.expr !== null) {
    // Показатель бывает выражением над агрегатами: «процент готовности» --
    // арифметика над двумя счётчиками.
    const hp = compileExpr(spec.expr, { table: inner });
    if (hp.status === UNSUPPORTED || Object.keys(hp.params).length) return { piece: hp, path: null };
    head = hp.sql;
    kind = spec.agg || "expr";
  } else if (kind === "count" || kind === "exists") {
    head = "count(*)";
  } else {
    const of = compileExpr(spec.of, { table: inner });
    if (of.status === UNSUPPORTED || Object.keys(of.params).length) return { piece: of, path: null };
    head = `${kind}(${of.sql})`;
  }

  let sub = `(SELECT ${head} FROM "${other.table}" ${inner} WHERE ${parts.join(" AND ")})`;
  if (spec.on_empty !== undefined && spec.on_empty !== null) {
    // «Пустой список готов на ноль процентов» -- решение автора формулы.
    sub = `coalesce(${sub}, ${compileExpr(spec.on_empty).sql})`;
  } else if (["count", "exists", "sum"].includes(kind)) {
    sub = `coalesce(${sub}, 0)`;
  }
  if (kind === "exists") sub = `(${sub} > 0)`;

  return {
    piece: new Compiled(sub, {}, EXACT_ADAPTED, GROUPED),
    path: new AccessPath(other.table, [column], "related_aggregate",
                         `${model.name}.${spec.model}`),
  };
}

function resolve(name, models) {
  const found = models && (models[name] || Object.values(models).find((m) => m.name === name));
  if (!found) throw new Error(`нет такой модели: ${name}`);
  return found;
}

function viaColumn(other, via) {
  const field = (other.fields || {})[via];
  if (!field) throw new Error(`нет поля «${via}» у модели ${other.name}`);
  return field.column;
}

/**
 * Разворот: документ плюс данные -- дерево.
 *
 * Разница с питоном только в том, из чего сделан узел: там объект, здесь
 * обычный JSON, приехавший из таблицы определений. Правила те же, и они обязаны
 * быть теми же -- иначе один документ на двух машинах даст разные экраны, а это
 * не падение, а просто другой экран, которого никто не заметит.
 *
 * Граница проходит по одному правилу, и оно тут единственное непустое решение:
 *
 *     **значение агрегата -- это данные, а не шаблон.**
 *
 * `Count(Task, ...)` в документе остаётся вопросом. Запеки его туда числом -- и
 * документ станет протухать от каждой правки любой задачи, то есть перестанет
 * быть тем, что имеет смысл держать отдельно и слать по сети.
 *
 * Кто отвечает: объект *data* с двумя методами -- `records(model, domain, order)`
 * и `aggregate(kind, model, domain)`. Их даёт рантайм, потому что база только у
 * него; здесь про базу не знают ничего.
 */

import { evaluate, UNSET } from "../expr.js";

/** Типы узлов документа. Всё остальное, что выглядит словарём, -- не структура. */
const NODE_TYPES = new Set([
  "view", "repeat", "row", "col", "menu", "section", "group", "accordion",
  "pill", "text", "icon", "tab", "tabs", "field", "button", "list", "search",
  "filter", "sort",
]);

const isNode = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  typeof v.type === "string" && NODE_TYPES.has(v.type);

/** Выражение в JSON: см. oneframework/model/exprjson.py. */
const isExpr = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  ("op" in v || "r" in v || "v" in v || "i" in v || "fmt" in v ||
   "agg" in v || "order" in v || "unset" in v);

/** Ссылка, на которую здесь ответа нет: её ответит строка или экран. */
function hasRefs(value) {
  if (Array.isArray(value)) return value.some(hasRefs);
  if (value === null || typeof value !== "object") return false;
  if ("r" in value || "v" in value) return true;
  return Object.values(value).some(hasRefs);
}

/**
 * Развернуть дерево *root* на данных. Меняет его на месте и возвращает.
 * На месте -- потому что документ перед этим скопирован, и копия принадлежит
 * одному этому кадру.
 */
export function expand(root, data) {
  root.children = children(root.children || [], data, null);
  return root;
}

// --------------------------------------------------------------------------
// структура
// --------------------------------------------------------------------------
function children(nodes, data, scope) {
  const out = [];
  for (const node of nodes) {
    if (node && node.type === "repeat") {
      out.push(...repeat(node, data, scope));
      continue;
    }
    const drawn = one(node, data, scope);
    if (drawn !== null) out.push(drawn);
  }
  return out;
}

/** Тело повторителя, по копии на запись. */
function repeat(node, data, scope) {
  if (!resolve(node, data, scope)) return [];
  const out = [];
  for (const row of data.records(node.model, node.domain ?? null, node.order ?? null)) {
    for (const child of node.children || []) {
      const drawn = one(clone(child, row.id), data, row);
      if (drawn !== null) out.push(drawn);
    }
  }
  return out;
}

/**
 * Правила показа, которые в питоне живут в `ir()`.
 *
 * Там `ir()` вызывается **дважды**: один раз чтобы получить документ, и второй
 * раз уже после разворота -- и на втором проходе применяются правила, которых в
 * документе не видно вовсе. Здесь второго прохода нет: документ разворачивается
 * на месте. Значит эти правила надо применить руками, иначе они просто не
 * случатся -- молча, и разойдутся ровно те два места, где `ir()` смотрит на
 * *ответ*, а не на объявление.
 *
 * Оба случая поймал перекрёстный тест, а не чтение кода, и это про него всё
 * сказано: расхождение здесь -- не исключение, а другой экран.
 */
function present(node) {
  if (node.type === "pill") {
    const v = node.value;
    // Нечего считать -- нечего показывать: нулевой значок на вкладке говорит
    // «пусто», и обе платформы его не рисуют вовсе.
    node.value =
      v === null || v === undefined || v === false || v === 0 ? null : String(v);
  } else if (node.type === "accordion" && node.visible === true) {
    // Условие, ответившее «да», перестаёт быть условием: в документе ключа нет,
    // когда узел виден всегда, и развёрнутое дерево обязано выглядеть так же.
    delete node.visible;
  }
  return node;
}

/** Один узел и всё под ним. `null` -- узла на экране нет. */
function one(node, data, scope) {
  if (!resolve(node, data, scope)) return null;
  present(node);
  if (node.type === "tab") {
    node.title = children(node.title || [], data, scope);
    if (node.fab) node.fab = one(node.fab, data, scope);
  } else if (node.type === "list") {
    // Ни один из них не ребёнок списка: колонки, меню и поиск висят на нём
    // сбоку, но выражения в них те же самые и разворачиваются так же.
    if (node.column_nodes) {
      node.column_nodes = children(node.column_nodes, data, scope);
    }
    if (node.menu) node.menu = one(node.menu, data, scope);
    if (node.search) one(node.search, data, scope);
  } else if (node.type === "search") {
    for (const child of [...(node.filters || []), ...(node.sorts || [])]) {
      resolve(child, data, scope);
    }
  }
  if (Array.isArray(node.children)) {
    node.children = children(node.children, data, scope);
  }
  return node;
}

// --------------------------------------------------------------------------
// копия
// --------------------------------------------------------------------------
/**
 * Копия узла с собственными номерами.
 *
 * Номер узла -- это место в дереве, и по нему рантайм узнаёт список между
 * перерисовками: его фильтр, сортировку и загруженное окно. Значит у копий
 * номера обязаны различаться и обязаны быть одними и теми же на каждом кадре.
 * Отсюда номер записи в суффиксе: вкладка списка остаётся собой, пока
 * существует список.
 */
function clone(node, suffix) {
  const copy = structuredClone(node);
  // Обойти всё поддерево, включая висящее сбоку от списка: в JSON оно лежит
  // теми же ключами, поэтому один общий обход накрывает ровно тот же набор,
  // что два разных обхода в питоне.
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (isNode(value) && typeof value.id === "string") {
      value.id = `${value.id}#${suffix}`;
    }
    for (const v of Object.values(value)) visit(v);
  };
  visit(copy);
  return copy;
}

// --------------------------------------------------------------------------
// выражения
// --------------------------------------------------------------------------
/**
 * Ответить на всё, на что в этом узле уже есть ответ.
 *
 * Возвращает, рисуется ли узел. Условие, на которое ответили «нет», убирает
 * узел из дерева, а не рисует его скрытым: ровно это делал питоновский `if`,
 * который здесь и заменяется. Написанное руками `visible=False` -- другое дело:
 * поле объявлено и не нарисовано, и список читает его объявление.
 */
function resolve(node, data, scope) {
  if (node === null || typeof node !== "object") return true;
  let drawn = true;
  for (const key of Object.keys(node)) {
    if (key === "children" || key === "type" || key === "id") continue;
    const value = node[key];
    let next = valueOf(value, data, scope);
    if (key === "visible" || key === "enabled") {
      const settled = settle(next);
      if (key === "visible" && typeof value !== "boolean" && settled === false) {
        drawn = false;
      }
      next = settled;
    }
    if (next !== value) node[key] = next;
  }
  return drawn;
}

/**
 * Условие, на которое данные ответили, становится «да» или «нет».
 * Оставшееся ссылается на запись или на состояние экрана -- на них отвечают при
 * отрисовке строки, потому что там ответ у каждой строки свой.
 */
function settle(value) {
  if (typeof value === "boolean" || value === null || value === undefined) return value;
  if (hasRefs(value)) return value;
  return Boolean(evaluate(value, {}));
}

/** Значение любого свойства узла после подстановки. */
function valueOf(value, data, scope) {
  if (isNode(value)) return value;      // структура -- отдельным проходом
  if (Array.isArray(value)) {
    const out = value.map((v) => valueOf(v, data, scope));
    return out.every((v, i) => v === value[i]) ? value : out;
  }
  if (value !== null && typeof value === "object") {
    if (isExpr(value)) return exprOf(value, data, scope);
    const out = {};
    let changed = false;
    for (const [k, v] of Object.entries(value)) {
      out[k] = valueOf(v, data, scope);
      if (out[k] !== v) changed = true;
    }
    return changed ? out : value;
  }
  return value;
}

/** Выражение после подстановки записи повторителя и ответов на агрегаты. */
function exprOf(node, data, scope) {
  if (node === null || typeof node !== "object") return node;
  if ("i" in node && !("op" in node)) {
    // Вне повторителя подставлять нечего, и ссылка остаётся собой: пусть
    // ошибётся там, где её увидят, а не превратится молча в пустоту.
    return scope === null ? node : scope[node.i];
  }
  if (Array.isArray(node.fmt)) return stringOf(node, data, scope);
  if ("agg" in node) {
    return data.aggregate(
      node.agg,
      node.model,
      node.domain === undefined ? null : exprOf(node.domain, data, scope),
    );
  }
  if (node.op === "&" || node.op === "|") {
    return { op: node.op, p: node.p.map((p) => exprOf(p, data, scope)) };
  }
  if (node.op === "!") return { op: "!", e: exprOf(node.e, data, scope) };
  if (node.op === "null") return { op: "null", e: exprOf(node.e, data, scope) };
  if ("op" in node) {
    return { op: node.op, l: exprOf(node.l, data, scope), r: exprOf(node.r, data, scope) };
  }
  if ("order" in node) {
    return { order: exprOf(node.order, data, scope), dir: node.dir ?? "asc" };
  }
  return node;
}

/** Шаблон, сложенный в строку. */
function stringOf(node, data, scope) {
  const parts = node.fmt.map((p) => exprOf(p, data, scope));
  const unresolved = parts.find((p) => isExpr(p));
  if (unresolved !== undefined) {
    throw new Error(
      `В шаблоне осталась ссылка ${JSON.stringify(unresolved)}: 'item.' -- это ` +
        "запись повторителя, а вокруг этого текста Repeat(...) нет.",
    );
  }
  return parts.map(part).join("");
}

/**
 * Одна подстановка как текст.
 *
 * Ничего и пусто -- пустая строка: в надписи «Удалить «{item.name}»?» имени либо
 * нет, либо оно есть, и слова UNSET там быть не может. Булево пишется
 * по-джсовому, потому что вариантов ровно два и совпадать они обязаны.
 */
function part(value) {
  if (value === null || value === undefined || value === UNSET) return "";
  if (value === true) return "true";
  if (value === false) return "false";
  // `str(3.0)` в питоне -- "3.0", а `String(3.0)` в JS -- "3". Целое,
  // записанное дробью, обязано выглядеть одинаково с обеих сторон.
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return String(value);
  }
  return String(value);
}

export { isNode, isExpr, clone, part };

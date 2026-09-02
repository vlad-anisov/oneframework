/**
 * Вычисление доменов на стороне фронтенда.
 *
 * Пара к oneframework/model/exprjson.py: тот пишет дерево, этот его читает. Обе
 * стороны обязаны давать одинаковый ответ на одинаковой строке -- это
 * проверяется тестом, а не соглашением, потому что расхождение здесь
 * проявляется не ошибкой, а неверно показанным списком.
 *
 * Какие узлы бывают и как каждый записан -- `protocol/expression.json`, одно
 * описание на все языки. Здесь оно не пересказывается.
 *
 * Зачем это здесь вообще: фронтенд держит документ вида в кэше и данные
 * отдельно, поэтому "показывать ли эту строку" он решает сам, не спрашивая
 * бэкенд. Иначе каждое нажатие -- круг по сети.
 */

const UNSET = Symbol("unset");

/**
 * Значение ссылки. Три области: `scope.record` -- проверяемая строка,
 * `scope.view` -- состояние экрана, `scope.item` -- строка повторителя.
 * Последние две различаются намеренно: внутри Repeat в области сразу обе,
 * и `record.board == item.id` спрашивает про разные записи.
 */
function refValue(node, scope) {
  if (node === null || typeof node !== "object") return node;
  if (node.unset === true) return UNSET;
  if ("r" in node && !("op" in node)) {
    const row = scope.record || {};
    return row[node.r] === undefined ? UNSET : row[node.r];
  }
  if ("v" in node) {
    const st = scope.view || {};
    return st[node.v] === undefined ? UNSET : st[node.v];
  }
  if ("i" in node) {
    const it = scope.item || {};
    return it[node.i] === undefined ? UNSET : it[node.i];
  }
  if (node.op in АРИФМЕТИКА) return арифметика(node, scope);
  if (node.op in НЕТОЧНЫЕ) {
    throw new Error(
      `«${node.op}» здесь не считается: ${НЕТОЧНЫЕ[node.op]}. ` +
      "Условие с ним объявляйте отбором, а не показом.");
  }
  return evaluate(node, scope);
}

/**
 * Действия арифметики -- те же, что у выборки (`rel/compile.js`).
 *
 * Здесь их не было вовсе, и это была дыра того же рода, что уже находили пять
 * раз: язык печатает пятнадцать родов узлов, выборка читает все, а показ
 * читал шесть. Условие `visible = length(record.title) > 3` собиралось,
 * доезжало и падало на устройстве -- вслух, но у пользователя.
 *
 * Порядок доводов и краевые случаи взяты у выборки: делить на ноль -- пусто,
 * `endswith` с пустым концом -- истина. Расходиться им нельзя: один и тот же
 * документ решает и что показать, и что отобрать.
 */
const АРИФМЕТИКА = {
  "+": (a) => a[0] + a[1],
  "-": (a) => a[0] - a[1],
  "*": (a) => a[0] * a[1],
  // Деление на ноль -- отказ, как в питоне и как у выборки
  // (`oneframework_zero_division` в `runtime/db.js`). Пусто здесь было бы
  // третьим ответом на один вопрос: питон падает, выборка отказывает, а показ
  // рисовал бы пустую клетку -- и она выглядит как ответ.
  "/": (a) => делить(a[0], a[1], (x, y) => x / y),
  "//": (a) => делить(a[0], a[1], (x, y) => Math.floor(x / y)),
  "%": (a) => делить(a[0], a[1], (x, y) => ((x % y) + y) % y),
  "**": (a) => a[0] ** a[1],
  neg: (a) => -a[0],
  abs: (a) => Math.abs(a[0]),
  // Округление -- к чётному на половинах, как `round()` в питоне и как
  // `oneframework_round` у выборки. Встроенное `Math.round` округляет вверх, и
  // на `2.5` две стороны разошлись бы.
  round: (a) => {
    const знаков = a.length > 1 ? a[1] : 0;
    const множ = 10 ** знаков;
    return кЧётному(a[0] * множ) / множ;
  },
  length: (a) => [...String(a[0])].length,
  trim: (a) => (a.length > 1 ? обрезать(String(a[0]), String(a[1]), true, true)
                             : String(a[0]).trim()),
  ltrim: (a) => (a.length > 1 ? обрезать(String(a[0]), String(a[1]), true, false)
                              : String(a[0]).replace(/^\s+/, "")),
  rtrim: (a) => (a.length > 1 ? обрезать(String(a[0]), String(a[1]), false, true)
                              : String(a[0]).replace(/\s+$/, "")),
  replace: (a) => String(a[0]).split(String(a[1])).join(String(a[2])),
  startswith: (a) => String(a[0]).startsWith(String(a[1])),
  // Про пустой конец здесь оговорки нет намеренно: `endsWith("")` в
  // JavaScript и так истина. У выборки она есть -- там `substr` с нулевой
  // длиной дал бы не то, -- и повторять её здесь значило бы завести правило,
  // которое нечем проверить: снятое, оно ничего не меняет.
  endswith: (a) => String(a[0]).endsWith(String(a[1])),
  text: (a) => String(a[0]),
  integer: (a) => Math.trunc(Number(a[0])) || 0,
  real: (a) => Number(a[0]),
  if: (a) => (truthy(a[0]) ? a[1] : a[2]),
};

/**
 * Слова, которые здесь считать нельзя, и почему.
 *
 * Регистр у выборки ставят свои функции с питоновской семантикой
 * (`pylower`, `pyupper`), а `toLowerCase()` в JavaScript совпадает с ними не
 * везде. Ответить «примерно так же» хуже, чем отказать: показ и отбор
 * разошлись бы на одной и той же записи, и увидел бы это пользователь.
 */
const НЕТОЧНЫЕ = {
  lower: "регистр у выборки ставит своя функция с питоновской семантикой",
  upper: "регистр у выборки ставит своя функция с питоновской семантикой",
  casefold: "регистр у выборки ставит своя функция с питоновской семантикой",
};

function делить(x, y, как) {
  if (y === 0) throw new Error("division by zero");
  return как(x, y);
}

/** Половина уходит к чётному: 0.5 -> 0, 1.5 -> 2. Правило питона. */
function кЧётному(x) {
  const низ = Math.floor(x);
  if (x - низ !== 0.5) return Math.round(Math.abs(x)) * Math.sign(x) || Math.round(x);
  return низ % 2 === 0 ? низ : низ + 1;
}

function обрезать(строка, знаки, слева, справа) {
  const набор = new Set([...знаки]);
  let н = 0;
  let к = строка.length;
  if (слева) while (н < к && набор.has(строка[н])) н += 1;
  if (справа) while (к > н && набор.has(строка[к - 1])) к -= 1;
  return строка.slice(н, к);
}

function арифметика(node, scope) {
  const доводы = (node.args || []).map((a) => refValue(a, scope));
  // Пусто в доводе -- пусто в ответе, как у SQL: считать по неизвестному
  // значит выдумать его.
  if (доводы.some((v) => v === UNSET || v === null || v === undefined)) return null;
  return АРИФМЕТИКА[node.op](доводы);
}

/**
 * Сравнение с той же семантикой, что в Python: UNSET с одной стороны
 * означает "условия нет", и всё выражение считается выполненным. Это не
 * особенность JS -- так же устроен фильтр, который пользователь не выбрал.
 */
function compare(op, a, b) {
  if (a === UNSET || b === UNSET) return true;
  const l = truthy(a), r = truthy(b);
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (op === "=") return l === r;
    if (op === "!=") return l !== r;
  }
  switch (op) {
    case "=": return a === b;
    case "!=": return a !== b;
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    default: throw new Error(`неизвестное сравнение ${op}`);
  }
}

/** 0/1 из SQLite -- это false/true; пустая строка и null -- ложь. */
function truthy(v) {
  if (v === UNSET || v === null || v === undefined) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return Boolean(v);
}

export function evaluate(node, scope = {}) {
  if (node === null || node === undefined) return true;
  if (typeof node !== "object") return truthy(node);
  if (node.unset === true) return false;

  // голая ссылка -- это условие само по себе: record.starred
  if (!("op" in node)) {
    if ("r" in node || "v" in node || "i" in node) {
      return truthy(refValue(node, scope));
    }
    return true;
  }

  switch (node.op) {
    case "&": return node.p.every((p) => evaluate(p, scope));
    case "|": return node.p.some((p) => evaluate(p, scope));
    case "!": return !evaluate(node.e, scope);
    case "null": {
      const v = refValue(node.e, scope);
      return v === null || v === UNSET;
    }
    default:
      // Арифметика бывает и условием сама по себе: `startswith(...)` отвечает
      // булевым, и сравнивать его не с чем. Без этой ветки такой узел уходил
      // в сравнение и получал «неизвестное сравнение startswith».
      if (node.op in АРИФМЕТИКА || node.op in НЕТОЧНЫЕ) {
        return truthy(refValue(node, scope));
      }
      return compare(node.op, refValue(node.l, scope), refValue(node.r, scope));
  }
}

/**
 * Строка из шаблона: `{"fmt": ["Удалить «", {"i": "name"}, "»?"]}`.
 */
export function format(node, scope = {}) {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return part(node);
  if (Array.isArray(node.fmt)) return node.fmt.map((p) => format(p, scope)).join("");
  return part(refValue(node, scope));
}

function part(v) {
  if (v === UNSET || v === null || v === undefined) return "";
  return String(v);
}

export { UNSET };

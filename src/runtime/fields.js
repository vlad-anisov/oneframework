/**
 * Типы полей. Пара к `oneframework/model/fields.py`, но устроена иначе: там поле --
 * класс, здесь оно строится из документа схемы, который питон уже умеет
 * отдавать (`oneframework/model/schema.py`). Девятнадцати классов-двойников тут нет и
 * быть не должно -- иерархия, повторённая на втором языке, расходится с
 * оригиналом молча, а документ расходиться не может: он один.
 *
 *     const model = makeModel(modelSchemaDoc, typeSchemaDoc);
 *     model.fields.price.toDb(12.5);   // 1250
 *
 * Всё, что ниже похоже на возню -- округление через BigInt, свой `str()`, свой
 * `json.dumps` -- нужно ровно для одного: значение, записанное питоном, и
 * значение, записанное этим кодом, должны быть одинаковыми до байта. Обе
 * стороны пишут в одну базу и обмениваются одними changeset-ами, и расхождение
 * здесь не падает с ошибкой, а показывается пользователю неверным числом.
 */

import { newId } from "./ids.js";

// ---------------------------------------------------------------------------
// питоновская семантика, которой в JS нет
// ---------------------------------------------------------------------------

//: Пробельные символы питона (`str.isspace`). С тем, что убирает `trim`, они
//: совпадают не полностью: у питона есть разделители \x1c-\x1f, а BOM (﻿)
//: он пробелом не считает -- и цвет из одного BOM обязан остаться непустым.
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a"
  + "\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");

function pyStrip(text) {
  return text.replace(STRIP, "");
}

/**
 * Истинность по правилам питона. Отличие ровно одно, зато оно и стреляет:
 * пустой список и пустой словарь в JS истинны, а в питоне ложны -- иначе
 * `Boolean` записал бы в базу единицу там, где эталон пишет ноль.
 */
function pyTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;   // nan в питоне истинен
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `value[:n]`: питон режет по кодовым точкам, `slice` -- по единицам UTF-16. */
function pySlice(text, n) {
  return Array.from(text).slice(0, n).join("");
}

/** Число x как `mant * 2^exp`, оба целые: точное значение double, без потерь. */
function unpack(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  let exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (exp === 0) exp = 1;              // денормализованные: неявной единицы нет
  else mant |= 1n << 52n;
  return [mant, exp - 1075];
}

/**
 * |x| * 10^digits, округлённое до целого «половина к чётному».
 *
 * Здесь узел всего файла. Питоновский `round` решает ничью по настоящим битам
 * числа, а не по тому, как оно напечатано, поэтому `round(0.125, 2)` -- это
 * 0.12, а `(0.125).toFixed(2)` -- «0.13». Для копеек в базе разница не
 * абстрактная, и проявится она не ошибкой, а расхождением на копейку.
 */
function scaled(x, digits) {
  const [mant, exp] = unpack(Math.abs(x));
  let num = mant;
  let den = 1n;
  if (digits >= 0) num *= 10n ** BigInt(digits);
  else den *= 10n ** BigInt(-digits);
  if (exp >= 0) num <<= BigInt(exp);
  else den <<= BigInt(-exp);

  let whole = num / den;
  const rest = (num % den) * 2n;
  if (rest > den || (rest === den && (whole & 1n) === 1n)) whole += 1n;
  return whole;
}

/** Целое с `digits` знаками после точки -- десятичной строкой. */
function decimal(negative, whole, digits) {
  let body = whole.toString();
  if (digits > 0) {
    body = body.padStart(digits + 1, "0");
    body = `${body.slice(0, -digits)}.${body.slice(-digits)}`;
  } else if (digits < 0) {
    body += "0".repeat(-digits);
  }
  return negative ? `-${body}` : body;
}

function isNegative(x) {
  return x < 0 || Object.is(x, -0);
}

/** `round(x, digits)`. */
function pyRound(x, digits) {
  if (!Number.isFinite(x)) return x;
  // Обратно через строку, а не делением на 10^n: `Number` читает десятичную
  // запись с правильным округлением, а деление добавило бы вторую ошибку.
  return Number(decimal(isNegative(x), scaled(x, digits), digits));
}

/**
 * `round(x)` без второго аргумента: результат целый, а на бесконечности отказ.
 *
 * Ноль возвращается положительным: у целых в питоне знака нуля нет, и −0.001
 * даёт там 0, а не −0. Разница видна не в арифметике, а в колонке.
 */
function pyRoundToInt(x) {
  if (!Number.isFinite(x)) throw new RangeError(`${x} нельзя округлить до целого`);
  const whole = Number(scaled(x, 0));
  if (whole === 0) return 0;
  return isNegative(x) ? -whole : whole;
}

/** `f"{x:.<digits>f}"`. */
function pyFixed(x, digits) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  return decimal(isNegative(x), scaled(x, digits), digits);
}

/**
 * `repr(float)`. Цифры у питона и у `String(x)` одни и те же -- обе стороны
 * берут кратчайшую запись, которая читается обратно в то же число, -- а вот
 * граница экспоненциальной формы разная: питон уходит в неё с 1e16, JS только
 * с 1e21. Без пересчёта один и тот же float лёг бы в колонку как «1e+16» с
 * одной стороны и как «10000000000000000» с другой.
 */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";

  const [, lead, rest, exp] = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(Math.abs(x).toExponential());
  const digits = lead + (rest || "");
  const point = Number(exp) + 1;            // цифр до десятичной точки
  const sign = isNegative(x) ? "-" : "";

  if (point > 16 || point <= -4) {
    const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = point - 1;
    const width = `${Math.abs(e)}`.padStart(2, "0");
    return `${sign}${head}e${e < 0 ? "-" : "+"}${width}`;
  }
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Число так, как печатает его питон. И вот здесь эталон недостижим принципиально:
 * `3` и `3.0` -- для JS одно значение, а питон напишет «3» и «3.0». Целое
 * печатается целым, потому что из базы приходят именно целые.
 */
function pyNumRepr(x) {
  if (!Number.isInteger(x)) return pyFloatRepr(x);
  // За 1e21 `String` сама уходит в экспоненциальную запись, а питон для int -- нет.
  return Math.abs(x) < 1e21 ? String(x) : BigInt(x).toString();
}

/** `str(value)`. */
function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pyNumRepr(value);
  if (typeof value === "string") return value;
  // Списки и словари питон печатает по-своему («[1, 2]», кавычки одинарные), но
  // ни одно поле такого значения не получает: пара координат разбирается раньше,
  // остальное приходит из базы скаляром.
  return String(value);
}

//: Числовой литерал питона: подчёркивания между цифрами он берёт, «0x10» --
//: нет, а `Number` берёт и то и другое, причём молча.
const DIGITS = "\\d+(?:_\\d+)*";
const FLOAT_TEXT = new RegExp(
  `^[+-]?(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?$`,
);
const INT_TEXT = new RegExp(`^[+-]?${DIGITS}$`);
const SPECIAL_TEXT = /^([+-]?)(inf|infinity|nan)$/i;

/**
 * `float(value)` вместе с его отказами: `float("abc")` в питоне -- ошибка, а
 * `Number("abc")` -- NaN. Разница принципиальная: отказ виден сразу, а NaN
 * молча доезжает до колонки и оттуда до экрана.
 */
function pyFloat(value) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") throw new TypeError(`float() не принимает ${pyStr(value)}`);

  const text = pyStrip(value);
  const special = SPECIAL_TEXT.exec(text);
  if (special) {
    const magnitude = special[2].toLowerCase() === "nan" ? NaN : Infinity;
    return special[1] === "-" ? -magnitude : magnitude;
  }
  if (!FLOAT_TEXT.test(text)) throw new RangeError(`float(${JSON.stringify(value)}): не число`);
  return Number(text.replaceAll("_", ""));
}

/** `int(value)`: дробное отбрасывается к нулю, «3.5» и «» -- отказ. */
function pyInt(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`${value} нельзя привести к целому`);
    // `Math.trunc(-0.5)` -- это −0, а у целых в питоне знака нуля нет: сумма в
    // −0 копеек прочиталась бы из базы как −0.0 рублей.
    return Math.trunc(value) || 0;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") throw new TypeError(`int() не принимает ${pyStr(value)}`);

  const text = pyStrip(value);
  if (!INT_TEXT.test(text)) throw new RangeError(`int(${JSON.stringify(value)}): не целое`);
  return Number(text.replaceAll("_", ""));
}

/**
 * `json.dumps(value, ensure_ascii=False)`, а не `JSON.stringify`: питон ставит
 * пробел после запятой и двоеточия. Значение от этого не меняется, но в колонке
 * лежит текст -- и другой текст означает правку там, где её не было: строка
 * поедет в changeset и на другое устройство на ровном месте.
 */
function pyJsonDumps(value) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return pyNumRepr(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  if (typeof value === "object") {
    const parts = [];
    for (const key of Object.keys(value).sort(byCodePoint)) {
      if (value[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}: ${pyJsonDumps(value[key])}`);
    }
    return `{${parts.join(", ")}}`;
  }
  throw new TypeError(`json не умеет ${typeof value}`);
}

/**
 * Порядок ключей питона -- по кодовым точкам, а `sort()` без сравнителя
 * сравнивает по 16-битным единицам UTF-16. Разница видна не на выдумке:
 * ключ с эмодзи (U+1F600 -- пара суррогатов D83D DE00) у питона больше ключа
 * с U+FFFD, а у голого `sort()` меньше. Ключи в колонке -- это текст, текст --
 * это байты changeset'а, и разошлись бы стороны молча.
 */
function byCodePoint(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const d = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (d) return d;
  }
  return left.length - right.length;
}

/**
 * Момент так, как его пишет питоновский `Datetime`: шесть знаков дробной части,
 * как `%f`. Часы JS дают только миллисекунду, поэтому три последних разряда
 * всегда нули -- но ширина обязана остаться прежней, потому что по этой строке
 * записи и сортируются, в том числе рядом с написанными питоном.
 */
function stampOf(moment) {
  return `${moment.toISOString().slice(0, -1)}000Z`;
}

/** Текущий момент -- пара к `Datetime.now()`. */
export function now() {
  return stampOf(new Date());
}

// ---------------------------------------------------------------------------
// приведения по типам
// ---------------------------------------------------------------------------

/** Знаков после точки. `digits` объявлено полем; шесть -- запасной вариант питона. */
function scaleOf(field) {
  return Array.isArray(field.digits) ? field.digits[1] : 6;
}

const TEXT = { toDb: (field, value) => (value === null ? null : pyStr(value)) };

const WHOLE = {
  pyDefault: 0,
  toDb: (field, value) => (value === null ? 0 : pyInt(value)),
  fromDb: (field, value) => (value === null ? 0 : pyInt(value)),
};

const REFERENCE = {
  toDb: (field, value) => {
    if (value === null) return null;
    // Ссылка приходит и записью, и одним ключом -- в колонку едет ключ.
    let id = value;
    if (typeof value === "object" && !Array.isArray(value)) id = value.id ?? null;
    if (id === null || id === undefined || id === "") return null;
    return pyStr(id);
  },
};

//: Каждый тип -- только его приведения. Всё остальное (sql, виджеты, хранится
//: ли он вообще) приезжает документом типов и здесь не повторяется.
const KINDS = {
  string: TEXT,
  uuid: {
    ...TEXT,
    // Ключ придумывает устройство: поле, оставленное пустым, всё равно обязано
    // получить значение, иначе запись нечем адресовать.
    default: (field) => (pyTruthy(field.explicitDefault) ? field.explicitDefault : newId()),
  },
  integer: WHOLE,
  duration: WHOLE,
  float: {
    pyDefault: 0,
    toDb: (field, value) => (
      value === null || value === "" ? 0 : pyRound(pyFloat(value), scaleOf(field))
    ),
    fromDb: (field, value) => (value === null ? 0 : pyFloat(value)),
  },
  monetary: {
    pyDefault: 0,
    // Целые копейки: float не хранит десятичную сумму точно, и ошибка копится
    // по всей колонке. DSL и экран при этом видят обычное число.
    toDb: (field, value) => (
      value === null ? null : pyRoundToInt(pyFloat(value) * 10 ** scaleOf(field))
    ),
    fromDb: (field, value) => (value === null ? 0 : pyInt(value) / 10 ** scaleOf(field)),
  },
  boolean: {
    pyDefault: false,
    toDb: (field, value) => (pyTruthy(value) ? 1 : 0),
    fromDb: (field, value) => pyTruthy(value),
    toJson: (field, value) => pyTruthy(value),
  },
  json: {
    toDb: (field, value) => (value === null ? null : pyJsonDumps(value)),
    fromDb: (field, value) => {
      // Сломанное значение -- это пусто, а не исключение: поле-отдушина обязано
      // пережить чужую запись, иначе одна кривая строка уронит весь список.
      if (value === null || value === "" || typeof value !== "string") return null;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
  },
  selection: {
    toDb: (field, value) => (value === null || value === "" ? null : pyStr(value)),
  },
  color: {
    toDb: (field, value) => (value === null ? null : pyStrip(pyStr(value)) || null),
  },
  date: {
    toDb: (field, value) => {
      // Наивной даты в JS нет, поэтому у момента берётся календарный день по
      // UTC -- рантайм и хранит всё в UTC.
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (value === null || value === "") return null;
      return pySlice(pyStr(value), 10);
    },
  },
  datetime: {
    // Не-момент едет как есть: из базы приходит уже готовая строка ISO.
    toDb: (field, value) => (value instanceof Date ? stampOf(value) : value),
  },
  time: {
    toDb: (field, value) => {
      if (value instanceof Date) return value.toISOString().slice(11, 16);
      if (value === null || value === "") return null;
      return pySlice(pyStr(value), 5);
    },
  },
  binary: {
    toDb: (field, value) => (value === null || value === "" ? null : pyStr(value)),
  },
  geopoint: {
    toDb: (field, value) => {
      if (value === null || value === "") return null;
      if (Array.isArray(value) && value.length === 2) {
        return `${pyFixed(pyFloat(value[0]), 6)},${pyFixed(pyFloat(value[1]), 6)}`;
      }
      return pyStr(value);
    },
    fromDb: (field, value) => {
      if (!pyTruthy(value)) return null;
      const parts = pyStr(value).split(",");
      if (parts.length !== 2) return null;
      try {
        return [pyFloat(parts[0]), pyFloat(parts[1])];
      } catch {
        return null;
      }
    },
  },
  many2one: REFERENCE,
  // Один-к-одному -- тот же many2one, которому запрещено повторяться; ограничение
  // живёт в схеме таблицы, а на приведение значения оно не влияет.
  one2one: REFERENCE,
  one2many: {},         // колонки нет, приводить нечего
  many2many: {},
};

// ---------------------------------------------------------------------------
// сборка поля и модели из документа схемы
// ---------------------------------------------------------------------------

//: Связи «к одному» держат колонку `<имя>_id`, связи «ко многим» -- никакой.
const TO_ONE = new Set(["many2one", "one2one"]);
const TO_MANY = new Set(["one2many", "many2many"]);

/** `str.capitalize()`: первая буква вверх, остальные -- вниз, да, именно вниз. */
function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1).toLowerCase() : text;
}

function columnOf(doc) {
  if (TO_MANY.has(doc.ftype)) return null;
  return TO_ONE.has(doc.ftype) ? `${doc.name}_id` : doc.name;
}

export function makeField(doc, types) {
  const kind = KINDS[doc.ftype];
  const type = types && types[doc.ftype];
  if (!kind) throw new Error(`неизвестный тип поля ${doc.ftype}`);
  if (!type) throw new Error(`в документе типов нет ${doc.ftype} (поле ${doc.name})`);

  const { default: explicit, widget, ...declared } = doc;
  const field = {
    // Всё, что поле сказало о себе, едет дальше как есть: digits, comodel,
    // accept, selection, unit. Новое свойство доходит так до виджета, не требуя
    // правки этого файла, -- ровно за этим схема и собирается интроспекцией.
    ...declared,
    name: doc.name,
    ftype: doc.ftype,
    column: columnOf(doc),
    sqlType: type.sql ?? null,
    stored: doc.stored === undefined ? type.stored : doc.stored,
    // Служебное поле -- id, hlc, created_at, updated_at. Код, спрашивающий «ввёл
    // ли пользователь хоть что-нибудь», обязан их пропускать: отметка порядка --
    // такая же строка, и, посчитав её содержимым, он не найдёт ни одной пустой записи.
    system: doc.system === true,
    required: doc.required === true,
    displayLabel: doc.label || capitalize(String(doc.name ?? "").replaceAll("_", " ")),
    widgets: type.widgets,
    defaultWidget: widget || type.widget,
    explicitDefault: explicit === undefined ? null : explicit,
  };
  if (Array.isArray(doc.selection)) {
    field.choices = doc.selection.map(([value, label]) => ({ value, label }));
  }

  // undefined -- это то же отсутствие значения, что и None: поле, которого нет в
  // строке, и поле, которое в ней пустое, должны привестись одинаково.
  const call = (fn, value) => {
    const v = value === undefined ? null : value;
    return fn ? fn(field, v) : v;
  };
  field.toDb = (value) => call(kind.toDb, value);
  field.fromDb = (value) => call(kind.fromDb, value);
  field.toJson = (value) => call(kind.toJson, value);
  field.default = () => {
    if (kind.default) return kind.default(field);
    return field.explicitDefault === null ? (kind.pyDefault ?? null) : field.explicitDefault;
  };
  return field;
}

/** Документ модели (`model_schema`) + документ типов (`type_schema`) -> модель. */
export function makeModel(modelDoc, typeDoc) {
  const fieldList = modelDoc.fields.map((doc) => makeField(doc, typeDoc));
  // Прототипа нет намеренно: имена полей приходят из приложения, и поле `name`
  // или `constructor` не должно попасть в чужое свойство.
  const fields = Object.create(null);
  for (const field of fieldList) fields[field.name] = field;

  return {
    name: modelDoc.name,
    table: modelDoc.table,
    fields,
    fieldList,

    field(name) {
      const found = fields[name];
      if (!found) throw new Error(`у модели ${modelDoc.name} нет поля ${name}`);
      return found;
    },
    /** Поля с колонкой, кроме первичного ключа. */
    storedFields: () => fieldList.filter((f) => f.name !== "id" && f.stored),
    /** Поля, за которыми стоит запрос, а не колонка. */
    virtualFields: () => fieldList.filter((f) => !f.stored),
    /** Связи, владеющие внешним ключом. */
    relations: () => fieldList.filter((f) => TO_ONE.has(f.ftype)),
    /** Поле, которым запись называется человеку: `name`, иначе первая строка. */
    displayField: () => (
      fields.name || fieldList.find((f) => f.ftype === "string" && !f.system) || null
    ),
    displayName(row) {
      const shown = this.displayField();
      if (!shown) return `${modelDoc.name} #${row.id}`;
      return row[shown.name] || `#${row.id}`;
    },
  };
}

/**
 * Связать связи. Отдельным проходом после сборки всех моделей, потому что
 * связь называет вторую сторону **именем**, а не объектом: модели ссылаются
 * друг на друга кольцами, и разрешить имя в момент сборки первой из них
 * попросту нечем.
 *
 * Тот же порядок, что у питона: там `Many2one.comodel` тоже может быть строкой,
 * и `resolve_comodel()` разбирает её через реестр по требованию.
 */
function bindRelations(model, models) {
  const find = (name, field) => {
    const found = models[name];
    if (!found) {
      throw new Error(
        `${model.name}.${field.name} ссылается на неизвестную модель ${name}`,
      );
    }
    return found;
  };

  for (const field of model.fieldList) {
    if (!field.comodel) continue;
    field.resolveComodel = () => find(field.comodel, field);

    if (field.ftype === "many2many") {
      /** `[таблица связи, своя колонка, чужая колонка]`. */
      field.relation = () => {
        const other = field.resolveComodel();
        // Имя по умолчанию собирается из обеих таблиц и имени поля: два разных
        // Many2many между одной парой моделей обязаны получить разные таблицы.
        const table = field.relation_table
          || `${model.table}_${other.table}_${field.name}_rel`;
        return [table, `${model.table}_id`, `${other.table}_id`];
      };
    }

    if (field.ftype === "one2many") {
      /** Тот `Many2one` на второй стороне, обратной стороной которого мы и есть. */
      field.inverseField = () => {
        const other = field.resolveComodel();
        const inverse = other.fields[field.inverse];
        if (!inverse || !TO_ONE.has(inverse.ftype)) {
          throw new Error(
            `One2many ${model.name}.${field.name} требует, чтобы ` +
              `${other.name}.${field.inverse} был Many2one`,
          );
        }
        return inverse;
      };
    }
  }
  return model;
}

/** Документ приложения (`app_schema`) -> модели по именам. */
export function makeModels(appDoc) {
  const models = Object.create(null);
  for (const doc of appDoc.models) models[doc.name] = makeModel(doc, appDoc.types);
  for (const name of Object.keys(models)) bindRelations(models[name], models);
  return models;
}

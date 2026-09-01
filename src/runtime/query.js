/**
 * Домен -> параметризованный SQL: хост для ядра, сторона браузера.
 *
 * Компиляции здесь больше нет. Она была написана дважды -- здесь и в
 * `oneframework/model/query.py, удалён`, -- и совпадение копий доказывалось сверкой на 785
 * строк. Расходились они очень тихо: не исключением, а другим WHERE. Самый
 * дорогой случай уже был -- незаданный `view.tag` обязан снимать условие, и SQL
 * это делал, а фронтенд сравнивал напрямую и прятал все строки. Никакой ошибки
 * при этом не видно, видно пустой список.
 *
 * Теперь правило одно и лежит в `core/src/query.rs`. Здесь остаётся то, чего
 * чистая функция сделать не может:
 *
 * * **собрать документ модели.** Ядро спрашивает про поле четыре вещи -- имя,
 *   колонку, тип и хранится ли оно, -- и больше ничего;
 * * **перевести состояние экрана.** `UNSET` -- символ, в JSON его нет; на
 *   проводе он `{"unset": true}`, потому что `null` уже занят значением SQL
 *   NULL, а путать их нельзя: NULL условие ставит, UNSET -- снимает;
 * * **прогнать параметр через `toDb`.** Ядро отдаёт значения как есть и рядом
 *   `cast` -- имя поля, чьим `toDb` значение надо перевести в вид колонки.
 *
 * Интерфейс модели тот же, что был (его даёт `makeModel` из ./fields.js):
 *
 *     model.table                  имя таблицы
 *     model.fields[name].column    имя колонки (у many2one это `<name>_id`)
 *     model.fields[name].ftype     тип: голым условием может стоять только boolean
 *     model.fields[name].stored    есть ли колонка вообще
 *     model.fields[name].toDb(v)   значение поля -> значение параметра
 */

// Компилятор домена -- местный, без WASM. Сверен с прежним ядром побайтно на
// 333 запросах (настоящих и краевых): см. tests/test_domain.py.
import { compileQuery } from "../rel/domain.js";
import { UNSET } from "../expr.js";

export class DslError extends Error {
  constructor(message) {
    super(message);
    this.name = "DslError";
  }
}

/**
 * Документ модели по объекту модели, и сразу **напечатанный**. Поля после
 * сборки не меняются, а документ уезжает в ядро на каждый запрос и занимает три
 * четверти кадра: печатать его заново каждый раз значило бы платить за самую
 * дорогую часть вызова дважды -- тем же текстом кадр служит ключом памяти.
 */
const docs = new WeakMap();

function modelDoc(model) {
  let doc = docs.get(model);
  if (doc) return doc;
  doc = JSON.stringify({
    table: model.table,
    fields: Object.entries(model.fields).map(([name, f]) => ({
      name: f.name === undefined ? name : f.name,
      column: f.column === undefined ? null : f.column,
      ftype: f.ftype,
      // Поле без `stored` -- колонка: так его читал этот файл и раньше.
      stored: f.stored !== false,
    })),
  });
  docs.set(model, doc);
  return doc;
}

export class QueryContext {
  /**
   * @param model     модель, из которой идёт выборка (разрешает `record.x`)
   * @param viewState состояние экрана: ключа нет -> UNSET
   * @param alias     псевдоним таблицы в SQL
   */
  constructor(model = null, viewState = null, alias = "t") {
    this.model = model || null;
    this.viewState = viewState || {};
    this.alias = alias;
  }

  column(field) {
    // Осталось здесь, а не уехало в ядро: колонку спрашивает построение строки
    // списка -- по колонке на слот, много раз за экран, -- и переход границы
    // ради склейки двух строк стоил бы дороже всего остального.
    return `${this.alias}."${field.column}"`;
  }
}

/**
 * Состояние экрана на проводе.
 *
 * `undefined` становится `null` намеренно: `JSON.stringify` такой ключ просто
 * выбрасывает, а выброшенный ключ ядро прочитает как UNSET -- то есть условие
 * **снимется**, хотя раньше оно давало `(1=0)`. Разница ровно та, из-за которой
 * всё это и переезжало: список молча стал бы другим.
 */
function stateDoc(state) {
  const out = {};
  for (const key of Object.keys(state || {})) {
    const value = state[key];
    if (value === UNSET) out[key] = { unset: true };
    else out[key] = value === undefined ? null : value;
  }
  return out;
}

/**
 * Запрос так, как он поедет в ядро -- сразу текстом. Документ модели уже
 * напечатан, поэтому кадр собирается склейкой.
 */
function wire(model, ctx, ops) {
  return (
    `{"ctx":{"model":${model ? modelDoc(model) : "null"}` +
    `,"state":${JSON.stringify(stateDoc(ctx.viewState))}` +
    `,"alias":${JSON.stringify(ctx.alias)}},"ops":${JSON.stringify(ops)}}`
  );
}

/**
 * Ответы ядра по тексту запроса.
 *
 * Замерено (`docs/wasm-api.md`, §7): переход границы стоит на порядки дороже
 * самой компиляции, потому что платится он вызовами рантайма, а не работой.
 * Экран же спрашивает одно и то же по многу раз: список перерисовывается на
 * каждое изменение данных, а агрегат внутри повторителя -- по разу на копию
 * строки. Ключ -- сам текст запроса: состояние экрана в нём уже есть, поэтому
 * смена фильтра даёт другой ключ сама собой.
 */
const MEMO_LIMIT = 256;
const memo = new Map();

function ask(model, ctx, ops) {
  const payload = wire(model, ctx, ops);
  let results = memo.get(payload);
  if (results === undefined) {
    results = compileQuery(payload);
    while (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value);
  } else {
    memo.delete(payload);
  }
  memo.set(payload, results);
  return results.map((frame) => {
    if (frame.error) throw new DslError(frame.error.message);
    return frame.ok;
  });
}

/**
 * Параметры ядра -> значения, годные колонке. `cast` идёт параллельно
 * `params`: имя поля означает «прогнать через его `toDb`», `null` -- «значение
 * уже годится» (искомое поиска, LIMIT).
 *
 * Список -- **копия**: ответ ядра лежит в памяти ответов, и правка на месте
 * испортила бы его для следующего спрашивающего.
 */
function values(answer, model) {
  const params = [...answer.params];
  answer.cast.forEach((name, i) => {
    if (name !== null && name !== undefined) params[i] = model.fields[name].toDb(params[i]);
  });
  return params;
}

/**
 * Домен -> `[sqlOrNull, params]`. `null` означает «ограничения нет» и это не то
 * же самое, что пустая строка: пустое условие исчезает из WHERE, а не отбирает
 * ноль строк.
 */
export function compileDomain(node, ctx) {
  // Отсутствие условия -- не работа: переход границы за него не платится.
  if (node === null || node === undefined) return [null, []];
  const answer = ask(ctx.model, ctx, [{ do: "domain", node }])[0];
  return [answer.sql, values(answer, ctx.model)];
}

/**
 * Термы сортировки -> строка для ORDER BY. Терм -- либо
 * `{"order": <ссылка>, "dir": "asc"|"desc"}`, либо голая ссылка.
 */
export function compileOrder(orders, ctx) {
  return ask(ctx.model, ctx, [{ do: "order", terms: orders || [] }])[0].sql;
}

/** Поиск подстроки без учёта регистра по набору полей. */
export class SearchSpec {
  constructor(fields, text) {
    this.fields = fields || [];
    this.text = (text === null || text === undefined ? "" : String(text)).trim();
  }

  compile(ctx) {
    const op = { do: "search", fields: this.fields, text: this.text };
    const answer = ask(ctx.model, ctx, [op])[0];
    return [answer.sql, values(answer, ctx.model)];
  }
}

/**
 * Собрать SELECT по *model*.
 *
 * `whereParts` -- список пар `[sql, params]`; части с `sql === null`
 * пропускаются, что и есть распространение «условия нет» до самого верха.
 *
 * Значения через границу не ездят: они здесь уже есть -- это те же пары,
 * которые сюда и передали. Ядро отдаёт `take` -- откуда брать очередной
 * параметр, -- и порядок «колонки, условия, LIMIT, OFFSET» остаётся правилом в
 * одном месте, а здесь остаётся склейка списков.
 */
export function buildSelect(model, ctx, whereParts, orderSql, options = {}) {
  const { limit = null, offset = null, columns = null } = options;
  const parts = whereParts || [];
  const op = {
    do: "select",
    where: parts.map((part) => (!part || part[0] === null || part[0] === undefined ? null : part[0])),
    order: orderSql || "",
    limit,
    offset,
    columns: columns === null ? null : columns.map(([sql]) => sql),
  };
  const answer = ask(model, ctx, [op])[0];
  const params = [];
  for (const [tag, value] of answer.take) {
    if (tag === "c") params.push(...columns[value][1]);
    else if (tag === "w") params.push(...parts[value][1]);
    else params.push(value);
  }
  return [answer.sql, params];
}

export { UNSET };

/**
 * Действие, объявленное данными: правило + запись. Близнец `oneframework/rel/action.py`.
 *
 * Первое действие, ради которого больше не нужен модуль WASM. `Task.complete`
 * --- «завершить задачу вместе с подзадачами на любую глубину» --- считалось
 * случаем, который «декларацией не выражается». Выражается: правило даёт
 * множество, `Mutation` его правит, всё это один оператор SQL.
 */

import { Mutation, compileRule } from "./plan.js";

export function isDeclarative(doc) {
  return Boolean(doc) && typeof doc === "object" && !("entry" in doc)
    && ("rule" in doc || "write" in doc || isPython(doc) || isJs(doc)
        || isWasm(doc));
}

/**
 * Действие, которое считает настоящий питон на устройстве.
 *
 * Третий вид объявления -- ради того, чего в SQL нет и не будет: словарной
 * морфологии, разбора чужого формата. Едет исходником, той же дорогой, что
 * модели и виды.
 */
/**
 * Действие на JavaScript -- рантайм уже стоит, это сам webview. Сюда же
 * Kotlin сюда **не** приезжает: `.kt` компилируется TeaVM в WebAssembly
 * и исполняется `wasm_action.js`. Дорога через `kotlinc-js` разбиралась и
 * отменена -- её сборщик удалён 21.08.2026.
 */
/**
 * Действие, скомпилированное в WebAssembly. Ни интерпретатора, ни исходника:
 * объявление называет модуль, который сборка положила рядом с приложением.
 */
export function isWasm(doc) {
  return Boolean(doc) && typeof doc === "object"
    && Boolean(doc.wasm) && typeof doc.wasm.module === "string";
}

export function isJs(doc) {
  return Boolean(doc) && typeof doc === "object"
    && Boolean(doc.js) && typeof doc.js.source === "string";
}

export function isPython(doc) {
  return Boolean(doc) && typeof doc === "object"
    && Boolean(doc.python) && typeof doc.python.source === "string";
}

/**
 * Готовый вызов `(args) -> результат` -- та же форма, что у модуля.
 *
 * `now` -- часы хоста. Время приходит **параметром вызова**, а не берётся
 * внутри запроса: `datetime('now')` SQLite сама объявляет недетерминированной,
 * и два устройства, посчитавшие одно и то же в разные секунды, разошлись бы.
 */
export function declarativeAction(db, doc, now = null) {
  const ruleDoc = doc.rule || null;
  const writeDoc = doc.write || null;
  if (!writeDoc) throw new Error(`Объявление ${doc.name} ничего не пишет: нет «write».`);

  const run = (payload) => {
    const ids = (payload && payload.ids) || [];
    if (!ids.length) return { changed: 0 };
    const stamp = (typeof now === "function" ? now() : now) || "";
    const clock = { now: stamp, today: stamp.slice(0, 10) };
    const con = db.connect();
    let changed = 0;
    for (const recordId of ids) {
      const { sql, params } = statement(ruleDoc, writeDoc, recordId, clock);
      con.execute(sql, params);
      changed += 1;
    }
    return { changed };
  };
  run.manifest = doc;
  run.declarative = true;
  return run;
}

/** Правило и правка -- **один** оператор, а не обход с запросом на запись. */
function statement(ruleDoc, writeDoc, recordId, clock) {
  let ruleSql = null;
  let params = {};
  if (ruleDoc) {
    const rule = { ...ruleDoc, seed: { ...(ruleDoc.seed || {}) } };
    if ("param" in rule.seed) rule.seed.value = recordId;
    const { piece } = compileRule(rule);
    ruleSql = piece.sql;
    params = { ...piece.params };
  }
  const mutation = new Mutation(writeDoc.table, writeDoc.source, writeDoc.set || {});
  const built = mutation.compile(ruleSql);
  Object.assign(params, built.params);
  // Часы подставляются здесь: объявление называет параметр по имени, значение
  // ему даёт хост. Ни одно значение времени не попадает в текст запроса.
  for (const [key, value] of Object.entries(clock)) {
    if (key in params) params[key] = value;
  }
  return { sql: built.sql, params };
}

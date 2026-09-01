/**
 * Долгоживущий хост компилятора на JS -- один процесс на всю сюиту.
 *
 * Проверки правил компилятора зовут его сотни раз. Поднимать node на каждый
 * вызов -- это ~80 мс на запуск против доли миллисекунды на саму работу:
 * сюита из трёхсот утверждений превращается в полминуты ожидания запусков.
 * Поэтому разговор построчный: строка запроса -- строка ответа, порядок
 * сохраняется тем, что читатель один.
 *
 * Отказ едет ответом, а не падением процесса: правила компилятора наполовину
 * состоят из отказов («голой ссылкой может стоять только boolean»), и проверять
 * их можно только если отказ доезжает словами.
 */
import { createInterface } from "node:readline";

import { compileQuery } from "../../src/rel/domain.js";
import { canonical, compileExpr, shape, aggSql } from "../../src/rel/compile.js";
import { computedColumns, declarationOf, modelsRead } from "../../src/rel/fields.js";
import { isDeclarative, isJs, isPython, isWasm } from "../../src/rel/action.js";
import { evaluate } from "../../src/expr.js";
import { makeModels } from "../../src/runtime/fields.js";
import { AccessPath, Mutation, compileRule, compileScreen } from "../../src/rel/plan.js";

//: Модели живут между запросами. Гнать их описание с каждым вызовом --
//: значит слать килобайты на каждое утверждение и, хуже, собирать их заново:
//: `makeModels` связывает модели друг с другом, и пересборка на каждый вызов
//: означала бы, что связь всякий раз новая.
let МОДЕЛИ = null;

//: Имена -- те же, что у питона, чтобы проверка читалась одинаково с обеих
//: сторон. Переименование здесь стоило бы слоя перевода в каждой проверке.
const ОПЕРАЦИИ = {
  compile_query: (payload) => compileQuery(payload),
  compile_expr: (node, opts) => {
    const o = { ...(opts || {}) };
    if (Array.isArray(o.nullable)) o.nullable = new Set(o.nullable);
    const c = compileExpr(node, o);
    // `Compiled` -- объект с методами; по проводу едут только его поля.
    return { sql: c.sql, params: c.params, status: c.status, form: c.form,
             missing: c.missing, reads: c.reads };
  },
  canonical: (node) => canonical(node),
  //: Вычислить условие на записи -- то, чем устройство решает, рисовать ли
  //: узел. Питоновский вычислитель был вторым; правила спрашиваются у того,
  //: который правда решает.
  evaluate: (node, record, viewState) =>
    Boolean(evaluate(node, { record: record || {}, view: viewState || {} })),
  //: План выборки. По проводу едут поля, а не объекты: `AccessPath` и
  //: `Compiled` -- объекты с методами, и питоновская сторона всё равно смотрит
  //: только на то, что они рассказывают о себе.
  compile_screen: (table, opts) => {
    const o = opts || {};
    const s = compileScreen(table, {
      key: o.key || "id",
      rowFields: o.row_fields || {},
      aggregates: o.aggregates || [],
      consumer: o.consumer || "screen",
    });
    return { sql: s.sql, params: s.params, fields: s.fields,
             access: s.access.map((a) => a.asJson()), unsupported: s.unsupported };
  },
  compile_rule: (rule) => {
    const { piece, access } = compileRule(rule);
    return { sql: piece.sql, params: piece.params, status: piece.status,
             form: piece.form, missing: piece.missing,
             access: access.map((a) => a.asJson()) };
  },
  //: Правилу отдаётся уже напечатанный SQL, а не объявление: так устроен и
  //: вызов в приложении -- правило печатается один раз, а правок по нему
  //: может быть несколько.
  mutation: (table, source, assignments, ruleSql) => {
    const m = new Mutation(table, source, assignments);
    return m.compile(ruleSql ?? null);
  },
  access_satisfied: (table, prefix, indexes) =>
    new AccessPath(table, prefix, "check", "test").satisfiedBy(indexes),
  shape: (node) => shape(node),
  agg_sql: (kind, of, where, empty) => aggSql(kind, of, where, empty),
  declaration_of: (field) => declarationOf(field),
  models_read: (model) => modelsRead(model),
  computed_columns: (model, alias, models) => computedColumns(model, alias ?? "t", models ?? null),
  is_declarative: (doc) => isDeclarative(doc),
  is_python: (doc) => isPython(doc),
  is_wasm: (doc) => isWasm(doc),
  is_js: (doc) => isJs(doc),
  //: Описание моделей приезжает с питоновской стороны (`app_schema`): язык
  //: объявления там и остаётся, а собирает модели тот же код, что на
  //: устройстве.
  load_models: (appDoc) => { МОДЕЛИ = makeModels(appDoc); return Object.keys(МОДЕЛИ); },
  computed_columns_of: (name, alias) => {
    if (!МОДЕЛИ) throw new Error("Модели не загружены: сперва load_models");
    const m = МОДЕЛИ[name];
    if (!m) throw new Error(`Нет модели ${name}; есть ${Object.keys(МОДЕЛИ)}`);
    return computedColumns(m, alias ?? "t", МОДЕЛИ);
  },
};

const строки = createInterface({ input: process.stdin });
for await (const строка of строки) {
  if (!строка.trim()) continue;
  let ответ;
  try {
    const { op, args } = JSON.parse(строка);
    const f = ОПЕРАЦИИ[op];
    if (!f) throw new Error(`Хост не умеет ${op}`);
    // `await` не лишний: без него асинхронная операция отдаёт обещание, а
    // оно сериализуется в `{}` -- проверка получает пустой ответ вместо
    // настоящего и сравнивает его молча. Поймано на первой же такой операции.
    ответ = { ok: await f(...(args || [])) };
  } catch (err) {
    ответ = { error: { name: (err && err.name) || "Error",
                       message: String((err && err.message) || err) } };
  }
  process.stdout.write(JSON.stringify(ответ) + "\n");
}

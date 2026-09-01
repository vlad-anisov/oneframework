/**
 * Долгоживущий хост **приложения** -- рантайм, который стоит на устройстве.
 *
 * Пара к `rel_host.mjs`: тот отвечает про компилятор, этот -- про то, что из
 * скомпилированного получается кадр. Разговор такой же построчный, и по той же
 * причине: проверки рантайма зовут его сотнями, а запуск node стоит ~80 мс.
 *
 * База открывается **из файла в память**: у сборки `sqlite-wasm` под node нет
 * файлового VFS. Правки живут в памяти хоста и умирают вместе с процессом --
 * и это верно по существу: спрашивает у хоста проверка, а не пользователь.
 * Поэтому же счёт записей спрашивается **у хоста**, а не у питоновской базы:
 * та осталась в том виде, в каком её выложили, и ничего не знает о правках.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { Database } from "../../src/runtime/db.js";
import { loadDocuments, loadSchema } from "../../src/runtime/defs.js";
import { makeModels } from "../../src/runtime/fields.js";
import { Draft, RowPlan, Runtime, conditionColumn } from "../../src/runtime/session.js";
import { QueryContext, buildSelect, compileDomain } from "../../src/runtime/query.js";
import { evaluate } from "../../src/expr.js";
import * as logic from "../../src/runtime/logic.js";

const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });

let db = null;
let rt = null;
//: Черновики держатся по имени: за проводом объекта не передать, а проверке
//: нужно писать в один и тот же черновик несколькими вызовами.
const ЧЕРНОВИКИ = new Map();
//: Счётчики путей выборки и снятая проекция -- обе подмены временные и обе
//: обязаны сниматься: иначе следующая проверка мерила бы чужой рантайм.
let СЧЁТ = null;
let ЦЕЛОЕ = null;
let ПРОЕКЦИЯ = null;

function поднять(файл) {
  const байты = new Uint8Array(readFileSync(файл));
  if (байты.length > 19 && (байты[18] === 2 || байты[19] === 2)) {
    throw new Error(`База ${файл} в режиме WAL -- в память такая не поднимается`);
  }
  const h = new sqlite3.oo1.DB(":memory:");
  const p = sqlite3.wasm.allocFromTypedArray(байты);
  sqlite3.capi.sqlite3_deserialize(
    h.pointer, "main", p, байты.length, байты.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  return h;
}

/** Кадр -- полями, а не объектом: за проводом едут данные. */
function кадр(f) {
  return f && {
    id: f.id, view: f.viewName, record_id: f.recordId ?? null,
    label: f.label ?? null, title: f.title ? undefined : undefined,
    is_draft: Boolean(f.draft), tree: f.tree ?? null,
  };
}

function нужнаМодель(имя) {
  const m = rt.model(имя);
  if (!m) throw new Error(`Нет модели ${имя}`);
  return m;
}

/**
 * Логика приложения -- тем же ходом, что на устройстве (`worker.js`).
 *
 * Без неё проверки слоя логики мерили бы рантайм без логики и молча проходили:
 * кнопка «выполнено» просто ничего бы не делала, а поле-объявление отдавало бы
 * пустоту.
 */
async function подключитьЛогику(схема, модели) {
  if (!logic.manifests(db).length) return null;
  const docs = Object.fromEntries(схема.models.map((m) => [m.name, m]));
  const api = new logic.Api(db, Object.values(модели), { docs });
  await logic.register(db, api);
  db.validator = logic.validator(api);
  return api;
}

const ОПЕРАЦИИ = {
  open: async (файл, экраны) => {
    db = new Database(поднять(файл), { sqlite3, journal: "MEMORY" });
    const схема = loadSchema(db);
    const модели = makeModels(схема);
    if (Object.keys(модели).length) db.ensureSchema(Object.values(модели));
    rt = new Runtime({ documents: loadDocuments(db), models: модели, db,
                       screens: экраны || [],
                       logic: await подключитьЛогику(схема, модели) });
    ЧЕРНОВИКИ.clear();
    return rt.boot();
  },
  //: Действия логики -- по именам: сами обработчики за провод не проходят.
  logic_actions: () => (rt.logic ? Object.keys(rt.logic.actions).sort() : null),
  snapshot: () => rt.snapshot(),
  dispatch: (событие) => rt.dispatch(событие),
  stack: () => rt.stack.map(кадр),
  current: () => кадр(rt.current()),
  touch: (модель) => { rt.touch(нужнаМодель(модель)); return true; },
  push: (вид, опции) => кадр(rt.push(вид, опции || {})),
  pop: () => { rt.pop(); return rt.stack.map(кадр); },
  //: `findList` отдаёт пару (кадр, состояние списка) -- как питоновский.
  //: По проводу едет то, о чём проверки спрашивают: чей это кадр и тот ли это
  //: список.
  find_list: (listId) => {
    const [кадрСписка, состояние] = rt.findList(listId);
    return { screen_id: кадрСписка.id, view: кадрСписка.viewName,
             list_id: состояние && состояние.node ? состояние.node.id : null };
  },
  screen_state: (screenId) => {
    const э = rt.screenById(screenId);
    return э ? э.stateValues() : null;
  },
  count: (модель) => db.count(нужнаМодель(модель)),
  all: (модель) => db.all(нужнаМодель(модель)),
  read: (модель, id) => db.read(нужнаМодель(модель), id),
  create: (модель, значения) => db.create(нужнаМодель(модель), значения),
  write: (модель, id, значения) => db.write(нужнаМодель(модель), id, значения),
  commit: () => { db.commit(); return true; },
  models: () => Object.keys(rt.models || {}),
  //: Действие логики по имени -- ради отказа, называющего известные имена.
  logic_action: (имя) => { rt.logicAction(имя); return true; },
  //: Позвать действие **по-настоящему**. Проверить, что оно объявлено, мало:
  //: правило «пишет только разрешённое» живёт в исполнении, и до 21.08.2026
  //: его на устройстве не сторожил никто -- снятый список разрешённых полей
  //: оставлял всю сюиту зелёной (проверено мутацией).
  //:
  //: Действие на JavaScript исполняется самим движком, поэтому Pyodide здесь
  //: не нужен. Питоновскому он нужен, и в node его не поднять: `import()` там
  //: принимает `file:`, а `fetch` -- `http:`, и одного значения, годного обоим,
  //: не существует (замерено).
  run_logic: async (имя, ids) => await rt.logicAction(имя)({ ids }),

  // -- черновик: то, чего нет в таблице, пока его не сохранили -------------
  draft_new: (имя, модель) => {
    ЧЕРНОВИКИ.set(имя, new Draft(нужнаМодель(модель)));
    return имя;
  },
  draft_read: (имя) => ЧЕРНОВИКИ.get(имя).read(),
  draft_write: (имя, значения) => { ЧЕРНОВИКИ.get(имя).write(значения); return true; },
  draft_touched: (имя) => ЧЕРНОВИКИ.get(имя).touched(),
  draft_rev: (имя) => ЧЕРНОВИКИ.get(имя).rev.peek(),
  draft_values: (имя) => ЧЕРНОВИКИ.get(имя).values,
  draft_save: (имя) => ЧЕРНОВИКИ.get(имя).save(db),
  //: Поле связи живёт у **потомка** (`TodoLine.tag`), а не у родителя: ключ
  //: родителя проставляется в него после вставки.
  draft_add_child: (родитель, поле, ребёнок) => {
    const д = ЧЕРНОВИКИ.get(ребёнок);
    const f = д.model.fields[поле];
    if (!f) throw new Error(`У ${д.model.name} нет поля ${поле}`);
    ЧЕРНОВИКИ.get(родитель).children.push([f, д]);
    return true;
  },
  //: Условие, которое правило **не пустило** в SQL, -- и то, что вышло бы,
  //: пусти оно. Обе половины отвечает та же сторона, что и решает.
  condition_column: (модель, узел) => {
    const m = нужнаМодель(модель);
    return conditionColumn(узел, m, new QueryContext(m));
  },
  //: Тот же вопрос, посчитанный двумя дорогами на одних записях: колонкой в
  //: SQL и построчно. Расхождение на пустой колонке и есть оправдание отказа.
  both_ways: (модель, узел) => {
    const m = нужнаМодель(модель);
    const ctx = new QueryContext(m);
    const [where, params] = compileDomain(узел, ctx);
    const колонка = [`(CASE WHEN ${where} THEN 1 ELSE 0 END)`, params];
    const [sql, всеПараметры] = buildSelect(
      m, ctx, [], `${ctx.alias}."id" ASC`,
      { columns: [[ctx.column(m.fields.id), []], колонка] });
    const вSql = {};
    for (const строка of db.select(sql, всеПараметры)) вSql[строка[0]] = Boolean(строка[1]);
    const вПитоне = {};
    for (const r of db.all(m)) вПитоне[r.id] = Boolean(evaluate(узел, { record: r }));
    return { sql: вSql, построчно: вПитоне };
  },

  // -- какой дорогой список прочитал строки ------------------------------
  paths_start: () => {
    СЧЁТ = { select: 0, query: 0 };
    ЦЕЛОЕ = { select: db.select.bind(db), query: db.query.bind(db) };
    db.select = (sql, params) => { СЧЁТ.select += 1; return ЦЕЛОЕ.select(sql, params); };
    db.query = (m, sql, params, extra) => {
      СЧЁТ.query += 1; return ЦЕЛОЕ.query(m, sql, params, extra);
    };
    return true;
  },
  paths_stop: () => {
    const было = СЧЁТ;
    if (ЦЕЛОЕ) { db.select = ЦЕЛОЕ.select; db.query = ЦЕЛОЕ.query; }
    СЧЁТ = ЦЕЛОЕ = null;
    return было;
  },
  //: Перерисовать верхний кадр -- то, что делает эффект экрана, когда данные
  //: под ним сдвинулись. Проверка путей меряет именно одну перерисовку.
  rerender: () => { rt.stack[rt.stack.length - 1]._render(); return true; },
  projection_off: () => {
    ПРОЕКЦИЯ = RowPlan.prototype.projection;
    RowPlan.prototype.projection = () => null;
    return true;
  },
  projection_on: () => {
    if (ПРОЕКЦИЯ) RowPlan.prototype.projection = ПРОЕКЦИЯ;
    ПРОЕКЦИЯ = null;
    return true;
  },

  //: Кадр с черновиком открывается **через рантайм**, а не сборкой объекта
  //: снаружи: именно так его открывает приложение.
  push_draft: (вид, модель) => кадр(rt.push(вид, { draft: new Draft(нужнаМодель(модель)) })),
  frame_draft_values: (screenId) => {
    const f = rt.stack.find((x) => x.id === screenId);
    return f && f.draft ? f.draft.values : null;
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
    ответ = { ok: (await f(...(args || []))) ?? null };
  } catch (err) {
    ответ = { error: { name: (err && err.name) || "Error",
                       message: String((err && err.message) || err) } };
  }
  process.stdout.write(JSON.stringify(ответ) + "\n");
}

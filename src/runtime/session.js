/**
 * Рантайм: экраны, запросы, события и дерево отрисовки.
 *
 * Экран -- один развёрнутый документ вида. У каждого свой эффект, который
 * обходит документ и превращает его в дерево, подставляя живые значения. Обход
 * читает сигналы -- состояние экрана, состояние списков, ревизии таблиц, --
 * поэтому эффект перезапускается сам, как только что-нибудь из этого сдвинется.
 * Никакого `refresh()` в приложении нет и быть не должно.
 *
 * Отличие от питона ровно одно: там дерево строится из объектов узлов, здесь --
 * из документа. Из этого следует то, что стоило дороже всего:
 *
 *     **часть поведения в питоне живёт не в документе, а в `ir()`.**
 *
 * `ir()` там зовётся дважды -- один раз чтобы сделать документ, второй раз уже
 * после разворота, -- и на втором проходе применяются правила, которых в
 * документе не видно. Колонки таблицы, поле-ручка, кнопка свайпа и подпись
 * поиска вычисляются из вида строки, а вид строки в момент сборки документа
 * ещё не построен, поэтому в документе они пустые. Здесь их приходится
 * досчитывать -- см. `listShape` ниже. Всё, что решается «по дороге», обязано
 * быть либо в документе, либо одинаково реализовано в обоих рантаймах;
 * третьего не дано, и молчаливое расхождение тут -- самый вероятный способ
 * всё испортить.
 */

import { evaluate, UNSET } from "../expr.js";
import { computedColumns, declarationOf, modelsRead } from "../rel/fields.js";
import { expand } from "./expand.js";
import { bindArgs, resultKey } from "./logic.js";
import { Effect, Signal, batch } from "./signal.js";
import {
  QueryContext, SearchSpec, buildSelect, compileDomain, compileOrder,
} from "./query.js";

export class OneFrameworkError extends Error {}

//: Контейнеры, которые только проносят детей и сохраняют собственный ir.
const CONTAINERS = new Set(["row", "col", "group", "accordion", "tabs", "tab", "menu"]);

//: Типы полей, которые в таблице встают по правому краю...
const NUMERIC_TYPES = new Set(["integer", "float", "monetary", "duration"]);
//: ...но только когда ячейка -- само число. Степпер или ряд звёзд -- это
//: управление, и оно выравнивается влево, как всё остальное.
const NUMERIC_WIDGETS = new Set(["number", "monetary", "percent", "duration"]);

/** Каждый узел поддерева документа, включая висящее сбоку от списка. */
function* walkDoc(node) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walkDoc(item);
    return;
  }
  if (typeof node.type === "string") yield node;
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") yield* walkDoc(value);
  }
}

/**
 * Действие так, как оно едет на провод.
 *
 * Третий случай того же расхождения, что и `listShape`: в документе действие
 * несёт **объявление** -- какую модель удалять, какой вид открывать, чем
 * заполнять новую запись, -- а на проводе от него остаётся только то, что
 * нужно нарисовать. Цель действия рендереру не нужна и не должна быть видна:
 * нажатие возвращается сюда номером кнопки, и решает всё равно рантайм.
 *
 * Питон получает эту разницу даром, потому что зовёт `ir()` без `ctx`. Здесь
 * документ один, и проекцию приходится делать руками -- иначе объявления
 * протекли бы на провод, и `protocol/wire.json` перестал бы описывать то, что
 * по нему едет.
 */
function actionForWire(action) {
  if (!action) return action;
  if (action.type === "delete") {
    return { type: "delete", confirm: action.confirm, swipe: Boolean(action.swipe) };
  }
  if (action.type === "set") {
    return { type: "set", field: action.field, scope: action.scope, value: action.value };
  }
  return { type: action.type };
}

//: Закрывает ли действие экран. В питоне это свойство класса действия; здесь --
//: список, потому что документ несёт только тип. `set` сюда не входит намеренно.
const CLOSES_SCREEN = new Set(["delete", "save"]);

/** Условие узла, отвечённое записью и состоянием экрана. */
function isTrue(condition, record, viewState) {
  if (typeof condition === "boolean") return condition;
  if (condition === null || condition === undefined) return true;
  return Boolean(evaluate(condition, { record: record || {}, view: viewState || {} }));
}

// --------------------------------------------------------------------------
// форма списка: то, что питон досчитывает вторым вызовом ir()
// --------------------------------------------------------------------------
/**
 * Колонки, поле-ручка, свайп и подпись поиска -- всё, что список знает про себя
 * только через вид строки.
 *
 * В документе они пустые не по недосмотру: документ собирается для никого, а
 * вид строки строится, когда список рисуют. Питон в этот момент зовёт `ir()`
 * второй раз и получает их заполненными; здесь -- эта функция.
 */
export function listShape(listDoc, itemDoc) {
  const shape = {
    columns: [], handleField: null, handleHidden: false,
    swipeDelete: null, swipeLabel: null,
  };
  if (!itemDoc) return shape;

  let handle = null;
  let swipe = null;
  for (const node of walkDoc(itemDoc)) {
    if (!handle && node.type === "field" && node.widget === "handle") handle = node;
    if (!swipe && node.type === "button" && node.action && node.action.swipe) swipe = node;
  }
  shape.handleField = handle ? handle.name : null;
  shape.handleHidden = handle ? handle.visible === false : false;
  shape.swipeDelete = swipe ? swipe.id : null;
  shape.swipeLabel = swipe ? swipe.label : null;

  // По умолчанию колонки -- это и есть вид строки: что строка показывает в ряд,
  // то таблица показывает колонками, и приложение не описывает свой список
  // дважды.
  let children = listDoc.column_nodes || [];
  if (!children.length) {
    children = itemDoc.children || [];
    if (children.length === 1 && children[0].type === "row") {
      children = children[0].children || [];
    }
  }
  shape.columns = children.map((node) => {
    let label = "";
    let numeric = false;
    if (node.type === "field") {
      if (node.widget === "handle") label = "";
      else label = node.label ?? "";
      numeric = NUMERIC_TYPES.has(node.ftype) && NUMERIC_WIDGETS.has(node.widget);
    }
    return { id: node.id, label, numeric };
  });
  return shape;
}

/** `Sort` имеет смысл тянуть руками только когда он и есть поле-ручка по возрастанию. */
function isReorderable(sortDoc, handleName) {
  if (!handleName || !sortDoc.orders || sortDoc.orders.length !== 1) return false;
  const order = sortDoc.orders[0];
  const dir = order.dir ?? "asc";
  const ref = order.order ?? order;
  return dir === "asc" && ref && ref.r === handleName;
}

// --------------------------------------------------------------------------
// строка списка: описание отдельно, значения отдельно
// --------------------------------------------------------------------------
/**
 * Описание строки и гнёзда, которые заполняет запись.
 *
 * Держать двое врозь -- весь смысл: описание -- факт о **виде**, и едет один
 * раз; гнёзда -- факты о записях, и едут числами. Какое гнездо чьё, написано в
 * самом описании -- `"bind": {"value": 3}` на том узле, которому оно нужно, --
 * поэтому ничего не приходится сопоставлять ни по позиции, ни по
 * договорённости.
 */
//: Вывезен наружу ради проверки путей выборки: она снимает проекцию и
//: сверяет, что построчный путь даёт тот же вектор. Иначе о втором пути
//: можно судить только по тому, что первый не сработал.
export class RowPlan {
  constructor() {
    this.slots = [];
    this.template = null;
  }

  slot(kind, field = null, expr = null) {
    this.slots.push({ kind, field, expr });
    return this.slots.length - 1;
  }

  /** `visible=` / `enabled=`: ответ сразу, либо гнездо. */
  condition(value, bind, key) {
    if (typeof value === "boolean") return value;
    bind[key] = this.slot("condition", null, value);
    return null;
  }

  /**
   * SELECT, отвечающий на каждое гнездо, либо `null`, если SQL не может.
   *
   * Правило, на котором всё держится: переспросить условие у таблицы можно
   * только тогда, когда оно говорит о её же колонках. `record.*` говорит;
   * `view.*` компилятор уже подставил значением, `item.*` -- разворот. Всё
   * прочее -- колонка другой модели, связь, которая вообще не колонка, --
   * этот SELECT не увезёт, и список читает записи целиком.
   *
   * Ещё два отказа, оба про NULL. Условие, части которого сворачиваются в «нет
   * ограничения» (невыбранное `view.`), в проекции значит не то же, что в
   * WHERE. И SQL отвечает NULL -- ни истиной, ни ложью, -- там, где `evaluate`
   * отвечает булевым; какие условия от этого защищены, решает `sqlBoolean`.
   */
  projection(model, qctx) {
    const columns = [[qctx.column(model.fields.id), []]];
    for (const slot of this.slots) {
      if (slot.kind === "value") {
        if (!slot.field || slot.field.stored === false) return null;
        columns.push([qctx.column(slot.field), []]);
      } else if (slot.kind === "condition") {
        const part = conditionColumn(slot.expr, model, qctx);
        if (part === null) return null;
        columns.push(part);
      } else {
        return null;      // связь или имя, собранное не в SQL
      }
    }
    return columns;
  }

  /** Одна строка проекции как вектор, который едет на проводе. */
  decode(raw) {
    return this.slots.map((slot, index) => (
      slot.kind === "value" ? slot.field.fromDb(raw[index + 1]) : Boolean(raw[index + 1])
    ));
  }
}

/** Каждая ссылка условия: `record.` именем, всё прочее -- как есть. */
function conditionRefs(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) conditionRefs(item, out);
    return out;
  }
  if (!("op" in node)) {
    if ("r" in node) return out.push({ record: node.r }), out;
    if ("v" in node) return out.push({ view: node.v }), out;
    if ("i" in node) return out.push({ item: node.i }), out;
  }
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") conditionRefs(value, out);
  }
  return out;
}

/**
 * Отвечает ли это условие в SQL заведомо «да» или «нет», а не NULL.
 *
 * Причина отказа настоящая: `evaluate` отвечает булевым всегда, а SQL на
 * сравнение с пустым краем отвечает **неизвестностью**, и `CASE WHEN NULL THEN
 * 1 ELSE 0 END` делает из неё ноль. Проверено на живой базе: у строки с пустым
 * `a` выражение `a != 1` даёт NULL, колонка даёт 0 (=ложь), а `evaluate` на
 * том же месте отвечает true.
 *
 * Но отказ идёт **по форме выражения, а не поимённо**: есть формы, где пустота
 * -- сам предмет вопроса и неизвестности не возникает.
 *
 * * `IS NULL` -- SQLite отвечает на него 0 или 1 при любом содержимом колонки,
 *   и это ровно то, что считает `evaluate`;
 * * `NOT` над безопасным -- `NOT 0/1` снова 0/1;
 * * `AND`/`OR`, у которых безопасны **все** части: хватило бы одной небезопасной
 *   (`NULL AND 1` -- это опять NULL), поэтому здесь `every`.
 */
function sqlBoolean(node, model) {
  const op = node !== null && typeof node === "object" && !Array.isArray(node) ? node.op : null;
  if (op === "null") return ownColumns(node.e, model, true);
  if (op === "!") return sqlBoolean(node.e, model);
  if (op === "&" || op === "|") return (node.p || []).every((p) => sqlBoolean(p, model));
  return ownColumns(node, model, false);
}

/** Ссылки узла: только свои колонки; пустые -- если разрешено. */
function ownColumns(node, model, nullable) {
  for (const ref of conditionRefs(node)) {
    if ("view" in ref) continue;
    if (!("record" in ref)) return false;
    const field = model.fields[ref.record];
    if (!field) return false;                // колонка не этой таблицы
    if (!nullable && field.default() === null) return false;  // бывает NULL
  }
  return true;
}

/** `visible=` как колонка SELECT, либо `null`, если ею быть не может. */
//: Наружу -- ради проверки, которая оправдывает сам отказ замером: она
//: собирает ту колонку, которую правило не пустило, и показывает, что SQL и
//: построчный счёт на ней правда расходятся.
export function conditionColumn(expr, model, qctx) {
  if (!sqlBoolean(expr, model)) return null;
  let sql;
  let params;
  try {
    [sql, params] = compileDomain(expr, qctx);
  } catch (err) {
    return null;
  }
  if (sql === null || sql === undefined) return null;
  return [`(CASE WHEN ${sql} THEN 1 ELSE 0 END)`, params];
}

// --------------------------------------------------------------------------
// состояние
// --------------------------------------------------------------------------
class ListState {
  constructor(node) {
    this.node = node;
    const search = node.search;
    this.text = new Signal("", `${node.id}.text`);
    this.filter = new Signal(
      search ? search.default_filter : null, `${node.id}.filter`);
    this.sort = new Signal(search ? search.default_sort : null, `${node.id}.sort`);
    //: сколько строк загружено; растёт по мере прокрутки
    this.limit = new Signal(node.page_size, `${node.id}.limit`);
  }
}

/**
 * Запись, которой ещё нет. Так устроены обе платформы: значения живут вне
 * хранилища, пока человек не сохранит, -- дочерний контекст в Core Data,
 * ViewModel на Android, виртуальная запись в Odoo.
 */
export class Draft {
  constructor(model, values = null, name = "draft") {
    this.model = model;
    this.values = { ...(values || {}) };
    //: (поле связи, черновик потомка) -- вставляется после того, как у
    //: родителя появится ключ
    this.children = [];
    this.rev = new Signal(0, `${name}.rev`);
  }

  read() {
    this.rev.get();
    const row = {};
    for (const [name, field] of Object.entries(this.model.fields)) {
      row[name] = field.default();
    }
    Object.assign(row, this.values);
    row.id = null;
    return row;
  }

  write(values) {
    Object.assign(this.values, values);
    this.rev.set(this.rev.peek() + 1);
  }

  touched() {
    return Object.keys(this.values).length > 0 || this.children.length > 0;
  }

  save(db) {
    const recordId = db.create(this.model, this.values);
    for (const [field, child] of this.children) {
      child.values[field.name] = recordId;
      child.save(db);
    }
    return recordId;
  }
}

class RenderCtx {
  constructor({ screen, model, record, inRow, relCache = null,
                stateOverride = null, pane = null, viewState = null }) {
    this.screen = screen;
    this.model = model;
    this.record = record;
    this.inRow = inRow;
    this.relCache = relCache === null ? {} : relCache;
    this.viewState = viewState === null ? {} : viewState;
    this.stateOverride = stateOverride || {};
    this.pane = pane;
  }

  child(kw) {
    return new RenderCtx({
      screen: this.screen, model: this.model, record: this.record,
      inRow: this.inRow, relCache: this.relCache,
      stateOverride: this.stateOverride, pane: this.pane,
      viewState: this.viewState, ...kw,
    });
  }
}

// --------------------------------------------------------------------------
// кадр
// --------------------------------------------------------------------------
export class Frame {
  constructor(runtime, viewName, { recordId = null, screenId = null,
              createdNew = false, screenKey = null, draft = null,
              target = "page" } = {}) {
    this.rt = runtime;
    this.viewName = viewName;
    this.doc = runtime.document(viewName);
    this.recordId = recordId;
    this.id = screenId;
    this.createdNew = createdNew;
    this.target = target;
    this.draft = draft;
    this.screenKey = screenKey;
    this.label = null;
    this.model = this.doc.model ? runtime.models[this.doc.model] : null;

    this.state = {};
    for (const decl of this.doc.state || []) {
      this.state[decl.name] = new Signal(UNSET, `${viewName}.${decl.name}`);
    }
    this.stateFields = {};
    for (const decl of this.doc.state || []) this.stateFields[decl.name] = decl;

    this.lists = {};
    this.tabFields = [];
    this.buttons = {};
    this.tree = null;
    this.error = null;
    this.effect = new Effect(() => this._render(), `screen:${this.id}`,
                             (err) => this._onError(err));
  }

  /** Запомнить узлы, до которых отрисовка обязана достучаться по номеру. */
  scan(root) {
    for (const node of walkDoc(root)) {
      if (node.type === "list") {
        // Переживает перестройку: номер -- это место в дереве, поэтому список
        // сохраняет свой фильтр, сортировку и загруженное окно.
        if (!(node.id in this.lists)) this.lists[node.id] = new ListState(node);
        else this.lists[node.id].node = node;
      } else if (node.type === "button") {
        this.buttons[node.id] = node;
      } else if (node.type === "field" && node.widget === "tabs") {
        if (!this.tabFields.includes(node.name)) this.tabFields.push(node.name);
      }
    }
  }

  stateValues() {
    const out = {};
    for (const [name, sig] of Object.entries(this.state)) out[name] = sig.get();
    return out;
  }

  record() {
    if (this.draft !== null) return this.draft.read();
    if (this.recordId === null || this.model === null) return null;
    this.rt.tableSignal(this.model).get();
    return this.rt.db.read(this.model, this.recordId);
  }

  /** Экран записи называется записью -- через поле показа модели. */
  title(record) {
    const own = this.doc.title;
    // Заголовок-функция в документ не поехал; вид, у которого он есть, ещё
    // программа, и назвать его нечем, кроме собственного имени.
    if (this.doc.title_is_code) return this.viewName;
    if (this.draft !== null) return own;
    // `title = ""` -- вид, который сознательно не хочет заголовка: карточка
    // записи, где запись и есть страница.
    if (own === "") return "";
    if (record !== null && this.model !== null) {
      const name = this.model.displayName(record);
      if (name) return name;
    }
    return this.label || own;
  }

  /**
   * Как называется этот уровень везде, кроме бара.
   *
   * Зеркало `Frame.name` питоновского рантайма -- там разобрано, почему имя
   * отдельно от заголовка: `title = ""` -- это отказ бара, а не отказ кадра от
   * имени, и крошке имя нужно всегда.
   */
  name(record) {
    const shown = this.title(record);
    if (shown) return shown;
    // Черновик записью не считается -- разобрано там же: имени у него ещё нет,
    // а `displayName` на строке без ключа отдаёт заглушку с решёткой.
    if (this.draft === null && record !== null && this.model !== null) {
      const own = this.model.displayName(record);
      if (own) return own;
    }
    return this.viewName;
  }

  _onError(exc) {
    this.error = `${exc.name}: ${exc.message}`;
    this.tree = {
      id: this.id, view: this.viewName, title: this.doc.title,
      name: this.doc.title || this.viewName,
      error: this.error, children: [],
    };
    this.rt._markDirty();
  }

  _render() {
    this.error = null;
    // Дерево делается здесь, внутри эффекта: документ разворачивается на том,
    // что лежит в базе сию секунду, и оба шага читают сигналы -- поэтому экран
    // пересчитывается сам, когда двинется либо состояние, либо данные.
    const root = expand(structuredClone(this.doc), this.rt);
    this.scan(root);
    // У полосы вкладок всегда ровно одна выбрана, поэтому нетронутое состояние
    // открывается на первой записи. Улаживается до отрисовки детей, иначе
    // список ниже отфильтровался бы по UNSET и показал все строки, пока первая
    // вкладка выглядит выбранной.
    for (const name of this.tabFields) {
      const sig = this.state[name];
      if (sig && sig.peek() === UNSET) {
        const choices = this.rt.relationChoices(this.stateFields[name]);
        if (choices.length) sig.set(choices[0].id);
      }
    }
    const ctx = new RenderCtx({
      screen: this, model: this.model, record: this.record(),
      inRow: false, viewState: this.stateValues(),
    });
    const children = (root.children || []).map((n) => this.rt.renderNode(n, ctx));
    // Всё, чему место в верхней панели, вынимается из тела -- как и заголовок:
    // панель деревом не патчится. Туда идут кнопки и поля в одно касание.
    const bar = children.filter((c) =>
      ["navbar", "navbar-left", "fab"].includes(c.place));
    this.tree = {
      id: this.id,
      view: this.viewName,
      title: this.title(ctx.record),
      name: this.name(ctx.record),
      model: this.model ? this.model.name : null,
      record_id: this.recordId,
      // Экран, правящий черновик, -- такой же экран записи, просто ключа ещё
      // нет. Без этого он читался бы как раздел, и поля вышли бы голыми.
      draft: this.draft !== null,
      target: this.target,
      dismiss: this.doc.dismiss ?? "auto",
      crumbs: this.doc.crumbs ?? null,
      children: children.filter((c) => !bar.includes(c)),
      navbar_buttons: bar,
      error: null,
    };
    this.rt._markDirty();
    return this.tree;
  }

  dispose() {
    this.effect.dispose();
  }
}

/**
 * Тот ли это кадр, который называет шаг адреса.
 *
 * Зеркало `_same_place` питоновского рантайма -- там разобрано, почему местом
 * не считаются ни карточка, ни черновик.
 */
function samePlace(frame, step) {
  return frame.draft === null && frame.target === "page"
    && frame.viewName === step.view && frame.recordId === (step.record_id ?? null);
}

// --------------------------------------------------------------------------
// рантайм
// --------------------------------------------------------------------------
export class Runtime {
  constructor({ documents, models, db, screens, emit = null, logic = null }) {
    this.documents = documents;
    this.models = models;
    this.db = db;
    this.screens = screens;
    this.emit = emit || (() => {});
    //: Хост бизнес-логики (`logic.js`, `Api`) или `null`. Приложение без единого
    //: объявленного действия не платит за него ничего.
    this.logic = logic;
    this._tables = {};
    //: по одному стеку на раздел, чтобы переключение сохраняло каждый там, где
    //: его оставили -- ровно то, чего ждут обе платформы
    this.stacks = {};
    this.active = screens.length ? screens[0].key : "";
    this._screenSeq = 0;
    this._dirty = false;
  }

  document(name) {
    const doc = this.documents[name];
    if (!doc) throw new OneFrameworkError(`Нет документа вида ${name}`);
    return doc;
  }

  model(name) {
    if (name === null || name === undefined) return null;
    if (typeof name !== "string") return name;
    const found = this.models[name];
    if (!found) throw new OneFrameworkError(`Неизвестная модель ${name}`);
    return found;
  }

  // -- реактивные ревизии таблиц -----------------------------------------
  tableSignal(model) {
    const key = typeof model === "string" ? model : model.name;
    if (!this._tables[key]) this._tables[key] = new Signal(0, `table:${key}`);
    return this._tables[key];
  }

  touch(model) {
    const sig = this.tableSignal(model);
    sig.set(sig.peek() + 1);
  }

  get stack() {
    if (!this.stacks[this.active]) this.stacks[this.active] = [];
    return this.stacks[this.active];
  }

  screenDef(key) {
    const found = this.screens.find((s) => s.key === key);
    if (!found) throw new OneFrameworkError(`Неизвестный раздел ${key}`);
    return found;
  }

  // -- жизненный цикл -----------------------------------------------------
  boot() {
    batch(() => {
      // Каждый раздел получает свой корневой кадр сразу: переключение потом
      // мгновенно, и каждый помнит, где был.
      for (const screen of this.screens) {
        this.active = screen.key;
        this.push(screen.view, { label: screen.label });
      }
      this.active = this.screens.length ? this.screens[0].key : "";
    });
    this.flushEmit();
    return this.snapshot();
  }

  push(viewName, { recordId = null, createdNew = false, label = null,
                   draft = null, target = "page" } = {}) {
    this._screenSeq += 1;
    const frame = new Frame(this, viewName, {
      recordId, screenId: `s${this._screenSeq}`, createdNew,
      screenKey: this.active, draft, target,
    });
    frame.label = label;
    this.stack.push(frame);
    frame.effect.run();
    this._markDirty();
    return frame;
  }

  pop() {
    if (this.stack.length <= 1) return false;
    const frame = this.stack.pop();
    this._discardIfEmpty(frame);
    frame.dispose();
    this._markDirty();
    return true;
  }

  /** Выбросить только что созданную запись, которую человек оставил пустой. */
  _discardIfEmpty(screen) {
    if (!screen.createdNew || screen.recordId === null) return;
    const model = screen.model;
    const row = this.db.read(model, screen.recordId);
    if (row === null) return;
    const meaningful = model.fieldList.filter(
      (f) => f.stored && !f.system && ["string", "text"].includes(f.ftype));
    const empty = meaningful.every((f) => !String(row[f.name] ?? "").trim());
    if (empty) {
      this.db.unlink(model, screen.recordId);
      this.touch(model);
    }
  }

  current() {
    return this.stack[this.stack.length - 1];
  }

  screenById(screenId) {
    for (const frames of Object.values(this.stacks)) {
      for (const frame of frames) if (frame.id === screenId) return frame;
    }
    throw new OneFrameworkError(`Неизвестный экран ${screenId}`);
  }

  _buttonAnywhere(buttonId) {
    for (const frames of Object.values(this.stacks)) {
      for (const frame of frames) {
        if (buttonId in frame.buttons) return [frame, frame.buttons[buttonId]];
      }
    }
    throw new OneFrameworkError(`Неизвестная кнопка ${buttonId}`);
  }

  /** Найти список, предпочитая активный раздел. */
  findList(listId) {
    const order = [this.active, ...Object.keys(this.stacks).filter((k) => k !== this.active)];
    for (const key of order) {
      const frames = this.stacks[key] || [];
      for (let i = frames.length - 1; i >= 0; i--) {
        if (listId in frames[i].lists) return [frames[i], frames[i].lists[listId]];
      }
    }
    throw new OneFrameworkError(`Неизвестный список ${listId}`);
  }

  // -- выдача -------------------------------------------------------------
  _markDirty() {
    this._dirty = true;
  }

  snapshot() {
    const stacks = {};
    for (const [key, frames] of Object.entries(this.stacks)) {
      stacks[key] = frames.filter((f) => f.tree !== null).map((f) => f.tree);
    }
    return {
      type: "render",
      depth: this.stack.length,
      active: this.active,
      screens: this.screens.map((s) => ({
        key: s.key, label: s.label, icon: s.icon ?? null, view: s.view,
        master_detail: this._masterDetail(s.key),
      })),
      stacks,
    };
  }

  /**
   * Открытая запись встаёт рядом со списком или вместо него. Рядом -- на окне
   * достаточной ширины, так делают обе платформы на планшете. Исключение --
   * список, попросившийся таблицей: таблице нужна вся ширина.
   */
  _masterDetail(key) {
    for (const frame of this.stacks[key] || []) {
      for (const lstate of Object.values(frame.lists)) {
        if (lstate.node.display === "table") return false;
      }
    }
    return true;
  }

  flushEmit() {
    if (!this._dirty) return;
    this._dirty = false;
    this.emit(this.snapshot());
  }

  // -- данные под документом ---------------------------------------------
  // Ровно то, что спрашивает разворот, и всё: строки для повторителя, число
  // для агрегата. Отвечается здесь, а не в expand.js, потому что база только у
  // рантайма -- и потому что чтение отсюда записывает таблицу в зависимости,
  // так что экран разворачивается заново сам, когда данные под ним сдвинутся.
  /**
   * Строки, по которым повторитель рисует копии тела.
   *
   * Объявленные вычисляемые поля едут **колонками этой же выборки**. Раньше
   * каждое спрашивалось отдельно и по одной записи: замерено, 194,8 мс на
   * список из трёхсот.
   */
  records(model, domain = null, order = null) {
    const m = this.model(model);
    this.tableSignal(m).get();
    const ctx = new QueryContext(m);
    const computed = this.computedColumns(m, ctx.alias);
    this.watchSources(m);
    if (!computed.length) {
      // Ни одного объявленного поля -- запрос и вызов те же, что были.
      const [sql, params] = buildSelect(
        m, ctx, [compileDomain(domain, ctx)], compileOrder(order || [], ctx));
      return this.db.query(m, sql, params);
    }
    const columns = Object.values(m.fields)
      .filter((f) => f.stored)
      .map((f) => [`${ctx.alias}."${f.column}"`, []]);
    for (const [name, sql] of computed) columns.push([`${sql} AS "${name}"`, []]);
    const [sql, params] = buildSelect(
      m, ctx, [compileDomain(domain, ctx)], compileOrder(order || [], ctx), { columns });
    return this.db.query(m, sql, params, computed.map(([name]) => name));
  }

  /** Одно объявленное поле одной записи -- тем же выражением, что в списке. */
  /**
   * Подписаться на модели, которые читают формулы этой модели. Без этого
   * готовность списка не обновилась бы при правке задачи.
   */
  watchSources(model) {
    for (const name of modelsRead(model)) {
      if (this.models[name]) this.tableSignal(this.models[name]).get();
    }
  }

  computedOne(model, field, recordId) {
    if (!model) return null;
    this.tableSignal(model).get();
    this.watchSources(model);
    const columns = new Map(this.computedColumns(model, "t"));
    const sql = columns.get(field.name);
    if (!sql) return null;
    const rows = this.db.select(
      `SELECT ${sql} FROM "${model.table}" t WHERE t."id" = ?`, [recordId]);
    return rows.length ? rows[0][0] : null;
  }

  /** Объявленные вычисляемые поля модели, посчитанные один раз на модель. */
  computedColumns(model, alias) {
    this._computedCache ??= new Map();
    const key = `${model.name} ${alias}`;
    if (!this._computedCache.has(key)) {
      const { columns } = computedColumns(model, alias, this.models);
      this._computedCache.set(key, columns);
    }
    return this._computedCache.get(key);
  }

  aggregate(kind, model, domain = null) {
    // Вид умеет спросить только «сколько» и «есть ли»: считает он счётом строк.
    // Сумма и края приезжают колонкой вычисляемого поля, а не сюда. Молча
    // вернуть отсюда количество вместо суммы значило бы показать число,
    // которое выглядит ответом и им не является.
    if (kind !== "count" && kind !== "exists") {
      throw new Error(`агрегат «${kind}» в виде не считается: `
        + "перенесите его в вычисляемое поле модели");
    }
    const m = this.model(model);
    this.tableSignal(m).get();
    const ctx = new QueryContext(m);
    const [where, params] = compileDomain(domain, ctx);
    const count = this.db.countWhere(m, where, params, ctx.alias);
    return kind === "exists" ? Boolean(count) : count;
  }

  matchingIds(model, domain) {
    const m = this.model(model);
    const ctx = new QueryContext(m);
    const [sql, params] = buildSelect(m, ctx, [compileDomain(domain, ctx)], "");
    return this.db.query(m, sql, params).map((r) => r.id);
  }

  // -- отрисовка узлов ----------------------------------------------------
  renderNode(node, ctx) {
    if (CONTAINERS.has(node.type)) {
      const data = { ...node };
      data.children = (node.children || []).map((c) => this.renderNode(c, ctx));
      // Плавающая кнопка вкладки -- не часть её страницы: она висит над
      // экраном, и рендерер берёт её у той вкладки, которая открыта.
      if (node.type === "tab" && node.fab) {
        data.fab = this.renderButton(node.fab, ctx);
      }
      return data;
    }
    if (node.type === "section" || node.type === "text" || node.type === "icon"
        || node.type === "pill") {
      return { ...node };
    }
    if (node.type === "field") return this.renderField(node, ctx);
    if (node.type === "button") return this.renderButton(node, ctx);
    if (node.type === "list") return this.renderList(node, ctx);
    if (node.type === "view") {
      return { type: "view",
               children: (node.children || []).map((c) => this.renderNode(c, ctx)) };
    }
    throw new OneFrameworkError(`Нечем нарисовать узел ${node.type}`);
  }

  renderField(node, ctx) {
    const data = { ...node };
    // `visible=record.done`: ответ принадлежит записи, а один вид строки рисует
    // каждую строку списка -- поэтому спросить можно только здесь. Ячейка,
    // которую не нарисовали, всё равно объявлена: раскладку строки читают по
    // её ячейкам.
    data.visible = isTrue(node.visible, ctx.record, ctx.viewState);
    if (data.scope === "view") {
      const sig = ctx.screen.state[node.name];
      const value = sig ? sig.get() : UNSET;
      data.unset = value === UNSET;
      data.value = value === UNSET ? null : value;
      data.screen_id = ctx.screen.id;
    } else {
      const record = ctx.record;
      data.record_id = record ? record.id ?? null : null;
      data.model = ctx.model ? ctx.model.name : null;
      // У черновика ключа нет, поэтому запись обязана сказать, какой экран его
      // держит.
      data.screen_id = ctx.screen.id;
      data.value = record ? record[node.name] ?? null : null;
      data.unset = false;
    }
    if (!data.visible) return data;
    const declared = ctx.model ? ctx.model.fields[node.name] : null;
    if (declared && declared.compute) {
      // Колонки у такого поля нет: значение спрашивается там, где его рисуют,
      // и потому не бывает вчерашним.
      data.value = this.computed(declared, ctx);
      return data;
    }

    const field = ctx.model ? ctx.model.fields[node.name] : null;
    if (node.ftype === "many2one" || node.ftype === "one2one") {
      data.choices = this.relationChoices(field || node);
      data.related = this.relationDisplay(field || node, data.value, ctx);
    } else if (node.ftype === "one2many" || node.ftype === "many2many") {
      // Виртуальные поля: значение и есть набор связанных записей, поэтому оно
      // читается здесь, а не берётся из строки.
      const rows = this.relationRows(field || node, ctx.record);
      data.value = rows.map((r) => r.id);
      data.related = rows;
      if (node.ftype === "many2many") data.choices = this.relationChoices(field || node);
    }
    return data;
  }

  /** Связанные записи One2many / Many2many как записи показа. */
  relationRows(field, record) {
    if (!record || !record.id) return [];
    const co = field.resolveComodel();
    this.tableSignal(co).get();
    const rows = field.ftype === "many2many"
      ? this.db.readMany2many(field, record.id)
      : this.db.readOne2many(field, record.id);
    return rows.map((r) => this._entry(co, r));
  }

  /** Каждая запись сомодели как `{id, display, color}`. */
  relationChoices(field) {
    const co = this._comodelOf(field);
    if (co === null) return [];
    this.tableSignal(co).get();
    return this.db.all(co, '"id" ASC').map((r) => this._entry(co, r));
  }

  relationDisplay(field, value, ctx) {
    if (!value) return null;
    const co = this._comodelOf(field);
    if (co === null) return null;
    if (!ctx.relCache[co.name]) ctx.relCache[co.name] = {};
    const cache = ctx.relCache[co.name];
    if (!(value in cache)) {
      this.tableSignal(co).get();
      const row = this.db.read(co, value);
      cache[value] = row === null ? null : this._entry(co, row);
    }
    return cache[value];
  }

  _comodelOf(field) {
    if (!field) return null;
    if (typeof field.resolveComodel === "function") return field.resolveComodel();
    // Поле состояния экрана приходит объявлением из документа, а не из модели:
    // у него есть имя сомодели, но нет разрешения. В документе сомодель --
    // объект (`{name, label, display_field, color_field}`), потому что рендерер
    // читает из него подпись и поле показа; имя внутри него, а не вместо него.
    const decl = field.comodel ?? field.comodel_name ?? null;
    const name = decl !== null && typeof decl === "object" ? decl.name : decl;
    return name ? this.model(name) : null;
  }

  _entry(co, row) {
    const shown = co.displayField();
    const color = co.fieldList.find((f) => f.ftype === "color");
    return {
      id: row.id,
      display: (shown ? row[shown.name] : null) || `#${row.id}`,
      color: color ? row[color.name] ?? null : null,
    };
  }

  /** Как кусочек состояния экрана читается заголовком. */
  stateDisplay(ref, screen) {
    const name = ref && (ref.v ?? ref.name);
    const decl = name ? screen.stateFields[name] : null;
    if (!decl) {
      throw new OneFrameworkError(`List(label=...) ссылается на неизвестное состояние ${name}`);
    }
    const value = screen.state[name].get();
    if (value === UNSET || value === null) return null;
    if (decl.ftype === "many2one" || decl.ftype === "one2one") {
      const co = this._comodelOf(decl);
      if (co === null) return null;
      this.tableSignal(co).get();
      const row = this.db.read(co, value);
      return row ? co.displayName(row) : null;
    }
    return String(value);
  }

  renderButton(node, ctx) {
    const data = { ...node };
    data.visible = isTrue(node.visible, ctx.record, ctx.viewState);
    // `enabled=record.title`: может ли экран действовать -- это факт о записи,
    // над которой он действует, поэтому отвечается здесь, с записью в руках, и
    // переспрашивается на каждой букве, как и всё остальное.
    data.enabled = isTrue(node.enabled, ctx.record, ctx.viewState);
    // До первого сохранения удалять нечего. Экран черновика убирает своё
    // удаление, а не предлагает кнопку, которая может только отказать.
    if (node.action && node.action.type === "delete" && !node.action.model
        && ctx.screen.draft !== null && !ctx.inRow) {
      data.enabled = false;
      data.visible = false;
    }
    // Тем же доводом -- действие, которому нужен набор записей, а записи ещё
    // нет. Раньше кнопка оставалась живой и **молча ничего не делала**: логика
    // исправно исполнялась над пустым набором, и объяснить это пользователю
    // было нечем -- ни ответа, ни отказа. Гасим, а не прячем: после
    // сохранения кнопка нужна, и исчезать с карточки ей незачем.
    if (data.enabled && нуженНабор(this, node.action)
        && ((ctx.record || {}).id ?? null) === null) {
      data.enabled = false;
    }
    data.action = actionForWire(node.action);
    data.context = {
      screen_id: ctx.screen.id,
      model: ctx.model ? ctx.model.name : null,
      record_id: (ctx.record || {}).id ?? null,
      in_row: ctx.inRow,
    };
    return data;
  }

  // -- список -------------------------------------------------------------
  renderList(node, ctx) {
    const screen = ctx.screen;
    const itemDoc = node.item ? this.document(node.item) : null;
    const lstate = screen.lists[node.id];
    const model = this.model(node.model);
    this.tableSignal(model).get();

    // Вид строки -- такое же дерево, поэтому строится здесь, один раз на весь
    // список, а не на строку. Сканируется в экран заодно: кнопку удаления,
    // которую несёт строка, знают только здесь, а событие назовёт её номером.
    let itemRoot = null;
    if (itemDoc) {
      itemRoot = expand(structuredClone(itemDoc), this);
      screen.scan(itemRoot);
    }
    const shape = listShape(node, itemRoot);

    const qctx = new QueryContext(model, {
      ...screen.stateValues(), ...ctx.stateOverride,
    });
    const where = [compileDomain(node.domain ?? null, qctx)];

    const search = node.search;
    const activeFilter = lstate.filter.get();
    const activeSort = lstate.sort.get();
    const text = lstate.text.get();

    let orders;
    if (search) {
      if (activeFilter !== null && activeFilter >= 0
          && activeFilter < search.filters.length) {
        where.push(compileDomain(search.filters[activeFilter].domain ?? null, qctx));
      }
      where.push(new SearchSpec(search.fields, text).compile(qctx));
      orders = (activeSort !== null && activeSort >= 0 && activeSort < search.sorts.length)
        ? search.sorts[activeSort].orders || []
        : [];
    } else {
      orders = node.order || [];
    }

    const orderSql = compileOrder(orders, qctx);
    // Берётся на строку больше окна, чтобы «есть ли ещё» не требовало COUNT.
    const limit = lstate.limit.get();
    const plan = this.rowPlan(node, itemRoot, ctx, model);
    let rows = this._rowValues(plan, model, qctx, where, orderSql, limit, ctx);
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);

    let reorderable = false;
    if (shape.handleField && search && activeSort !== null) {
      if (activeSort >= 0 && activeSort < search.sorts.length) {
        reorderable = isReorderable(search.sorts[activeSort], shape.handleField);
      }
    } else if (shape.handleField && !search) {
      // Явный `order=` -- это приложение, назвавшее последовательность, и
      // перетаскивание против неё отменил бы следующий же запрос.
      reorderable = !(node.order && node.order.length);
    }

    const data = { ...node };
    delete data.domain;
    delete data.order;
    delete data.column_nodes;
    data.columns = shape.columns;
    data.handle_field = shape.handleField;
    data.handle_hidden = shape.handleHidden;
    data.swipe_delete = shape.swipeDelete;
    data.swipe_label = shape.swipeLabel;
    if (search) {
      data.search = {
        ...search,
        filters: search.filters.map((f) => {
          const copy = { ...f };
          delete copy.domain;
          return copy;
        }),
        sorts: search.sorts.map((s) => {
          const copy = { ...s, reorderable: isReorderable(s, shape.handleField) };
          delete copy.orders;
          return copy;
        }),
      };
    }
    data.state = { text, filter: activeFilter, sort: activeSort };
    data.reorderable = reorderable;
    data.screen_id = screen.id;
    data.pane = ctx.pane;
    // `List(label=view.board)` называет заголовок тем, на что это состояние
    // указывает, поэтому заголовок следует за вкладкой, на которой человек.
    if (node.label && typeof node.label === "object" && "v" in node.label) {
      data.label = this.stateDisplay(node.label, screen);
    }
    if (node.menu) {
      data.menu = {
        ...node.menu,
        children: (node.menu.children || []).map((b) => this.renderButton(b, ctx)),
      };
    }
    data.count = rows.length;
    data.has_more = hasMore;
    data.limit = limit;

    data.row = plan.template;
    data.rows = rows;
    return data;
  }

  // -- одно описание строки, много векторов значений -----------------------
  /**
   * Документ строки, нарисованный один раз, и гнёзда, которые заполняет запись.
   *
   * Различались считанные ответы. Поэтому описание едет один раз, на списке, а
   * запись -- это вектор этих ответов.
   */
  rowPlan(node, itemRoot, ctx, model) {
    const screen = ctx.screen;
    const plan = new RowPlan();
    const rowCtx = new RenderCtx({
      screen, model, record: null, inRow: true, viewState: ctx.viewState,
    });
    const children = itemRoot
      ? (itemRoot.children || []).map((c) => this._rowNode(c, rowCtx, plan))
      // Вида строки нет: строка -- это имя записи, а имя такое же значение, как
      // всякое другое, и занимает собственное гнездо.
      : [{ type: "text", id: null, value: null, bind: { value: plan.slot("display") } }];
    const cells = (node.column_nodes && node.column_nodes.length)
      ? node.column_nodes.map((c) => this._rowNode(c, rowCtx, plan))
      : null;
    plan.template = { children, cells, openable: node.open !== null };
    return plan;
  }

  _rowNode(n, ctx, plan) {
    if (CONTAINERS.has(n.type)) {
      const data = { ...n };
      data.children = (n.children || []).map((c) => this._rowNode(c, ctx, plan));
      if (n.type === "tab" && n.fab) data.fab = this._rowNode(n.fab, ctx, plan);
      return data;
    }
    if (n.type === "section" || n.type === "text" || n.type === "icon" || n.type === "pill") {
      return { ...n };
    }
    if (n.type === "field") return this._rowField(n, ctx, plan);
    if (n.type === "button") return this._rowButton(n, ctx, plan);
    throw new OneFrameworkError(
      `${n.type} не может стоять внутри строки списка: одно описание строки `
      + "рисует каждую запись, а этому узлу нужен свой на запись",
    );
  }

  _rowField(n, ctx, plan) {
    const data = { ...n };
    const bind = {};
    data.visible = plan.condition(n.visible, bind, "visible");
    const field = ctx.model ? ctx.model.fields[n.name] : null;
    if (data.scope === "view") {
      // Состояние экрана -- одно значение на весь список, поэтому здесь ответ,
      // а не гнездо.
      const sig = ctx.screen.state[n.name];
      const value = sig ? sig.get() : UNSET;
      data.unset = value === UNSET;
      data.value = value === UNSET ? null : value;
      data.screen_id = ctx.screen.id;
    } else {
      // Запись, которой принадлежит ячейка, -- это ключ самой строки, поэтому
      // он связывается, а не повторяется: рендерер подставит `record_id`.
      data.record_id = null;
      data.model = ctx.model ? ctx.model.name : null;
      data.screen_id = ctx.screen.id;
      data.unset = false;
      if (n.ftype === "one2many" || n.ftype === "many2many") {
        // Виртуальные поля: значение и есть набор связанных записей, а это
        // чтение на запись -- гнездо заполняется построчно, и список теряет
        // путь в один запрос.
        data.value = null;
        bind.value = plan.slot("relation", field || n);
        data.related = null;
        bind.related = plan.slot("related", field || n);
      } else {
        data.value = null;
        bind.value = plan.slot("value", field || n);
      }
    }
    if (n.ftype === "many2one" || n.ftype === "one2one" || n.ftype === "many2many") {
      // Перечень значений связи принадлежит списку, а не строке: каждая запись
      // везла один и тот же перечень. `related` рендерер читает по нему --
      // значение указывает в таблицу, которая уже здесь.
      data.choices = this.relationChoices(field || n);
    }
    if (data.scope === "view" && (n.ftype === "many2one" || n.ftype === "one2one")) {
      data.related = this.relationDisplay(field || n, data.value, ctx);
    }
    if (Object.keys(bind).length) data.bind = bind;
    return data;
  }

  _rowButton(n, ctx, plan) {
    const data = { ...n };
    const bind = {};
    data.visible = plan.condition(n.visible, bind, "visible");
    data.enabled = plan.condition(n.enabled, bind, "enabled");
    data.action = actionForWire(n.action);
    data.context = {
      screen_id: ctx.screen.id,
      model: ctx.model ? ctx.model.name : null,
      record_id: null,
      in_row: true,
    };
    if (Object.keys(bind).length) data.bind = bind;
    return data;
  }

  /** Векторы значений -- одним запросом там, где один запрос может ответить. */
  _rowValues(plan, model, qctx, where, orderSql, limit, ctx) {
    const columns = plan.projection(model, qctx);
    if (columns !== null) {
      const [sql, params] = buildSelect(model, qctx, where, orderSql,
                                        { limit: limit + 1, columns });
      const idField = model.fields.id;
      return this.db.select(sql, params).map((r) => ({
        id: idField.fromDb(r[0]), v: plan.decode(r),
      }));
    }
    // Построчный путь: что-то в этой строке нельзя спросить у одной таблицы --
    // one2many -- это отдельное чтение, невыбранное `view.` не компилируется ни
    // во что, -- поэтому записи берутся целиком и гнёзда отвечаются здесь.
    const [sql, params] = buildSelect(model, qctx, where, orderSql, { limit: limit + 1 });
    return this.db.query(model, sql, params)
      .map((r) => ({ id: r.id, v: this._rowVector(plan, model, r, ctx) }));
  }

  _rowVector(plan, model, record, ctx) {
    const out = [];
    const relations = {};
    for (const slot of plan.slots) {
      if (slot.kind === "value") {
        out.push(record[slot.field.name] ?? null);
      } else if (slot.kind === "condition") {
        out.push(isTrue(slot.expr, record, ctx.viewState));
      } else if (slot.kind === "display") {
        out.push(model.displayName(record));
      } else {
        const key = slot.field.name;
        if (!(key in relations)) relations[key] = this.relationRows(slot.field, record);
        const linked = relations[key];
        out.push(slot.kind === "relation" ? linked.map((r) => r.id) : linked);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // события
  // ------------------------------------------------------------------
  /**
   * Одно событие -- одна транзакция.
   *
   * Обработчик почти никогда не пишет одну строку: удаление чистит ссылки,
   * перестановка переписывает порядок всему списку, сохранение черновика
   * вставляет и родителя, и потомков. Упади оно на середине без этой границы --
   * половина написанного осталась бы, и осталась бы молча.
   */
  dispatch(event) {
    const name = event.type;
    const handler = this[`on_${name}`];
    if (typeof handler !== "function") throw new OneFrameworkError(`Неизвестное событие ${name}`);
    let ответ = null;
    batch(() => {
      this.db.transaction(() => { ответ = handler.call(this, event); });
    });
    // Действие, которое считает секунду, обязано отвечать в два приёма.
    // Питон поднимается 1--2 с, и держать всё это время открытую транзакцию
    // нельзя: она заблокировала бы базу. Поэтому ждём **снаружи** неё, а
    // записанное действием перерисовываем, когда оно вернётся.
    if (ответ && typeof ответ.then === "function") {
      return ответ.then(() => {
        batch(() => {
          for (const имя of Object.keys(this.models)) this.touch(имя);
        });
        this.flushEmit();
        // Кадр отсюда уходит настоящий -- значение в нём уже новое. А вот
        // **открытая карточка** его не показывает до перезахода: это отдельная
        // недоделка, и она не здесь. Проверено: значение в базе устройства
        // есть, после перезагрузки видно.
        return this.snapshot();
      });
    }
    this.flushEmit();
    return this.snapshot();
  }

  on_switch_screen(ev) {
    const key = ev.key;
    this.screenDef(key);
    if (key !== this.active) {
      this.active = key;
      this._markDirty();
    }
  }

  on_set_state(ev) {
    const screen = this.screenById(ev.screen_id);
    const decl = screen.stateFields[ev.field];
    const raw = ev.value ?? null;
    // Состояние экрана -- это состояние интерфейса: «не выбрано» здесь UNSET, а
    // не SQL NULL.
    const model = screen.model;
    const field = model && model.fields[ev.field];
    const value = raw === null ? UNSET : (field ? field.toDb(raw) : raw);
    screen.state[ev.field].set(value);
    void decl;
  }

  on_set_search(ev) {
    const [, lstate] = this.findList(ev.list_id);
    if (lstate.text.set(ev.value || "")) lstate.limit.set(lstate.node.page_size);
  }

  on_set_filter(ev) {
    const [, lstate] = this.findList(ev.list_id);
    if (lstate.filter.set(ev.index ?? null)) lstate.limit.set(lstate.node.page_size);
  }

  on_set_sort(ev) {
    const [, lstate] = this.findList(ev.list_id);
    if (lstate.sort.set(ev.index ?? null)) lstate.limit.set(lstate.node.page_size);
  }

  /** Бесконечная прокрутка: окно расширяется, а не запрашивается заново. */
  on_load_more(ev) {
    const [, lstate] = this.findList(ev.list_id);
    lstate.limit.set(lstate.limit.peek() + lstate.node.page_size);
  }

  on_write(ev) {
    const model = this.model(ev.model);
    // У записи ещё нет строки: значение уходит в черновик и доберётся до базы
    // только когда экран сохранят.
    if (ev.record_id === null || ev.record_id === undefined) {
      const frame = ev.screen_id ? this.screenById(ev.screen_id) : this.current();
      if (frame.draft === null) {
        throw new OneFrameworkError("Запись, которой нет и которая не черновик.");
      }
      frame.draft.write(ev.values);
      return;
    }
    const values = {};
    for (const [name, raw] of Object.entries(ev.values)) {
      const field = model.field(name);
      // У Many2many нет колонки: записать его -- значит переписать связи.
      if (field.ftype === "many2many") {
        this.db.setMany2many(field, ev.record_id, raw || []);
        this.touch(field.resolveComodel());
        continue;
      }
      values[name] = raw;
    }
    if (Object.keys(values).length) this.db.write(model, ev.record_id, values);
    this.touch(model);
  }

  on_open(ev) {
    // Ключ записи обязателен: без него `push` открыл бы карточку «ни о чём»,
    // и человек увидел бы пустую форму вместо своей записи -- без единого
    // слова о том, что кадр пришёл неполным.
    if (!("record_id" in ev)) throw new OneFrameworkError("`open` без ключа записи");
    const [, lstate] = this.findList(ev.list_id);
    const node = lstate.node;
    if (!node.open) return;
    this.push(node.open, { recordId: ev.record_id });
  }

  on_back() {
    this.pop();
  }

  /**
   * Вернуться на уровень: снять всё, что лежит поверх названного кадра.
   *
   * Зеркало `on_back_to` питоновского рантайма -- там же разобрано, почему
   * кадр назван ключом, а не номером, и почему чужой ключ здесь исключение, а
   * не молчание.
   */
  on_back_to(ev) {
    const target = ev.screen_id;
    const at = this.stack.findIndex((f) => f.id === target);
    if (at < 0) throw new OneFrameworkError(`Кадра ${target} нет в стеке раздела`);
    while (this.stack.length > at + 1) this.pop();
  }

  /**
   * Прийти по адресу: раздел плюс путь «вид -- запись» на каждый кадр.
   *
   * Зеркало `on_goto` питоновского рантайма -- там же и разобрано, почему
   * совпавшее начало стека остаётся стоять и почему неисполнимый шаг обрывает
   * путь молча, а не исключением.
   */
  on_goto(ev) {
    // Раздел -- обязательный ключ, и подставлять вместо него текущий было бы
    // гаданием: адрес без раздела не адрес, а «куда-нибудь».
    const key = ev.screen;
    this.screenDef(key);
    if (key !== this.active) {
      this.active = key;
      this._markDirty();
    }
    const stack = this.stack;
    const path = ev.path || [];
    let keep = 1;
    while (keep < stack.length && keep <= path.length
           && samePlace(stack[keep], path[keep - 1])) keep += 1;
    while (stack.length > keep) this.pop();
    for (const step of path.slice(keep - 1)) {
      const doc = this.documents[step.view];
      if (!doc) break;
      const recordId = step.record_id ?? null;
      const model = doc.model ? this.models[doc.model] : null;
      if (recordId !== null && model && this.db.read(model, recordId) === null) break;
      this.push(step.view, { recordId });
    }
  }

  on_flush() {
    this.db.flushNow();
  }

  /** Пусто: даёт хосту прочитать текущий кадр, ничего не меняя. */
  on_probe() {}

  on_action(ev) {
    const ctx0 = ev.context || {};
    let frame = ctx0.screen_id ? this.screenById(ctx0.screen_id) : null;
    let node = frame ? frame.buttons[ev.button_id] : null;
    if (!node) [frame, node] = this._buttonAnywhere(ev.button_id);
    const action = node.action;
    const ctx = ev.context || {};
    let model = ctx.model ? this.model(ctx.model) : null;
    let recordId = ctx.record_id ?? null;

    if (action.type === "delete") {
      if (action.model) {
        model = this.model(action.model);
        recordId = action.record_id ?? null;
      }
      // `Delete(Model, domain=...)` снимает целый набор разом. Спрашивается
      // здесь, а не когда рисовали экран: между двумя моментами человек мог
      // завершить ещё одну задачу.
      if (action.domain !== null && action.domain !== undefined) {
        if (model === null) throw new OneFrameworkError("Delete(domain=...) требует модель.");
        recordId = this.matchingIds(model, action.domain);
      }
      if (model === null || recordId === null) {
        throw new OneFrameworkError("Delete требует запись в контексте.");
      }
      const many = Array.isArray(recordId);
      for (const one of many ? recordId : [recordId]) this.db.unlink(model, one);
      this.touch(model);
      // Удаление набора -- правка экрана, а не его конец: строки уходят, экран
      // остаётся. Уходит только запись, удаляющая саму себя.
      if (CLOSES_SCREEN.has(action.type) && !many && !ctx.in_row) {
        const screen = this.screenById(ctx.screen_id);
        if (screen === this.current()) {
          screen.createdNew = false;
          this.pop();
        }
      }
    } else if (action.type === "set") {
      if (action.scope === "view") {
        this.on_set_state({ screen_id: ctx.screen_id, field: action.field,
                            value: action.value });
      } else {
        if (model === null || recordId === null) {
          throw new OneFrameworkError("Set требует запись в контексте.");
        }
        this.db.write(model, recordId, { [action.field]: action.value });
        this.touch(model);
      }
      // `set` экран не закрывает: в питоне у него `closes_screen = False`, и
      // «Выполнено» на карточке задачи остаётся на месте, а не уводит назад.
    } else if (action.type === "open") {
      this.push(action.view, { recordId: action.record_id, target: action.target });
    } else if (action.type === "logic") {
      // Обещание возвращается наружу, а не выбрасывается. Логика на
      // устройстве почти всегда асинхронна -- модуль надо поднять, питон
      // разбудить, -- и `dispatch` умеет её дождаться и перерисовать. Но
      // ждать он может только то, что ему отдали: без этого `return` снимок
      // уходил до записи, и человек видел прежнее значение. Выглядело как
      // «надо нажать несколько раз»: на втором нажатии показывалось то, что
      // посчитало первое.
      const ждём = this.runLogic(action, ctx);
      if (action.closes_screen && !ctx.in_row) {
        const screen = this.screenById(ctx.screen_id);
        if (screen === this.current()) this.pop();
      }
      return ждём;
    } else if (action.type === "create") {
      this.runCreate(action, frame);
    } else if (action.type === "save") {
      const screen = this.screenById(ctx.screen_id);
      const draft = screen.draft;
      if (draft === null) {
        this.pop();
        return;
      }
      const missing = draft.model.fieldList
        .filter((f) => f.stored && f.required && !draft.values[f.name])
        .map((f) => f.displayLabel);
      if (missing.length) throw new OneFrameworkError(`Заполните: ${missing.join(", ")}`);
      const recordIdNew = draft.save(this.db);
      this.touch(draft.model);
      screen.draft = null;
      screen.recordId = recordIdNew;
      this.pop();
    } else {
      throw new OneFrameworkError(`Действие ${action.type} не реализовано.`);
    }
  }

  /**
   * `Create(...)`: сделать ту запись, за которую стоит «+» экрана.
   *
   * Чем она начинается -- это предложение самого приложения (`values=`) плюс
   * две вещи, которые знает только работающий экран: куда запись попадает в
   * списке, упорядоченном руками, и какой фильтр человек включил. Последнее --
   * утверждение обо всех строках на экране, и запись, сделанная при включённом
   * фильтре, обязана ему удовлетворять, иначе она вставится в вид, который её
   * тут же спрячет, а выглядеть это будет как «кнопка ничего не сделала».
   */
  // -- бизнес-логика --------------------------------------------------------
  /** Объявленное действие по имени. Отказ -- назвав, чего не хватило. */
  logicAction(name) {
    const actions = this.logic ? this.logic.actions : {};
    const run = actions[name];
    if (!run) {
      throw new OneFrameworkError(
        `Действие ${JSON.stringify(name)} не объявлено. Объявлены: `
          + `${Object.keys(actions).sort().join(", ") || "—"}.`,
      );
    }
    return run;
  }

  /** Позвать модуль: имя из вида, ключи -- из экрана. */
  runLogic(action, ctx) {
    const run = this.logicAction(action.name);
    const recordId = ctx.record_id ?? null;
    // Второй рубеж после погашенной кнопки: сюда можно прийти и мимо неё --
    // адресом, действием строки, чужим вызовом. Отказ вслух, а не работа над
    // пустым набором: она проходит успешно и не делает ничего.
    if (recordId === null && нуженНабор(this, action)) {
      throw new OneFrameworkError(
        `Действие ${JSON.stringify(action.name)} объявлено над набором записей, `
        + "а записи нет: она ещё не создана. Сохраните её и повторите.",
      );
    }
    const result = run(bindArgs(run.manifest, action.args, recordId ? [recordId] : []));
    // Что именно тронул модуль, отсюда не видно: его дело -- набор, а не экран.
    // Объявление называет модель действия, а писать логика вправе в любую --
    // завершение задачи меняет и её подзадачи. Поэтому перерисовывается всё.
    for (const name of Object.keys(this.models)) this.touch(name);
    return result;
  }

  /**
   * Значение вычисляемого поля -- спрошенное сейчас, а не хранимое.
   *
   * Зависимости не объявляются: модуль читает что хочет, и вывести список
   * таблиц из чужого языка нечем. Поэтому пересчёт привязан к ревизии **всех**
   * таблиц -- грубо, зато без молчаливо устаревшего числа на экране.
   */
  /**
   * У **объявленного** поля значение уже приехало колонкой выборки, и
   * спрашивать нечего. Дорога ниже осталась для полей, объявленных **именем
   * действия**: то, что в SQL не выражается, ходит по ней.
   */
  computed(field, ctx) {
    const record = ctx.record;
    if (!record || !record.id) return null;
    if (declarationOf(field)) {
      // Список: значение посчитано тем же проходом, что и строка.
      if (field.name in record) return record[field.name];
      // Карточка одной записи: строку читал `read`, а он о вычисляемых полях
      // не знает. Спрашиваем точечно -- один запрос на поле на экран.
      return this.computedOne(ctx.model, field, record.id);
    }
    for (const name of Object.keys(this.models)) this.tableSignal(name).get();
    const run = this.logicAction(field.compute);
    const answer = run(bindArgs(run.manifest, {}, [record.id])) || {};
    return answer[resultKey(run.manifest)] ?? null;
  }

  runCreate(action, screen) {
    const model = this.model(action.model);
    const values = {};
    const lstate = this._listOf(screen, model);
    if (lstate !== null) {
      const shape = listShape(lstate.node,
        lstate.node.item ? this.document(lstate.node.item) : null);
      if (shape.handleField) {
        values[shape.handleField] = (this.db.maxValue(model, shape.handleField) || 0) + 10;
      }
      Object.assign(values, this._filterSeed(lstate, screen));
    }
    for (const [name, raw] of Object.entries(action.values || {})) {
      let value = raw;
      if (raw !== null && typeof raw === "object" && "v" in raw) {
        const sig = screen.state[raw.v];
        value = sig ? sig.peek() : UNSET;
      }
      // Состояние, которое человек ещё не выбрал, о записи ничего не говорит.
      if (value !== UNSET) values[name] = value;
    }
    if (action.draft) {
      this.push(action.view, {
        draft: new Draft(model, values, action.view || model.name),
        target: action.target,
      });
      return;
    }
    const recordId = this.db.create(model, values);
    this.touch(model);
    if (action.view) {
      this.push(action.view, { recordId, createdNew: true, target: action.target });
    }
  }

  _listOf(screen, model) {
    for (const lstate of Object.values(screen.lists)) {
      if (lstate.node.model === model.name) return lstate;
    }
    return null;
  }

  /**
   * Значения, которые новой записи нужны, чтобы удовлетворить включённый фильтр.
   *
   * Читается только `=`, и только внутри `&`: они утверждают факт обо всех
   * строках на экране, а факт -- это то, под что запись можно построить. Всё
   * остальное -- диапазон, `или` -- описывает множество, у которого одного
   * ответа нет.
   */
  _filterSeed(lstate, screen) {
    const search = lstate.node.search;
    const active = lstate.filter.peek();
    if (!search || active === null || !(active >= 0 && active < search.filters.length)) {
      return {};
    }
    return this._domainSeed(lstate.node, screen, search.filters[active].domain ?? null);
  }

  _domainSeed(node, screen, domain) {
    const seed = {};
    const opaque = [];

    const visit = (expr) => {
      if (expr === null || expr === undefined) return;
      if (expr.op === "&") {
        (expr.p || []).forEach(visit);
        return;
      }
      // Булево поле само по себе утверждает факт обо всех строках -- и его
      // отрицание тоже.
      const negated = expr.op === "!";
      const flag = negated ? expr.e : expr;
      if (flag && typeof flag === "object" && "r" in flag && !("op" in flag)) {
        seed[flag.r] = !negated;
        return;
      }
      if (!expr.op || expr.op !== "=") {
        opaque.push(expr);
        return;
      }
      const left = expr.l;
      if (!left || typeof left !== "object" || !("r" in left)) {
        opaque.push(expr);
        return;
      }
      const right = expr.r;
      let value;
      if (right !== null && typeof right === "object" && "v" in right) {
        const sig = screen.state[right.v];
        value = sig ? sig.peek() : UNSET;
      } else if (right === null || ["string", "number", "boolean"].includes(typeof right)) {
        value = right;
      } else {
        opaque.push(expr);
        return;
      }
      if (value !== UNSET && value !== null) seed[left.r] = value;
    };

    visit(domain);
    if (opaque.length) {
      throw new OneFrameworkError(
        `В этот список ${node.model} нельзя добавить, пока он сужен условием, ` +
          "под которое нет одного значения. Запишите фильтр равенствами через '&'.",
      );
    }
    return seed;
  }

  /** Переставить одну запись и перенумеровать поле-ручку. */
  on_reorder(ev) {
    // Ключ записи и место назначения -- оба обязательны. Без «куда» здесь
    // выходило `Number(undefined)`, то есть NaN, который зажимался в ноль:
    // строка молча уезжала в начало списка вместо отказа.
    for (const ключ of ["record_id", "to"]) {
      if (!(ключ in ev)) throw new OneFrameworkError(`\`reorder\` без ключа ${ключ}`);
    }
    const [screen, lstate] = this.findList(ev.list_id);
    const node = lstate.node;
    const shape = listShape(node, node.item ? this.document(node.item) : null);
    if (!shape.handleField) return;
    const model = this.model(node.model);

    const ids = this._orderedIds(node, lstate, screen);
    const recordId = ev.record_id;
    const source = ids.indexOf(recordId);
    if (source < 0) return;
    const target = Math.max(0, Math.min(ids.length - 1, Number(ev.to)));
    if (source === target) return;
    ids.splice(target, 0, ids.splice(source, 1)[0]);

    ids.forEach((rid, position) => {
      this.db.write(model, rid, { [shape.handleField]: (position + 1) * 10 });
    });
    this.touch(model);
  }

  _orderedIds(node, lstate, screen) {
    const model = this.model(node.model);
    // Перестановка происходит на той странице, где человек, и её запись -- это
    // и есть зафиксированное состояние, поэтому постраничной подмены здесь нет.
    const qctx = new QueryContext(model, screen.stateValues());
    const where = [compileDomain(node.domain ?? null, qctx)];
    const search = node.search;
    let orders;
    if (search) {
      const activeFilter = lstate.filter.peek();
      if (activeFilter !== null && activeFilter >= 0
          && activeFilter < search.filters.length) {
        where.push(compileDomain(search.filters[activeFilter].domain ?? null, qctx));
      }
      where.push(new SearchSpec(search.fields, lstate.text.peek()).compile(qctx));
      const activeSort = lstate.sort.peek();
      orders = (activeSort !== null && activeSort >= 0 && activeSort < search.sorts.length)
        ? search.sorts[activeSort].orders || []
        : [];
    } else {
      orders = node.order || [];
    }
    const [sql, params] = buildSelect(model, qctx, where, compileOrder(orders, qctx));
    return this.db.query(model, sql, params).map((r) => r.id);
  }
}


/**
 * Нужен ли действию набор записей.
 *
 * Смотрится **объявление**, а не имя аргумента: имя принадлежит модулю, и
 * требовать от него звать набор именно `ids` значило бы протащить соглашение
 * фреймворка внутрь чужого языка. Пара к `bindArgs`.
 *
 * Объявления нет -- отвечаем «не нужен»: выдумывать отказ на незнакомое
 * действие хуже, чем пропустить его дальше, где о нём скажут по существу.
 */
function нуженНабор(session, action) {
  if (!action || action.type !== "logic" || !action.name) return false;
  const actions = session.logic ? session.logic.actions : {};
  const run = actions[action.name];
  const args = (run && run.manifest && run.manifest.args) || [];
  return args.some((spec) => spec.type === "ids" || spec.type === "id");
}

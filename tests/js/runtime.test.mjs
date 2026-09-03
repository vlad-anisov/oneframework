/**
 * Поведение рантайма насквозь, на демонстрационном приложении и без браузера.
 *
 * Проходится тот же путь, которым ходит браузер: запросы, отзывчивость,
 * навигация, правка записей и перетаскивание.
 *
 * Прежде здесь поднимался питоновский эталон; проверки при этом
 * описывали поведение приложения, а не питона, и потому переехали на рантайм
 * устройства целиком, не меняя ни одного утверждения. Теперь на JavaScript
 * переехали и они сами: приложение объявляет `examples/todo-js`, а разговор с
 * рантаймом идёт вызовом, а не построчным протоколом через долгоживущий хост.
 *
 * База берётся **у рантайма**: правки живут в его памяти, и файл, из которого
 * приложение выложили, о них не знает. Спрашивать файл было бы тише всего -- и
 * неверно.
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";

import { bindRow } from "../../web/src/react/bindrow.js";
import { подопытноеTodo, поднятьРантайм } from "./помощь.mjs";

let пакет = null;
before(async () => { пакет = await подопытноеTodo(); });

/** Свой рантайм на проверку: правка одной не должна решать за другую. */
async function поднять() {
  const { rt, db, модели } = await поднятьРантайм(пакет, пакет.app.screens ?? []);
  return { rt, db, модели, TodoLine: модели.TodoLine };
}

const стек = (rt) => rt.snapshot().stacks[rt.snapshot().active];
const верх = (rt) => стек(rt).at(-1);
const список = (rt) => верх(rt).children.find((c) => c.type === "list");
const идСписка = (rt) => список(rt).id;

/** Обход поддерева в глубину: `Row` -- узел раскладки, а не значение. */
function* плоско(узлы) {
  for (const н of узлы) {
    yield н;
    if (н.children) yield* плоско(н.children);
  }
}

/**
 * Строки так, как их собирает рендерер: `bindRow` -- **его** функция, не копия.
 *
 * На проводе едет описание строки (`list.row`) и вектор значений на запись
 * (`list.rows[i].v`), а узлы с живыми значениями существуют только там, где
 * рисуют. Проверка, которая спрашивает про нарисованную строку, обязана
 * спрашивать то же самое -- и тем же кодом.
 */
const строки = (узел) => (узел.rows || []).map((с) => bindRow(узел.row, с));

const заголовки = (rt) => строки(список(rt))
.map((с) => [...плоско(с.children)].find((c) => c.name === "text").value);

/** Плавающая кнопка экрана -- `Button(place: "fab")`, поднятая в бар. */
const плюс = (rt) => верх(rt).navbar_buttons.find((b) => b.place === "fab");

const нажать = (rt, кнопка) =>
  rt.dispatch({ type: "action", button_id: кнопка.id, context: кнопка.context });

const тег = (rt) => Object.fromEntries(
  верх(rt).children.find((c) => c.type === "field").choices.map((c) => [c.display, c.id]));

// ------------------------------------------------------------------ отборы
test("отбор по умолчанию наложен при загрузке", async () => {
  const { rt } = await поднять();
  assert.equal(список(rt).state.filter, 0);
  assert.ok(!заголовки(rt).includes("Оплатить интернет"));
  assert.equal(заголовки(rt).length, 4);
});

test("смена отбора переспрашивает базу", async () => {
  const { rt } = await поднять();
  rt.dispatch({ type: "set_filter", list_id: идСписка(rt), index: 1 });
  assert.deepEqual(заголовки(rt).sort(), ["Оплатить интернет", "Прочитать книгу"]);
});

test("снятый отбор показывает всё", async () => {
  const { rt } = await поднять();
  rt.dispatch({ type: "set_filter", list_id: идСписка(rt), index: null });
  assert.equal(заголовки(rt).length, 6);
});

// ------------------------------------------------------------------- поиск
test("поиск не различает регистр в кириллице", async () => {
  const { rt } = await поднять();
  rt.dispatch({ type: "set_search", list_id: идСписка(rt), value: "МОЛОКО" });
  assert.deepEqual(заголовки(rt), ["Купить молоко"]);
  rt.dispatch({ type: "set_search", list_id: идСписка(rt), value: "" });
  assert.equal(заголовки(rt).length, 4);
});

test("поиск находит по куску слова", async () => {
  const { rt } = await поднять();
  rt.dispatch({ type: "set_search", list_id: идСписка(rt), value: "звонить" });
  assert.deepEqual(заголовки(rt), ["Позвонить в сервис"]);
});

// ------------------------------------------------------------ состояние вида
test("невыбранный тег не отбирает ничего", async () => {
  const { rt } = await поднять();
  assert.equal(заголовки(rt).length, 4, "UNSET не должен отбирать по «тег пуст»");
});

test("выбранный тег отбирает список", async () => {
  const { rt } = await поднять();
  rt.dispatch({ type: "set_state", screen_id: верх(rt).id, field: "tag",
                value: тег(rt)["Личное"] });
  assert.deepEqual(заголовки(rt).sort(), ["Записаться к врачу", "Позвонить в сервис"]);
});

test("снятый тег возвращает все записи", async () => {
  const { rt } = await поднять();
  const выбор = тег(rt);
  const экран = верх(rt).id;
  rt.dispatch({ type: "set_state", screen_id: экран, field: "tag", value: выбор["Работа"] });
  assert.equal(заголовки(rt).length, 1);
  rt.dispatch({ type: "set_state", screen_id: экран, field: "tag", value: null });
  assert.equal(заголовки(rt).length, 4);
});

// -------------------------------------------------------------- сортировки
test("«сначала новые» ставит свежую запись первой", async () => {
  const { rt } = await поднять();
  rt.dispatch({ type: "set_sort", list_id: идСписка(rt), index: 1 });
  assert.equal(заголовки(rt)[0], "Записаться к врачу");
});

test("перетаскивание предлагается только при порядке-ручке", async () => {
  const { rt } = await поднять();
  assert.equal(список(rt).reorderable, true);
  rt.dispatch({ type: "set_sort", list_id: идСписка(rt), index: 1 });
  assert.equal(список(rt).reorderable, false);
});

test("перетаскивание переписывает поле-ручку", async () => {
  const { rt, db, TodoLine } = await поднять();
  const ключи = список(rt).rows.map((с) => с.id);
  const было = заголовки(rt);
  // третью строку -- наверх
  rt.dispatch({ type: "reorder", list_id: идСписка(rt), record_id: ключи[2], from: 2, to: 0 });
  assert.equal(заголовки(rt)[0], было[2]);
  assert.equal(db.read(TodoLine, ключи[2]).sequence, 10);
  assert.equal(db.read(TodoLine, ключи[0]).sequence, 20);
});

test("перетаскивание на то же место ничего не делает", async () => {
  const { rt } = await поднять();
  const ключи = список(rt).rows.map((с) => с.id);
  const было = заголовки(rt);
  rt.dispatch({ type: "reorder", list_id: идСписка(rt), record_id: ключи[1], from: 1, to: 1 });
  assert.deepEqual(заголовки(rt), было);
});

// ---------------------------------------------------------------- страницы
test("список говорит, есть ли ещё строки", async () => {
  const { rt } = await поднять();
  assert.equal(список(rt).has_more, false);
  assert.equal(список(rt).limit, 60);
  rt.dispatch({ type: "set_filter", list_id: идСписка(rt), index: null });
  assert.equal(список(rt).rows.length, 6);
});

test("«ещё» расширяет окно", async () => {
  const { rt } = await поднять();
  rt.dispatch({ type: "load_more", list_id: идСписка(rt) });
  assert.equal(список(rt).limit, 120);
});

test("смена запроса сбрасывает окно", async () => {
  const { rt } = await поднять();
  const id = идСписка(rt);
  rt.dispatch({ type: "load_more", list_id: id });
  assert.equal(список(rt).limit, 120);
  rt.dispatch({ type: "set_search", list_id: id, value: "о" });
  assert.equal(список(rt).limit, 60);
});

// -------------------------------------------------------------- отзывчивость
test("запись обновляет список без явного обновления", async () => {
  const { rt } = await поднять();
  const id = список(rt).rows[0].id;
  rt.dispatch({ type: "write", model: "TodoLine", record_id: id,
                values: { completed: true } });
  assert.ok(!заголовки(rt).includes("Купить молоко"));
});

test("правка текста меняет нарисованную строку", async () => {
  const { rt } = await поднять();
  const id = список(rt).rows[0].id;
  rt.dispatch({ type: "write", model: "TodoLine", record_id: id,
                values: { text: "Купить кефир" } });
  assert.ok(заголовки(rt).includes("Купить кефир"));
});

// ---------------------------------------------------------------- навигация
test("открытие кладёт карточку с заголовком по записи", async () => {
  const { rt } = await поднять();
  const id = список(rt).rows[0].id;
  rt.dispatch({ type: "open", list_id: идСписка(rt), record_id: id });
  assert.equal(стек(rt).length, 2);
  assert.equal(верх(rt).view, "TodoLineDetail");
  assert.equal(верх(rt).title, "Купить молоко");
});

test("«назад» снимает кадр", async () => {
  const { rt } = await поднять();
  const id = список(rt).rows[0].id;
  rt.dispatch({ type: "open", list_id: идСписка(rt), record_id: id });
  rt.dispatch({ type: "back" });
  assert.equal(стек(rt).length, 1);
});

// ---------------------------------------------------- создание и удаление
const кнопка = (дети) => [...плоско(дети)].find((c) => c.type === "button");

test("удаление из строки никуда не уводит", async () => {
  const { rt, db, TodoLine } = await поднять();
  const строка = строки(список(rt))[0];
  const b = кнопка(строка.children);
  assert.equal(b.context.in_row, true);
  нажать(rt, b);
  assert.equal(стек(rt).length, 1);
  assert.equal(db.read(TodoLine, строка.id), null);
});

test("удаление из карточки закрывает её", async () => {
  const { rt, db, TodoLine } = await поднять();
  const id = список(rt).rows[0].id;
  rt.dispatch({ type: "open", list_id: идСписка(rt), record_id: id });
  const b = кнопка(верх(rt).children);
  assert.equal(b.context.in_row, false);
  нажать(rt, b);
  assert.equal(стек(rt).length, 1);
  assert.equal(db.read(TodoLine, id), null);
});

test("создание открывает карточку и проставляет поле-ручку", async () => {
  const { rt, db, TodoLine } = await поднять();
  const было = db.count(TodoLine);
  нажать(rt, плюс(rt));
  assert.equal(db.count(TodoLine), было + 1);
  assert.equal(верх(rt).view, "TodoLineDetail");
  assert.equal(db.read(TodoLine, верх(rt).record_id).sequence, 70);
});

test("создание наследует выбранный тег", async () => {
  const { rt, db, TodoLine } = await поднять();
  const выбор = тег(rt);
  rt.dispatch({ type: "set_state", screen_id: верх(rt).id, field: "tag",
                value: выбор["Работа"] });
  нажать(rt, плюс(rt));
  assert.equal(db.read(TodoLine, верх(rt).record_id).tag, выбор["Работа"]);
});

test("созданное удовлетворяет отбору, который в силе", async () => {
  // Иначе запись вставлена, список переспрашивает базу без неё, и кнопка
  // читается как не сделавшая ничего.
  const { rt, db, TodoLine } = await поднять();
  // «Выполнено» -- второй отбор списка: completed == true.
  rt.dispatch({ type: "set_filter", list_id: идСписка(rt), index: 1 });
  нажать(rt, плюс(rt));
  assert.equal(db.read(TodoLine, верх(rt).record_id).completed, true);
});

test("нетронутая новая запись выбрасывается при возврате", async () => {
  const { rt, db, TodoLine } = await поднять();
  const было = db.count(TodoLine);
  нажать(rt, плюс(rt));
  rt.dispatch({ type: "back" });
  assert.equal(db.count(TodoLine), было);
});

test("заполненная новая запись остаётся", async () => {
  const { rt, db, TodoLine } = await поднять();
  const было = db.count(TodoLine);
  нажать(rt, плюс(rt));
  rt.dispatch({ type: "write", model: "TodoLine", record_id: верх(rt).record_id,
                values: { text: "Новая задача" } });
  rt.dispatch({ type: "back" });
  assert.equal(db.count(TodoLine), было + 1);
  assert.ok(заголовки(rt).includes("Новая задача"));
});

//: Здесь стояла «посев идёт один раз»: повторная выкладка не сеет заново.
//: Правило живо, но переехало туда, где посев теперь и происходит --
//: `tests/test_build_db.py`. Проверять его на выкладке значило бы стеречь
//: дорогу, которой сборка больше не ходит.

// ----------------------------------------------------------------- связи
test("связь в строке несёт подпись и цвет", async () => {
  const { rt } = await поднять();
  const строка = строки(список(rt))[0];
  const t = [...плоско(строка.children)].find((c) => c.name === "tag");
  assert.equal(t.related.display, "Покупки");
  assert.ok(t.related.color.startsWith("#"));
  assert.equal(t.comodel.display_field, "name");
  assert.equal(t.comodel.color_field, "color");
});

test("отбор, которому не удовлетворит ни одна запись, отказывает у самого «+»", async () => {
  // Отбор **объявляется** видом, а не подменяется на живом объекте: раньше
  // проверка лезла внутрь рантайма и правила `filter.domain` прямо в нём. Так
  // можно было, пока рантайм жил в том же процессе; теперь он тот, что стоит на
  // устройстве, и приложение попадает к нему той же дорогой, что настоящее.
  const {
    Button, Filter, List, Screen, Search, Sort, app, boolean, declare, expr,
    integer, model, string, view,
  } = await import("../../../oneframework-js/index.mjs");

  const Заметка = model("Заметка", {
    table: "заметка",
    fields: { text: string("Текст"), completed: boolean("Выполнена"),
              sequence: integer("Порядок") },
  });
  const Невыполнимый = view("Невыполнимый", {
    ui: (record) => [
      Button({ place: "fab", action: Заметка.create() }),
      List(Заметка, {
        search: Search(
          record.text,
          // Через «или» -- значит одного значения нет: новая запись не может
          // быть одновременно и той, и другой.
          Filter("Любая", expr("record.completed | !record.completed"), { default: true }),
          Sort("По порядку", record.sequence, { default: true }),
        ),
      }),
    ],
  });
  const приложение = app({
    title: "Невыполнимый", models: [Заметка], views: [Невыполнимый],
    screens: [Screen(Невыполнимый)], root: Невыполнимый,
  });
  const п = declare(приложение);
  const { rt } = await поднятьРантайм(п, п.app.screens ?? []);
  assert.throws(() => нажать(rt, плюс(rt)), /нет одного значения/);
});

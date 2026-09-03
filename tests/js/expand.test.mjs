/**
 * Вид как документ: шаблон, данные, дерево -- со стороны **разворота**.
 *
 * Проверяется ровно та граница, ради которой всё это затевалось. Документ не
 * знает ни одной записи: имена в нём ссылки, условия -- выражения, повторитель
 * -- узел. Дерево знает всё: строки сложены, счётчики посчитаны, вкладок
 * столько, сколько списков в базе. Между ними -- разворот, и он единственное
 * место, где данные встречаются с шаблоном.
 *
 * Разворот исполняет рантайм устройства, и проверяется он здесь. Сам документ
 * -- то, что кладёт в него привязка, и как разбирается шаблон, -- вопрос к
 * питоновской половине, и он остался в `tests/test_expand.py`.
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";

import { bindRow } from "../../web/src/react/bindrow.js";
import { поднятьРантайм } from "./помощь.mjs";

let пакет = null;

before(async () => {
  const {
    Accordion, Button, Delete, List, Menu, Pill, Repeat, Row,
    Screen, Tab, Tabs, app, boolean, declare, expr, many2one, model, string, view,
  } = await import("../../../oneframework-js/index.mjs");

  const Board = model("Board", { fields: { name: string("Название") } });
  const Task = model("Task", {
    fields: { title: string("Задача"), done: boolean("Выполнено"),
              board: many2one(Board, "Список") },
  });
  const TaskRow = view("TaskRow", {
    model: Task,
    ui: (r) => Row(r.title(), r.done({ widget: "checkbox" })),
  });
  const Boards = view("Boards", {
    title: "Списки",
    ui: (record) => Tabs(
      Repeat(Board, (item) => Tab(
        "{item.name}",
        Pill(expr("count(Task, record.board = item.id & !record.done)")),
        List(Task, {
          item: TaskRow,
          label: "{item.name}",
          domain: expr("record.board = item.id & !record.done"),
          menu: Menu(Button("Удалить выполненные", {
            action: Delete({
              model: Task,
              domain: expr("record.board = item.id & record.done"),
              confirm: "Удалить всё выполненное в «{item.name}»?",
            }),
            enabled: expr("exists(Task, record.board = item.id & record.done)"),
          })),
        }),
        Accordion(
          List(Task, { item: TaskRow, domain: expr("record.board = item.id & record.done") }),
          { label: "Выполненные",
            visible: expr("exists(Task, record.board = item.id & record.done)") },
        ),
      )),
    ),
  });

  пакет = declare(app({
    title: "Развороты", models: [Board, Task], views: [TaskRow, Boards],
    screens: [Screen(Boards)], root: Boards,
  }));
  // Посев -- данными в пакете: у объявления на JavaScript соседнего файла нет,
  // а сборщик принимает его записанным.
  const доска = (н) => `0192f000-0000-7000-8000-0000000000b${н}`;
  const дело = (н) => `0192f000-0000-7000-8000-0000000000t${н}`;
  пакет.seeds = [{
    mark: "seeded:развороты", also: [], links: [],
    rows: {
      Board: [{ name: "Работа", id: доска(1) }, { name: "Дом", id: доска(2) }],
      Task: [
        { title: "Отчёт", board: доска(1), done: false, id: дело(1) },
        { title: "Созвон", board: доска(1), done: true, id: дело(2) },
        { title: "Молоко", board: доска(2), done: false, id: дело(3) },
      ],
    },
  }];
});

async function поднять() {
  const { rt, db, модели } = await поднятьРантайм(пакет, пакет.app.screens ?? []);
  return { rt, db, Board: модели.Board, Task: модели.Task };
}

const верх = (rt) => rt.stack.at(-1).tree;
const вкладки = (rt) => верх(rt).children.find((c) => c.type === "tabs").children;
const списокВ = (вкладка) => вкладка.children.find((c) => c.type === "list");

function* ячейки(узлы) {
  for (const н of узлы) {
    yield н;
    yield* ячейки(н.children || []);
  }
}

const заголовки = (вкладка) => {
  const узел = списокВ(вкладка);
  return (узел.rows || []).map((с) =>
    [...ячейки(bindRow(узел.row, с).children)].find((н) => н.name === "title").value);
};

test("повторитель становится вкладкой на запись", async () => {
  const { rt } = await поднять();
  assert.deepEqual(вкладки(rt).map((т) => т.label), ["Работа", "Дом"]);
});

test("список, заведённый позже, получает свою вкладку", async () => {
  // То, ради чего повторитель и нужен: структура следует за данными.
  const { rt, db, Board } = await поднять();
  db.create(Board, { name: "Отпуск" });
  rt.touch("Board");
  assert.deepEqual(вкладки(rt).map((т) => т.label), ["Работа", "Дом", "Отпуск"]);
});

test("подпись списка тоже называет свою запись", async () => {
  // Шаблон в подписи разворачивается тем же разворотом, что и вопрос удаления,
  // -- но другой строкой кода, и без этой проверки снятая строка оставляла бы
  // сюиту зелёной.
  const { rt } = await поднять();
  assert.deepEqual(вкладки(rt).map((т) => списокВ(т).label), ["Работа", "Дом"]);
});

test("каждая копия отбирает по своей записи", async () => {
  const { rt } = await поднять();
  const [работа, дом] = вкладки(rt);
  assert.deepEqual(заголовки(работа), ["Отчёт"]);
  assert.deepEqual(заголовки(дом), ["Молоко"]);
});

test("номера не сталкиваются между копиями", async () => {
  const { rt } = await поднять();
  const номера = вкладки(rt).map((т) => т.id);
  assert.equal(номера.length, new Set(номера).size);
});

test("условие, на которое отвечают данные, решает, есть ли узел", async () => {
  // `visible: expr("exists(...)")` -- это питоновский `if`, сказанный условием.
  const { rt } = await поднять();
  const [работа, дом] = вкладки(rt);
  assert.deepEqual(работа.children.map((c) => c.type), ["list", "accordion"]);
  assert.deepEqual(дом.children.map((c) => c.type), ["list"]);
});

test("enabled следует за данными тоже", async () => {
  const { rt } = await поднять();
  const [работа, дом] = вкладки(rt);
  assert.equal(списокВ(работа).menu.children[0].enabled, true);
  assert.equal(списокВ(дом).menu.children[0].enabled, false);
});

test("вопрос называет запись, о которой он", async () => {
  const { rt } = await поднять();
  const кнопка = списокВ(вкладки(rt)[0]).menu.children[0];
  assert.equal(кнопка.action.confirm, "Удалить всё выполненное в «Работа»?");
});

test("счётчик -- данные, и он за ними следует", async () => {
  const { rt, db, Board, Task } = await поднять();
  assert.deepEqual(вкладки(rt).map((т) => т.title.at(-1).value), ["1", "1"]);
  db.create(Task, { title: "Ещё", board: db.all(Board)[0].id });
  rt.touch("Task");
  assert.deepEqual(вкладки(rt).map((т) => т.title.at(-1).value), ["2", "1"]);
});

test("до рендерера не доезжает ни одного вопроса", async () => {
  // Развёрнутое дерево не несёт вопросов -- ни в меню, ни в строке.
  const { rt } = await поднять();
  function* всё(узел) {
    yield узел;
    for (const значение of Object.values(узел)) {
      if (Array.isArray(значение)) {
        for (const дитя of значение) if (дитя && typeof дитя === "object") yield* всё(дитя);
      } else if (значение && typeof значение === "object" && "type" in значение) {
        yield* всё(значение);
      }
    }
  }
  let видано = 0;
  for (const узел of всё(верх(rt))) {
    for (const ключ of ["visible", "enabled", "value", "label", "confirm"]) {
      const v = узел[ключ];
      assert.ok(!(v && typeof v === "object" && !Array.isArray(v)),
                `${узел.type}.${ключ}: ${JSON.stringify(v)}`);
    }
    видано += 1;
  }
  assert.ok(видано > 20, "дерево и правда обошли");
});

test("удаление по домену убирает то, что есть в миг нажатия", async () => {
  // Список номеров снимается при сборке экрана; домен -- при нажатии.
  const { rt, db, Board, Task } = await поднять();
  const кнопка = списокВ(вкладки(rt)[0]).menu.children[0];
  const доска = db.all(Board)[0].id;
  // Ещё одна выполненная задача появляется уже после того, как экран нарисован.
  db.create(Task, { title: "Поздняя", board: доска, done: true });

  rt.dispatch({ type: "action", button_id: кнопка.id, context: кнопка.context });
  const осталось = db.all(Task).filter((t) => t.board === доска).map((t) => t.title);
  assert.deepEqual(осталось, ["Отчёт"]);
});

//: Повторитель копирует тело по разу на запись. Прежде в питоновской
//: половине стояли две проверки на внутренности его `_clone`: что копия ничего
//: не делит с оригиналом из того, что правит, и НЕ заводит второго экземпляра
//: того, что только читает. Второе было замером: общий `deepcopy` съедал 66%
//: всего разворота самого тяжёлого вида.
//:
//: На устройстве копия делается `structuredClone` -- полная, включая деревья
//: условий. И это не недосмотр: там копируется **JSON**, а не живые объекты, и
//: номера узлов правятся на месте, так что общий объект испортил бы оригинал.
//: То есть правило «делить читаемое» питоновское по природе, и переносить его
//: было бы неправдой.
//:
//: Первое правило -- «копии не пишут друг поверх друга» -- никуда не делось,
//: но проверяется по следствию: «каждая копия отбирает по своей записи» и
//: «номера не сталкиваются». Поделись копии изменяемым -- обе покраснеют.

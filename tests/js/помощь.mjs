/**
 * Общая оснастка проверок на JavaScript.
 *
 * `sqlite-wasm` поднимается один раз на прогон: инициализация стоит десятые
 * доли секунды, а нужна она половине проверок. Раньше её платил каждый
 * драйвер, потому что каждый был отдельным процессом.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

let _sqlite3 = null;

export async function sqlite() {
  if (_sqlite3 === null) {
    _sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  }
  return _sqlite3;
}

/**
 * Приложение для проверки: объявить привязкой на JS, собрать базу, поднять
 * рантайм -- тот самый, что стоит на устройстве.
 *
 * Раньше подопытное приложение объявлялось питоном, а рантайм поднимался
 * долгоживущим хостом с построчным протоколом (`tests/jsrt.py`). Питон в этом
 * был только оснасткой: приложение с тем же успехом объявляется привязкой на
 * JavaScript, а рантайм -- ввозится.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ЗДЕСЬ = path.dirname(fileURLToPath(import.meta.url));
const КОРЕНЬ = path.resolve(ЗДЕСЬ, "..", "..");

/**
 * Пакет объявления -> файл базы. Пишет её тот же сборщик, что и настоящая
 * сборка: проверки рантайма обязаны смотреть в базу, написанную той рукой.
 */
export function собратьБазу(пакет) {
  const каталог = mkdtempSync(path.join(tmpdir(), "oneframework-проба-"));
  const файл = path.join(каталог, "app.db");
  const готово = spawnSync("node", [path.join(КОРЕНЬ, "src/build-db.mjs")], {
    input: JSON.stringify({ ...пакет, file: файл }),
    encoding: "utf8", cwd: КОРЕНЬ, maxBuffer: 64 * 1024 * 1024,
  });
  if (готово.status !== 0) throw new Error(`Сборщик базы отказал: ${готово.stderr}`);
  const ответ = JSON.parse(готово.stdout);
  if (ответ.error) throw new Error(`Сборщик базы отказал: ${ответ.error}`);
  return файл;
}

/** Поднять базу из файла в память -- так же, как это делает устройство. */
export async function открыть(файл) {
  const { readFileSync } = await import("node:fs");
  const sqlite3 = await sqlite();
  const байты = new Uint8Array(readFileSync(файл));
  const h = new sqlite3.oo1.DB(":memory:");
  const p = sqlite3.wasm.allocFromTypedArray(байты);
  sqlite3.capi.sqlite3_deserialize(
    h.pointer, "main", p, байты.length, байты.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE
      | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
  return { handle: h, sqlite3 };
}

/**
 * Небольшое приложение для проверок рантайма: задачи с тегами.
 *
 * Модели те же, что у примера `examples/todo`, -- на них написана половина
 * проверок, и повторять их формой значило бы проверять другое приложение.
 */
export async function пробноеПриложение() {
  const {
    Button, List, Row, Screen, app, boolean, integer, many2one, model, string,
    text, view, declare,
  } = await import("../../../oneframework-js/index.mjs");

  const Tag = model("Tag", { fields: { name: string("Название", { required: true }) } });
  const TodoLine = model("TodoLine", {
    fields: {
      text: string("Задача", { required: true }),
      description: text("Описание"),
      tag: many2one(Tag, "Тег"),
      completed: boolean("Выполнено"),
      sequence: integer(),
    },
  });

  const Item = view("TodoLineItem", {
    model: TodoLine,
    ui: (record) => Row(record.completed({ widget: "toggle" }),
                        record.text({ widget: "title" })),
  });
  const Detail = view("TodoLineDetail", {
    model: TodoLine,
    ui: (record) => [record.text(), record.description({ widget: "textarea" }),
                     record.completed()],
  });
  const Board = view("Todo", {
    title: "Задачи",
    ui: () => [List(TodoLine, { item: Item, open: Detail }),
               Button({ place: "fab", action: TodoLine.create({ open: Detail, draft: true }) })],
  });

  const приложение = app({
    title: "Задачи", models: [Tag, TodoLine], views: [Item, Detail, Board],
    screens: [Screen(Board)], root: Board,
  });
  return { приложение, пакет: declare(приложение), TodoLine, Tag };
}

/**
 * Поднять рантайм на пробном приложении -- так же, как это делает устройство.
 *
 * Возвращает и рантайм, и базу: проверкам нужно и то и другое -- одни
 * спрашивают экран, другие смотрят, что вправду легло в таблицу.
 */
export async function поднятьРантайм(пакет, экраны) {
  return поднятьФайл(собратьБазу(пакет), экраны);
}

/** Готовый файл базы -> рантайм. Общая половина: план и пакет сходятся здесь. */
export async function поднятьФайл(файл, экраны) {
  const { handle, sqlite3 } = await открыть(файл);
  const { Database } = await import("../../src/runtime/db.js");
  const { loadDocuments, loadSchema } = await import("../../src/runtime/defs.js");
  const { makeModels } = await import("../../src/runtime/fields.js");
  const { Runtime } = await import("../../src/runtime/session.js");

  const logic = await import("../../src/runtime/logic.js");

  const db = new Database(handle, { sqlite3, journal: "MEMORY" });
  const схема = loadSchema(db);
  const модели = makeModels(схема);
  if (Object.keys(модели).length) db.ensureSchema(Object.values(модели));
  // Логика подключается, только если в базе есть объявления: у приложения без
  // неё пустой хост означал бы, что действие «объявлено, но молчит», -- и
  // проверки логики зеленели бы на молчании.
  let api = null;
  if (logic.manifests(db).length) {
    const docs = Object.fromEntries(схема.models.map((м) => [м.name, м]));
    api = new logic.Api(db, Object.values(модели), { docs });
    await logic.register(db, api);
    db.validator = logic.validator(api);
  }
  const rt = new Runtime({ documents: loadDocuments(db), models: модели, db,
                           screens: экраны || [],
                           logic: api ?? { actions: {}, models: модели } });
  const снимок = rt.boot();
  return { rt, db, модели, снимок };
}

/**
 * Приложение `examples/todo-js` вместе с посевом -- то, на чём написана
 * половина проверок рантайма.
 *
 * Посев -- **данные в пакете**, а не соседний файл: `seed.py` -- приём
 * питоновской привязки, у объявления на JavaScript такого нет, и сборщик всё
 * равно принимает посев записанным (`build-db.mjs`). Ключи проставлены здесь:
 * посев ими пользуется на месте (строка ссылается на тег), и одинаковыми они
 * обязаны быть на всех клиентах.
 */
export async function подопытноеTodo() {
  const { declare } = await import("../../../oneframework-js/index.mjs");
  const { application } = await import("../../../oneframework-js/examples/todo-js/app.mjs");
  const пакет = declare(application);
  const тег = (н) => `0192f000-0000-7000-8000-00000000t${String(н).padStart(3, "0")}`;
  const строка = (н) => `0192f000-0000-7000-8000-00000000l${String(н).padStart(3, "0")}`;
  const теги = [["Работа", "#1e88e5"], ["Личное", "#8e24aa"],
                ["Покупки", "#43a047"], ["Учёба", "#fb8c00"]];
  const строки = [
    ["Купить молоко", "2 литра, обезжиренное", 2, false],
    ["Позвонить в сервис", "Уточнить статус ремонта", 1, false],
    ["Оплатить интернет", "До 15 числа", 1, true],
    ["Подготовить отчёт", "Квартальные показатели", 0, false],
    ["Записаться к врачу", "", 1, false],
    ["Прочитать книгу", "Осталось две главы", 3, true],
  ];
  пакет.seeds = [{
    mark: "seeded:todo:app",
    also: ["seeded:todo", "seeded"],
    rows: {
      Tag: теги.map(([name, color], и) => ({ name, color, id: тег(и) })),
      TodoLine: строки.map(([text, description, т, completed], и) => ({
        text, description, tag: тег(т), completed, sequence: (и + 1) * 10, id: строка(и),
      })),
    },
    links: [],
  }];
  return пакет;
}

/**
 * Поднять рантайм на **плане**, а не на пакете: проверкам логики нужно
 * дописать в него рукописные объявления действий.
 *
 * Собранное из метода объявление всегда согласовано с телом, а спрашивается
 * там как раз то, что хост делает с несогласованным -- с ответом, где полей
 * больше, чем разрешено. Рукописным его иначе не сделать.
 */
export async function поднятьПлан(план, экраны) {
  const каталог = mkdtempSync(path.join(tmpdir(), "oneframework-план-"));
  const файл = path.join(каталог, "app.db");
  const готово = spawnSync("node", [path.join(КОРЕНЬ, "src/build-db.mjs")], {
    input: JSON.stringify({ ...план, file: файл }),
    encoding: "utf8", cwd: КОРЕНЬ, maxBuffer: 64 * 1024 * 1024,
  });
  if (готово.status !== 0) throw new Error(`Сборщик базы отказал: ${готово.stderr}`);
  const ответ = JSON.parse(готово.stdout);
  if (ответ.error) throw new Error(`Сборщик базы отказал: ${ответ.error}`);
  return поднятьФайл(файл, экраны);
}

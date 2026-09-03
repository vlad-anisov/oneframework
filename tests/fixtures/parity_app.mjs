/**
 * То же приложение, объявленное **на JavaScript**.
 *
 * Близнец `tests/fixtures/parity_app.py`, и существует ради того же: задеть
 * каждый род узла и каждое умолчание, которое у двух привязок может разойтись.
 * Совпадение сторожит `tests/js/binding-parity.test.mjs`.
 *
 * Различия в записи -- законные и намеренные: `record` приезжает доводом, а не
 * берётся из воздуха, `item` -- доводом повторителя, настройки идут объектом.
 * Одинаковым обязан быть **документ**, а не текст.
 */

import {
  Accordion, Button, Col, Create, Delete, Filter, Group, Icon,
  List, Menu, Pill, Repeat, Row, Save, Screen, Search, Section, Sort, Tab, Tabs,
  Text, app, boolean, color, date, datetime, declare, float as float_, integer,
  many2one, model, monetary, selection, string, text, time, view,
  expr,
} from "../../../oneframework-js/index.mjs";

const Полка = model("Полка", {
  table: "полка",
  fields: { name: string("Название", { required: true }), color: color("Цвет") },
});

const Книга = model("Книга", {
  table: "книга",
  fields: {
    title: string("Заглавие", { required: true }),
    notes: text("Заметки"),
    shelf: many2one(Полка, "Полка"),
    read: boolean("Прочитана"),
    sequence: integer("Порядок"),
    pages: integer("Страниц", { maximum: 5000 }),
    weight: float_("Вес", { digits: [6, 2] }),
    price: monetary("Цена", { currency: "BYN" }),
    kind: selection([["proza", "Проза"], ["stihi", "Стихи"]], "Род"),
    bought: date("Куплена"),
    opened: datetime("Открыта"),
    alarm: time("Напоминание"),
  },
});

const Строка = view("Строка", {
  model: Книга,
  ui: (record) => Row(
    record.sequence({ widget: "handle" }),
    record.read({ widget: "toggle" }),
    record.title({ widget: "title" }),
    record.shelf({ widget: "tag" }),
    Button({ icon: "delete", action: record.delete() }),
  ),
});

const Карточка = view("Карточка", {
  model: Книга,
  crumbs: false,
  ui: (record) => [
    Section("Про книгу", "то, что видно с полки"),
    Group({ label: "Главное", cols: 2 },
          Col(6, record.title()),
          Col(6, record.kind())),
    Accordion(
      record.notes({ widget: "textarea" }),
      record.weight(),
      record.price(),
      { label: "Подробности", open: true },
    ),
    Button("Сохранить", { action: Save() }),
    Button("Удалить", { action: record.delete() }),
  ],
});

const Полки = view("Полки", {
  title: "Полки",
  state: { shelf: many2one(Полка, "Полка") },
  ui: (record, view_) => [
    view_.shelf({ widget: "chips" }),
    Tabs(
      Repeat(Полка, (item) => Tab(
        "{item.name}",
        Icon("book"),
        Pill(expr("count(Книга, record.shelf = item.id & !record.read)"),
             { when: "closed" }),
        Button({ place: "fab",
                 action: Книга.create({ open: Карточка, values: { shelf: item.id } }) }),
        List(Книга, {
          item: Строка,
          open: Карточка,
          label: "{item.name}",
          domain: expr("record.shelf = item.id & !record.read"),
          menu: Menu(
            Button("Новая книга", { action: Книга.create({ open: Карточка, draft: true }) }),
            Button("Удалить прочитанные", {
              action: Delete({
                model: Книга,
                domain: expr("record.shelf = item.id & record.read"),
                confirm: "Удалить прочитанное с «{item.name}»?",
              }),
              enabled: expr("exists(Книга, record.shelf = item.id & record.read)"),
            }),
            { icon: "more_horiz" },
          ),
          search: Search(
            record.title,
            Filter("Непрочитанные", expr("!record.read"), { default: true }),
            Filter("Прочитанные", record.read),
            Sort("По порядку", record.sequence, { default: true }),
            Sort("Позже куплённые", record.bought.desc(), { section: true }),
          ),
        }),
        Accordion(
          List(Книга, { item: Строка,
                        domain: expr("record.shelf = item.id & record.read") }),
          { label: "Прочитанные",
            visible: expr("exists(Книга, record.shelf = item.id & record.read)") },
        ),
      )),
      Button("Полка", { action: Create(Полка) }),
      { page: true },
    ),
  ],
});

const application = app({
  title: "Полки",
  models: [Полка, Книга],
  views: [Строка, Карточка, Полки],
  screens: [Screen(Полки, { label: "Полки", icon: "shelves" })],
  root: Полки,
});

export const пакет = () => declare(application);

// Вывозом по умолчанию, как всякое приложение: тем же путём его читает и
// сборка (`oneframework declare`), а не только проверка рядом.
export default application;

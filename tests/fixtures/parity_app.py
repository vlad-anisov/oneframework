"""Приложение, объявленное **на питоне**, ради сверки привязок.

Смысл у него один: задеть каждый род узла и каждое умолчание, которое у двух
привязок может разойтись. Приложением его никто не запускает -- это образец, а
не пример, и потому он живёт в `tests/`, а не в `examples/`.

Зачем он понадобился. Пятьдесят две проверки правил объявления приложены к
питоновской привязке. Другие держались сверкой документов
(`test_three_languages.py`), а та сверяет тройку `notes-*` -- модель, строка,
карточка, кнопка. После того как привязка на JavaScript догнала питоновскую по
составу узлов, сверять её стало нечем: богатого приложения, объявленного
дважды, не было.

Близнец -- `tests/fixtures/parity_app.mjs`. Совпадение сторожит
`tests/js/binding-parity.test.mjs`.
"""

from oneframework import (
    Accordion, App, Boolean, Button, Col, Color, Count, Create, Date, Datetime,
    Delete, Exists, Filter, Float, Group, Icon, Integer, List, Many2one, Menu,
    Model, Monetary, Pill, Repeat, Row, Save, Screen, Search, Section,
    Selection, Sort, String, Tab, Tabs, Text, Time, View, record, view,
)
from oneframework.model.expr import item


class Полка(Model):
    _table = "полка"
    name = String("Название", required=True)
    color = Color("Цвет")


class Книга(Model):
    _table = "книга"
    title = String("Заглавие", required=True)
    notes = Text("Заметки")
    shelf = Many2one(Полка, "Полка")
    read = Boolean("Прочитана")
    sequence = Integer("Порядок")
    pages = Integer("Страниц", maximum=5000)
    weight = Float("Вес", digits=(6, 2))
    price = Monetary("Цена", currency="BYN")
    kind = Selection([("proza", "Проза"), ("stihi", "Стихи")], "Род")
    bought = Date("Куплена")
    opened = Datetime("Открыта")
    alarm = Time("Напоминание")


class Строка(View):
    model = Книга

    def ui(self, record):
        return Row(
            record.sequence(widget="handle"),
            record.read(widget="toggle"),
            record.title(widget="title"),
            record.shelf(widget="tag"),
            Button(icon="delete", action=record.delete()),
        )


class Карточка(View):
    model = Книга
    crumbs = False

    def ui(self, record):
        return (
            Section("Про книгу", "то, что видно с полки"),
            Group(
                Col(record.title(), span=6),
                Col(record.kind(), span=6),
                label="Главное",
                cols=2,
            ),
            Accordion(
                record.notes(widget="textarea"),
                record.weight(),
                record.price(),
                label="Подробности",
                open=True,
            ),
            Button("Сохранить", action=Save()),
            Button("Удалить", action=record.delete()),
        )


class Полки(View):
    _title = "Полки"
    shelf = Many2one(Полка, "Полка")

    def ui(self, record):
        return (
            view.shelf(widget="chips"),
            Tabs(
                Repeat(
                    Полка,
                    Tab(
                        "{item.name}",
                        Icon("book"),
                        Pill(Count(Книга, (record.shelf == item.id) & ~record.read),
                             when="closed"),
                        Button(place="fab",
                               action=Книга.create(open=Карточка,
                                                   values={"shelf": item.id})),
                        List(
                            Книга,
                            item=Строка,
                            open=Карточка,
                            label="{item.name}",
                            domain=(record.shelf == item.id) & ~record.read,
                            menu=Menu(
                                Button("Новая книга",
                                       action=Книга.create(open=Карточка, draft=True)),
                                Button(
                                    "Удалить прочитанные",
                                    action=Delete(
                                        Книга,
                                        domain=(record.shelf == item.id) & record.read,
                                        confirm="Удалить прочитанное с «{item.name}»?",
                                    ),
                                    enabled=Exists(Книга,
                                                   (record.shelf == item.id) & record.read),
                                ),
                                icon="more_horiz",
                            ),
                            search=Search(
                                record.title,
                                Filter("Непрочитанные", ~record.read, default=True),
                                Filter("Прочитанные", record.read),
                                Sort("По порядку", record.sequence, default=True),
                                Sort("Позже куплённые", record.bought.desc(), section=True),
                            ),
                        ),
                        Accordion(
                            List(Книга, item=Строка,
                                 domain=(record.shelf == item.id) & record.read),
                            label="Прочитанные",
                            visible=Exists(Книга, (record.shelf == item.id) & record.read),
                        ),
                    ),
                ),
                Button("Полка", action=Create(Полка)),
                page=True,
            ),
        )


app = App(Screen(Полки, label="Полки", icon="shelves"), title="Полки")

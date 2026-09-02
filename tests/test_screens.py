"""Разделы верхнего уровня -- со стороны **объявления**.

Здесь остались правила питоновской привязки: в каком порядке разделы встают,
что о них рассказывает `meta()`, и на что она отказывает. Всё, что решает
рантайм, -- какой стек активен, что за кадр открыт, каким путём список читает
записи -- переехало в `tests/js/screens.test.mjs`: там оно и исполняется.
"""

import pytest

from oneframework import App, Boolean, List, Model, Row, Screen, String, View
from oneframework.errors import DslError
from jsrt import Рантайм, needs_node


class Note(Model):
    title = String("Title", required=True)
    done = Boolean("Done")


class Person(Model):
    name = String("Name", required=True)


class NoteItem(View):
    model = Note

    def ui(self, record):
        return Row(record.title(widget="title"))


class NoteDetail(View):
    model = Note

    def ui(self, record):
        return (record.title(), record.done())


class Notes(View):
    def ui(self, record):
        return (List(Note, item=NoteItem, open=NoteDetail),)


class PersonItem(View):
    model = Person

    def ui(self, record):
        return Row(record.name(widget="title"))


class People(View):
    def ui(self, record):
        return (List(Person, item=PersonItem),)


@pytest.fixture
def app():
    return App(
        Screen(Notes, label="Заметки", icon="doc"),
        Screen(People, label="Люди", icon="people"),
        title="Two",
    )


def test_screens_keep_declaration_order(app):
    assert [s.key for s in app.screens] == ["Notes", "People"]
    assert [s.label for s in app.screens] == ["Заметки", "Люди"]
    assert [s.icon for s in app.screens] == ["doc", "people"]


def test_sequence_overrides_declaration_order():
    a = App(Screen(People, sequence=20), Screen(Notes, sequence=10), title="Ordered")
    assert [s.key for s in a.screens] == ["Notes", "People"]


@needs_node
def test_meta_exposes_screens(app):
    """`meta()` -- то, что оболочка читает до базы, и раскладку она уже знает.

    Рантайм поднимается затем, что `master_detail` -- вопрос к **дереву**, а
    дерево есть только у того, кто рисует. Что раскладка вправду следует за
    видом списка, проверяет `tests/js/screens.test.mjs`.
    """
    рт = Рантайм(app)
    try:
        assert app.meta()["screens"][1] == {
            "key": "People", "label": "Люди", "icon": "people", "view": "People",
            "master_detail": True,
        }
    finally:
        рт.close()


def test_a_bare_view_is_one_screen():
    a = App(Notes, title="Solo")
    assert [s.key for s in a.screens] == ["Notes"]
    assert a.root_view is Notes


def test_screen_needs_a_view():
    with pytest.raises(DslError):
        Screen(object())


def test_app_rejects_a_non_view():
    with pytest.raises(DslError):
        App(42)

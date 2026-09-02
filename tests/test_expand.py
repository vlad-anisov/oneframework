"""Вид как документ -- со стороны **объявления**.

Документ не знает ни одной записи: имена в нём ссылки, условия -- выражения,
повторитель -- узел. Здесь проверяется, что привязка кладёт в него именно это,
и как разбирается шаблон.

Другая половина той же границы -- разворот, где документ встречается с
данными, -- исполняется рантаймом устройства, и проверяется она там:
`tests/js/expand.test.mjs`.
"""

import json

import pytest

from oneframework import (
    Accordion, App, Boolean, Button, Count, Delete, Exists, List, Many2one,
    Menu, Model, Pill, Repeat, Row, String, Tab, Tabs, View,
)
from oneframework.errors import DslError
from oneframework.model.expr import Expr, Ref, Template, item, iter_refs, parse_template
from oneframework.model.exprjson import from_json, to_json
from oneframework.ui.view import document




class Board(Model):
    name = String("Название")


class Task(Model):
    title = String("Задача")
    done = Boolean("Выполнено")
    board = Many2one(Board, "Список")


class TaskRow(View):
    model = Task

    def ui(self, record):
        return Row(record.title(), record.done(widget="checkbox"))


class Boards(View):
    _title = "Списки"

    def ui(self, record):
        return Tabs(
            Repeat(
                Board,
                Tab(
                    "{item.name}",
                    Pill(Count(Task, (record.board == item.id) & ~record.done)),
                    List(
                        Task,
                        item=TaskRow,
                        label="{item.name}",
                        domain=(record.board == item.id) & ~record.done,
                        menu=Menu(
                            Button(
                                "Удалить выполненные",
                                action=Delete(
                                    Task,
                                    domain=(record.board == item.id) & record.done,
                                    confirm="Удалить всё выполненное в «{item.name}»?",
                                ),
                                enabled=Exists(
                                    Task, (record.board == item.id) & record.done
                                ),
                            ),
                        ),
                    ),
                    Accordion(
                        List(Task, item=TaskRow,
                             domain=(record.board == item.id) & record.done),
                        label="Выполненные",
                        visible=Exists(Task, (record.board == item.id) & record.done),
                    ),
                ),
            ),
        )


# ------------------------------------------------------------------ шаблоны
def test_a_plain_string_stays_a_plain_string():
    assert parse_template("Выполненные") == "Выполненные"


def test_a_reference_makes_it_a_template():
    tmpl = parse_template("Удалить «{item.name}»?")
    assert isinstance(tmpl, Template)
    assert to_json(tmpl) == {"fmt": ["Удалить «", {"i": "name"}, "»?"]}


def test_a_template_survives_json():
    tmpl = parse_template("{item.name}: осталось")
    assert to_json(from_json(json.loads(json.dumps(to_json(tmpl))))) == to_json(tmpl)


def test_other_scopes_say_so_rather_than_printing_braces():
    with pytest.raises(DslError) as excinfo:
        parse_template("Удалить «{record.name}»?")
    assert "record.name" in str(excinfo.value)


# ----------------------------------------------------------------- документ
def test_the_document_needs_neither_a_frame_nor_a_record():
    doc = document(Boards)
    assert doc["type"] == "view" and doc["name"] == "Boards"
    assert json.dumps(doc)                      # едет по проводу как есть


def test_the_document_keeps_the_repeat_rather_than_its_result():
    repeat = document(Boards)["children"][0]["children"][0]
    assert repeat["type"] == "repeat" and repeat["model"] == "Board"


def test_the_document_keeps_names_as_references():
    tab = document(Boards)["children"][0]["children"][0]["children"][0]
    assert tab["label"] == {"fmt": [{"i": "name"}]}


def test_the_document_carries_the_aggregate_and_not_its_value():
    """Число протухает от каждой правки задачи, объявление -- нет."""
    tab = document(Boards)["children"][0]["children"][0]["children"][0]
    accordion = tab["children"][1]
    assert accordion["visible"]["agg"] == "exists"
    assert accordion["visible"]["model"] == "Task"


def test_the_document_lands_in_the_database_beside_the_data():
    """Документ вида кладётся в базу выкладкой -- рантайм тут ни при чём.

    Спрашивается план выкладки: он и отвечает, что поедет в базу. Саму запись
    делает сборщик на JS, и её проверяет `test_build_db.py`.
    """
    from oneframework.cli.plan import build_plan

    план = build_plan(_пакетом(App(Boards, title="Развороты")))
    поедет = {и: д for в, и, д in план["defs"] if в == "view"}
    assert поедет.get("Boards") == document(Boards)


def _пакетом(app, seed=None):
    """Приложение -> пакет объявления: дорога в план теперь одна.

    Своей проверки здесь нет -- что пакет несёт всё, стережёт
    `test_plan_one_road.py`. Здесь только перевод.
    """
    from oneframework.declaration import Bundle, declare

    return Bundle(declare(app, seed))

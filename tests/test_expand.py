"""Вид как документ: шаблон, данные, дерево.

Проверяется ровно та граница, ради которой всё это затевалось. Документ не
знает ни одной записи: имена в нём ссылки, условия -- выражения, повторитель --
узел. Дерево знает всё: строки сложены, агрегаты посчитаны, вкладок столько,
сколько списков в базе. Между ними -- разворот, и он единственное место, где
данные встречаются с шаблоном.
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

from jsrt import Рантайм, needs_node

pytestmark = needs_node


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


@pytest.fixture()
def runtime():
    app = App(Boards, title="Развороты")

    def seed(database):
        work = database.create(Board, {"name": "Работа"})
        home = database.create(Board, {"name": "Дом"})
        database.create(Task, {"title": "Отчёт", "board": work})
        database.create(Task, {"title": "Созвон", "board": work, "done": True})
        database.create(Task, {"title": "Молоко", "board": home})

    #: Посев исполняет питон при выкладке -- он и есть язык объявления. Дальше
    #: база живёт **у хоста**: правки идут туда, и спрашивать про них
    #: питоновскую копию было бы тише всего и неверно.
    rt = Рантайм(app, seed=seed)
    yield rt
    rt.close()


def tabs_of(runtime):
    tree = runtime.stack[-1].tree
    return next(c for c in tree["children"] if c["type"] == "tabs")["children"]


def list_of(tab):
    return next(c for c in tab["children"] if c["type"] == "list")


def titles_of(tab):
    from conftest import bound_rows

    def cells(nodes):
        for node in nodes:
            yield node
            yield from cells(node.get("children") or ())

    return [
        next(n for n in cells(row["children"]) if n.get("name") == "title")["value"]
        for row in bound_rows(list_of(tab))
    ]


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


# ------------------------------------------------------------------ разворот
def test_the_repeat_becomes_one_tab_per_record(runtime):
    assert [t["label"] for t in tabs_of(runtime)] == ["Работа", "Дом"]


def test_a_board_added_later_gets_its_tab(runtime):
    """То, ради чего повторитель и нужен: структура следует за данными."""
    runtime.db.create(Board, {"name": "Отпуск"})
    runtime.touch(Board)
    assert [t["label"] for t in tabs_of(runtime)] == ["Работа", "Дом", "Отпуск"]


def test_each_copy_filters_on_its_own_record(runtime):
    work, home = tabs_of(runtime)
    assert titles_of(work) == ["Отчёт"]
    assert titles_of(home) == ["Молоко"]


def test_ids_stay_unique_across_the_copies(runtime):
    ids = [t["id"] for t in tabs_of(runtime)]
    assert len(ids) == len(set(ids))


def test_a_condition_the_data_answers_decides_whether_the_node_exists(runtime):
    """`visible=Exists(...)` -- это питоновский `if`, сказанный как условие."""
    work, home = tabs_of(runtime)
    assert [c["type"] for c in work["children"]] == ["list", "accordion"]
    assert [c["type"] for c in home["children"]] == ["list"]


def test_enabled_follows_the_data_too(runtime):
    work, home = tabs_of(runtime)
    assert list_of(work)["menu"]["children"][0]["enabled"] is True
    assert list_of(home)["menu"]["children"][0]["enabled"] is False


def test_the_question_names_the_record_it_is_about(runtime):
    button = list_of(tabs_of(runtime)[0])["menu"]["children"][0]
    assert button["action"]["confirm"] == "Удалить всё выполненное в «Работа»?"


def test_a_count_is_data_and_follows_it(runtime):
    counts = [t["title"][-1]["value"] for t in tabs_of(runtime)]
    assert counts == ["1", "1"]
    runtime.db.create(Task, {"title": "Ещё", "board": runtime.db.all(Board)[0]["id"]})
    runtime.touch(Task)
    assert [t["title"][-1]["value"] for t in tabs_of(runtime)] == ["2", "1"]


def test_nothing_unanswered_reaches_the_renderer(runtime):
    """Развёрнутое дерево не несёт ни одного вопроса -- ни в меню, ни в строке."""
    def every(node):
        yield node
        for value in node.values():
            if isinstance(value, list):
                for child in value:
                    if isinstance(child, dict):
                        yield from every(child)
            elif isinstance(value, dict) and "type" in value:
                yield from every(value)

    seen = 0
    for node in every(runtime.stack[-1].tree):
        for key in ("visible", "enabled", "value", "label", "confirm"):
            assert not isinstance(node.get(key), dict), \
                f"{node.get('type')}.{key}: {node[key]!r}"
        seen += 1
    assert seen > 20                            # дерево и правда обошли


def test_deleting_by_domain_removes_what_is_there_when_it_is_pressed(runtime):
    """Список номеров снимается при сборке экрана; домен -- при нажатии."""
    button = list_of(tabs_of(runtime)[0])["menu"]["children"][0]
    board = runtime.db.all(Board)[0]["id"]
    # Ещё одна выполненная задача появляется уже после того, как экран нарисован.
    runtime.db.create(Task, {"title": "Поздняя", "board": board, "done": True})

    runtime.dispatch({"type": "action", "button_id": button["id"],
                      "context": button["context"]})
    left = [t["title"] for t in runtime.db.all(Task) if t["board"] == board]
    assert left == ["Отчёт"]

# --------------------------------------------------------------- копия тела
# Повторитель копирует тело по разу на запись. До 21.08.2026 здесь стояли две
# проверки на внутренности питоновского `_clone`: что копия ничего не делит с
# оригиналом из того, что правит, и НЕ заводит второго экземпляра того, что
# только читает (деревьев условий и полей модели). Второе было замером: общий
# `deepcopy` съедал 66% всего разворота самого тяжёлого вида.
#
# На устройстве копия делается `structuredClone` -- полная, включая деревья
# условий. И это не недосмотр: там копируется **JSON**, а не живые объекты, и
# номера узлов правятся на месте (`value.id = ...`), так что общий объект
# испортил бы оригинал. То есть правило «делить читаемое» питоновское по
# природе и на JS неверно -- переносить его было бы неправдой.
#
# Первое правило -- «копии не пишут друг поверх друга» -- никуда не делось, но
# проверяется по следствию, а не по адресам объектов:
# `test_each_copy_filters_on_its_own_record` (каждая вкладка отбирает по своей
# записи) и `test_ids_stay_unique_across_the_copies` (номера не сталкиваются).
# Поделись копии изменяемым -- обе покраснеют.


def _пакетом(app, seed=None):
    """Приложение -> пакет объявления: дорога в план теперь одна.

    Своей проверки здесь нет -- что пакет несёт всё, стережёт
    `test_plan_one_road.py`. Здесь только перевод.
    """
    from oneframework.declaration import Bundle, declare

    return Bundle(declare(app, seed))

"""End-to-end runtime behaviour, driven headlessly against the demo app.

These exercise the same code path the browser uses -- queries, reactivity,
navigation, CRUD and reorder -- without needing a browser.
"""

import pytest

from conftest import the_list, titles
from jsrt import ОтказJs, Рантайм, needs_node
from oneframework import (
    App, Boolean, Button, Filter, Integer, List, Model, Search, Sort, String, View, record,
)


#: Модель и вид объявлены **здесь**, а не взяты у демо-приложения, и на уровне
#: модуля, а не внутри проверки. Обе оговорки от одного правила выкладки
#: (``_defined_in``): она ищет классы в пространстве имён модуля и берёт
#: только те, чей пакет совпадает с пакетом приложения. Класс из тела функции
#: туда не попадает вовсе, а вид из чужого пакета уехал бы без своих моделей --
#: приложение пришло бы к рантайму пустым, и проверка бы это проглотила.
class Заметка(Model):
    _table = "заметка"
    text = String("Текст")
    completed = Boolean("Выполнена")
    sequence = Integer("Порядок")


class Невыполнимый(View):
    """Вид с фильтром, под который нет ни одного значения."""

    def ui(self, _record):
        return (
            Button(place="fab", action=Заметка.create()),
            List(Заметка,
                 search=Search(
                     record.text,
                     # Через «или» -- значит одного значения нет: новая запись
                     # не может быть одновременно и той, и другой.
                     Filter("Любая", record.completed | ~record.completed, default=True),
                     Sort("По порядку", record.sequence, default=True),
                 )),
        )


#: Рантайм -- тот, что стоит на устройстве. До 21.08.2026 здесь поднимался
#: питоновский эталон; проверки при этом описывали поведение приложения, а не
#: питона, и потому переехали целиком, не меняя ни одного утверждения.
#:
#: База берётся **у хоста**: правки живут в его памяти, и питоновская копия,
#: из которой приложение выложили, о них не знает. Спрашивать её было бы тише
#: всего -- и неверно.
@pytest.fixture()
def runtime(todo_app):
    import seed as seed_module

    r = Рантайм(todo_app.app, seed=seed_module.seed)
    yield r
    r.close()


@pytest.fixture()
def db(runtime):
    return runtime.db


def list_id(runtime):
    return the_list(runtime)["id"]


def fab(runtime):
    """The screen's floating action -- `Button(place="fab")`, lifted to the bar."""
    return next(b for b in runtime.stack[0].tree["navbar_buttons"] if b["place"] == "fab")


def press(runtime, button):
    runtime.dispatch({"type": "action", "button_id": button["id"],
                      "context": button["context"]})


def tag_choices(runtime):
    field = next(c for c in runtime.stack[0].tree["children"] if c["type"] == "field")
    return {c["display"]: c["id"] for c in field["choices"]}


# ------------------------------------------------------------------ filters
def test_default_filter_is_applied_on_boot(runtime):
    assert the_list(runtime)["state"]["filter"] == 0
    assert "Оплатить интернет" not in titles(runtime)
    assert len(titles(runtime)) == 4


def test_switching_filters_requeries(runtime):
    runtime.dispatch({"type": "set_filter", "list_id": list_id(runtime), "index": 1})
    assert sorted(titles(runtime)) == sorted(["Оплатить интернет", "Прочитать книгу"])


def test_clearing_the_filter_shows_everything(runtime):
    runtime.dispatch({"type": "set_filter", "list_id": list_id(runtime), "index": None})
    assert len(titles(runtime)) == 6


# ------------------------------------------------------------------- search
def test_search_is_case_insensitive_for_cyrillic(runtime):
    runtime.dispatch({"type": "set_search", "list_id": list_id(runtime), "value": "МОЛОКО"})
    assert titles(runtime) == ["Купить молоко"]
    runtime.dispatch({"type": "set_search", "list_id": list_id(runtime), "value": ""})
    assert len(titles(runtime)) == 4


def test_search_matches_a_substring(runtime):
    runtime.dispatch({"type": "set_search", "list_id": list_id(runtime), "value": "звонить"})
    assert titles(runtime) == ["Позвонить в сервис"]


# ---------------------------------------------------------------- view state
def test_unset_tag_shows_every_record(runtime):
    assert len(titles(runtime)) == 4, "UNSET must not filter on tag IS NULL"


def test_selecting_a_tag_filters_the_list(runtime):
    choices = tag_choices(runtime)
    runtime.dispatch({
        "type": "set_state", "screen_id": runtime.stack[0].id,
        "field": "tag", "value": choices["Личное"],
    })
    assert sorted(titles(runtime)) == sorted(["Позвонить в сервис", "Записаться к врачу"])


def test_clearing_the_tag_restores_every_record(runtime):
    choices = tag_choices(runtime)
    screen = runtime.stack[0].id
    runtime.dispatch({"type": "set_state", "screen_id": screen, "field": "tag",
                      "value": choices["Работа"]})
    assert len(titles(runtime)) == 1
    runtime.dispatch({"type": "set_state", "screen_id": screen, "field": "tag",
                      "value": None})
    assert len(titles(runtime)) == 4


# -------------------------------------------------------------------- sorts
def test_created_at_desc_puts_the_newest_first(runtime):
    runtime.dispatch({"type": "set_sort", "list_id": list_id(runtime), "index": 1})
    assert titles(runtime)[0] == "Записаться к врачу"


def test_reorder_is_only_offered_for_the_sequence_sort(runtime):
    assert the_list(runtime)["reorderable"] is True
    runtime.dispatch({"type": "set_sort", "list_id": list_id(runtime), "index": 1})
    assert the_list(runtime)["reorderable"] is False


def test_drag_reorder_rewrites_the_handle_field(runtime, todo_app, db):
    ids = [row["id"] for row in the_list(runtime)["rows"]]
    before = titles(runtime)
    # move the third row to the top
    runtime.dispatch({"type": "reorder", "list_id": list_id(runtime),
                      "record_id": ids[2], "from": 2, "to": 0})

    assert titles(runtime)[0] == before[2]
    assert db.read(todo_app.TodoLine, ids[2])["sequence"] == 10
    assert db.read(todo_app.TodoLine, ids[0])["sequence"] == 20


def test_reorder_is_a_no_op_when_nothing_moves(runtime, todo_app, db):
    ids = [row["id"] for row in the_list(runtime)["rows"]]
    before = titles(runtime)
    runtime.dispatch({"type": "reorder", "list_id": list_id(runtime),
                      "record_id": ids[1], "from": 1, "to": 1})
    assert titles(runtime) == before


def test_paging_reports_whether_more_rows_exist(runtime):
    lst = the_list(runtime)
    assert lst["has_more"] is False
    assert lst["limit"] == 60

    runtime.dispatch({"type": "set_filter", "list_id": list_id(runtime), "index": None})
    assert len(the_list(runtime)["rows"]) == 6


def test_load_more_widens_the_window(runtime):
    lid = list_id(runtime)
    runtime.dispatch({"type": "load_more", "list_id": lid})
    assert the_list(runtime)["limit"] == 120


def test_changing_the_query_resets_paging(runtime):
    lid = list_id(runtime)
    runtime.dispatch({"type": "load_more", "list_id": lid})
    assert the_list(runtime)["limit"] == 120
    runtime.dispatch({"type": "set_search", "list_id": lid, "value": "о"})
    assert the_list(runtime)["limit"] == 60


# --------------------------------------------------------------- reactivity
def test_writing_a_record_invalidates_the_list_without_an_explicit_refresh(runtime):
    row_id = the_list(runtime)["rows"][0]["id"]
    runtime.dispatch({"type": "write", "model": "TodoLine", "record_id": row_id,
                      "values": {"completed": True}})
    assert "Купить молоко" not in titles(runtime)


def test_editing_text_updates_the_rendered_row(runtime):
    row_id = the_list(runtime)["rows"][0]["id"]
    runtime.dispatch({"type": "write", "model": "TodoLine", "record_id": row_id,
                      "values": {"text": "Купить кефир"}})
    assert "Купить кефир" in titles(runtime)


# --------------------------------------------------------------- navigation
def test_open_pushes_a_detail_screen_titled_by_the_record(runtime):
    row_id = the_list(runtime)["rows"][0]["id"]
    runtime.dispatch({"type": "open", "list_id": list_id(runtime), "record_id": row_id})
    assert len(runtime.stack) == 2
    assert runtime.stack[-1].tree["view"] == "TodoLineDetail"
    assert runtime.stack[-1].tree["title"] == "Купить молоко"


def test_back_pops_the_stack(runtime):
    row_id = the_list(runtime)["rows"][0]["id"]
    runtime.dispatch({"type": "open", "list_id": list_id(runtime), "record_id": row_id})
    runtime.dispatch({"type": "back"})
    assert len(runtime.stack) == 1


# --------------------------------------------------------------------- CRUD
def _button(tree_children):
    from conftest import flat

    return next(c for c in flat(tree_children) if c["type"] == "button")


def test_delete_from_a_row_does_not_navigate(runtime, todo_app, db):
    from conftest import bound_rows

    row = bound_rows(the_list(runtime))[0]
    button = _button(row["children"])
    assert button["context"]["in_row"] is True

    runtime.dispatch({"type": "action", "button_id": button["id"],
                      "context": button["context"]})
    assert len(runtime.stack) == 1
    assert db.read(todo_app.TodoLine, row["id"]) is None


def test_delete_from_the_detail_closes_the_screen(runtime, todo_app, db):
    row_id = the_list(runtime)["rows"][0]["id"]
    runtime.dispatch({"type": "open", "list_id": list_id(runtime), "record_id": row_id})
    button = _button(runtime.stack[-1].tree["children"])
    assert button["context"]["in_row"] is False

    runtime.dispatch({"type": "action", "button_id": button["id"],
                      "context": button["context"]})
    assert len(runtime.stack) == 1
    assert db.read(todo_app.TodoLine, row_id) is None


def test_create_opens_the_detail_and_seeds_the_handle_field(runtime, todo_app, db):
    before = db.count(todo_app.TodoLine)
    press(runtime, fab(runtime))

    assert db.count(todo_app.TodoLine) == before + 1
    assert runtime.stack[-1].tree["view"] == "TodoLineDetail"
    new_id = runtime.stack[-1].record_id
    assert db.read(todo_app.TodoLine, new_id)["sequence"] == 70


def test_create_inherits_the_selected_tag(runtime, todo_app, db):
    choices = tag_choices(runtime)
    runtime.dispatch({"type": "set_state", "screen_id": runtime.stack[0].id,
                      "field": "tag", "value": choices["Работа"]})
    press(runtime, fab(runtime))
    new_id = runtime.stack[-1].record_id
    assert db.read(todo_app.TodoLine, new_id)["tag"] == choices["Работа"]


def test_create_satisfies_the_filter_in_force(runtime, todo_app, db):
    """A row made while a filter is on has to be one the filter admits.

    Otherwise it is inserted, the list re-queries without it, and the button
    reads as having done nothing.
    """
    # "Выполнено" is the second filter of the list -- completed == True.
    runtime.dispatch({"type": "set_filter", "list_id": list_id(runtime), "index": 1})
    press(runtime, fab(runtime))
    new_id = runtime.stack[-1].record_id
    assert db.read(todo_app.TodoLine, new_id)["completed"] is True


def test_a_filter_beyond_seeding_refuses_to_create():
    """Фильтр, которому не удовлетворит ни одна запись, -- ошибка, и она
    называется у самого «+».

    Фильтр **объявляется** видом ``Невыполнимый`` выше, а не подменяется на
    живом объекте: раньше проверка лезла внутрь рантайма и правила
    ``filter.domain`` прямо в нём. Так можно было, пока рантайм жил в том же
    процессе; теперь он на устройстве, и приложение попадает к нему той же
    дорогой, что настоящее.
    """
    рт = Рантайм(App(Невыполнимый, title="Невыполнимый"))
    try:
        with pytest.raises(ОтказJs, match="нет одного значения"):
            press(рт, fab(рт))
    finally:
        рт.close()


def test_an_untouched_new_record_is_discarded_on_back(runtime, todo_app, db):
    before = db.count(todo_app.TodoLine)
    press(runtime, fab(runtime))
    runtime.dispatch({"type": "back"})
    assert db.count(todo_app.TodoLine) == before


def test_a_filled_new_record_is_kept(runtime, todo_app, db):
    before = db.count(todo_app.TodoLine)
    press(runtime, fab(runtime))
    new_id = runtime.stack[-1].record_id
    runtime.dispatch({"type": "write", "model": "TodoLine", "record_id": new_id,
                      "values": {"text": "Новая задача"}})
    runtime.dispatch({"type": "back"})
    assert db.count(todo_app.TodoLine) == before + 1
    assert "Новая задача" in titles(runtime)


# ------------------------------------------------------------------ seeding
#: Здесь стояла ``test_seed_runs_once``: повторная выкладка не сеет заново.
#: Правило живо, но переехало туда, где посев теперь и происходит --
#: ``test_build_db.py``: ``test_a_seed_runs_once_even_when_the_build_is_repeated``
#: и ``test_a_marker_from_an_older_framework_is_adopted``. Проверять его на
#: `App.publish` значило бы стеречь дорогу, которой сборка больше не ходит.


# ---------------------------------------------------------------- relations
def test_row_relations_carry_display_and_colour(runtime):
    from conftest import bound_rows, flat

    row = bound_rows(the_list(runtime))[0]
    tag = next(c for c in flat(row["children"]) if c.get("name") == "tag")
    assert tag["related"]["display"] == "Покупки"
    assert tag["related"]["color"].startswith("#")
    assert tag["comodel"]["display_field"] == "name"
    assert tag["comodel"]["color_field"] == "color"

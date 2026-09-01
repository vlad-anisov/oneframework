"""Запись, которой нет, пока её не сохранили.

Так устроены обе платформы -- дочерний контекст на iOS, ViewModel на Android, --
и виртуальная запись Odoo. Пока форма открыта, до таблицы не доходит ничего, а
отменённый черновик не оставляет следа вовсе.

Спрашивается тот рантайм, что стоит на устройстве. До 21.08.2026 спрашивался
питоновский эталон: у него был свой `Draft`, и совпадение двух держала сверка.
Так доказывалось согласие копий, но не верность работающей.
"""

from __future__ import annotations

import pytest

from jsrt import ОтказJs, Рантайм, needs_node

pytestmark = needs_node

#: Кадр черновика открывается видом-карточкой -- тем же, что открывает кнопка
#: «создать» в самом приложении.
КАРТОЧКА = "TodoLineDetail"


@pytest.fixture()
def рт(todo_app):
    import seed as seed_module

    r = Рантайм(todo_app.app, seed=seed_module.seed)
    yield r
    r.close()


def test_a_draft_reads_as_a_record_with_no_id(рт, todo_app):
    рт.call("draft_new", "d", "TodoLine")
    row = рт.call("draft_read", "d")
    assert row["id"] is None
    assert set(row) >= set(todo_app.TodoLine._fields)


def test_writing_a_draft_touches_no_table(рт):
    before = рт.count("TodoLine")
    рт.call("draft_new", "d", "TodoLine")
    рт.call("draft_write", "d", {"text": "Черновик"})
    assert рт.call("draft_values", "d")["text"] == "Черновик"
    assert рт.count("TodoLine") == before


def test_saving_a_draft_inserts_exactly_one_row(рт):
    before = рт.count("TodoLine")
    рт.call("draft_new", "d", "TodoLine")
    рт.call("draft_write", "d", {"text": "Сохранить меня"})
    record_id = рт.call("draft_save", "d")
    assert рт.count("TodoLine") == before + 1
    assert рт.call("read", "TodoLine", record_id)["text"] == "Сохранить меня"


def test_a_child_draft_is_inserted_with_its_parent_id(рт):
    """В этом весь смысл вложенности: ребёнок не может знать ключ заранее."""
    рт.call("draft_new", "родитель", "Tag")
    рт.call("draft_write", "родитель", {"name": "Родитель"})
    рт.call("draft_new", "ребёнок", "TodoLine")
    рт.call("draft_write", "ребёнок", {"text": "Ребёнок"})
    рт.call("draft_add_child", "родитель", "tag", "ребёнок")

    parent_id = рт.call("draft_save", "родитель")
    saved = [r for r in рт.call("all", "TodoLine") if r["text"] == "Ребёнок"]
    assert len(saved) == 1
    assert saved[0]["tag"] == parent_id


def test_an_edited_draft_reports_itself_as_touched(рт):
    рт.call("draft_new", "d", "TodoLine")
    assert not рт.call("draft_touched", "d")
    рт.call("draft_write", "d", {"text": "что-то"})
    assert рт.call("draft_touched", "d")


def test_editing_a_draft_bumps_its_revision(рт):
    """Экран перерисовывается, потому что черновик реактивен, как таблица."""
    рт.call("draft_new", "d", "TodoLine")
    before = рт.call("draft_rev", "d")
    рт.call("draft_write", "d", {"text": "правка"})
    assert рт.call("draft_rev", "d") > before


def test_a_write_to_a_draft_screen_never_reaches_the_table(рт):
    before = рт.count("TodoLine")
    кадр = рт.call("push_draft", КАРТОЧКА, "TodoLine")
    рт.dispatch({"type": "write", "model": "TodoLine", "record_id": None,
                 "screen_id": кадр["id"], "values": {"text": "Не в базе"}})
    assert рт.count("TodoLine") == before
    assert рт.call("frame_draft_values", кадр["id"])["text"] == "Не в базе"


def test_leaving_a_draft_screen_leaves_no_row(рт):
    before = рт.count("TodoLine")
    кадр = рт.call("push_draft", КАРТОЧКА, "TodoLine")
    рт.dispatch({"type": "write", "model": "TodoLine", "record_id": None,
                 "screen_id": кадр["id"], "values": {"text": "Передумал"}})
    рт.dispatch({"type": "back"})
    assert рт.count("TodoLine") == before


def test_writing_a_missing_record_that_is_no_draft_is_an_error(рт):
    with pytest.raises(ОтказJs):
        рт.dispatch({"type": "write", "model": "TodoLine", "record_id": None,
                     "screen_id": рт.stack[-1].id, "values": {"text": "никуда"}})

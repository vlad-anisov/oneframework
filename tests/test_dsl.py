"""Field references, expressions, context proxies and UNSET.

This is the least conventional part of the framework, so it gets the most tests.

A `ui` method is built per render, so the checks that used to run at import now
run in :func:`build_ui`. That is what these tests call: it is the same code the
screen runs, one step short of needing a database.
"""

import json

import pytest

from oneframework import (
    Boolean,
    Color,
    Integer,
    Many2one,
    Model,
    Row,
    Search,
    Sort,
    String,
    Text,
    UNSET,
    View,
    record,
    view,
)
from oneframework import Button, Create, Delete, Filter, Icon, List, Open, Pill, Tab
from oneframework.errors import DslError
from oneframework.model.expr import Cmp, Not, Order, RecordFieldRef, ViewFieldRef
from oneframework.model.fields import Field
from oneframework.model.exprjson import to_json

from jsrel import call, needs_node

pytestmark = needs_node


def QueryContext(model, view_state=None):
    """Обстановка выборки в той записи, которой её получает устройство.

    Питоновская обёртка `model.query` держала эти правила, пока была эталоном.
    Держит их теперь компилятор с устройства, а сюда переехало ровно то, что
    сюда и относится: перевод объявления (`record.tag`) в колонку (`tag_id`).
    """
    поля = [{"name": f.name, "column": f.column, "ftype": f.ftype, "stored": f.stored}
            for f in model._fields.values()] if model is not None else None
    return {"model": {"table": model._table, "fields": поля} if model is not None else None,
            #: UNSET печатается узлом, а не пропуском ключа: пропуск значит то
            #: же самое, но проверять надо ту запись, которую шлёт экран.
            "state": {к: ({"unset": True} if з is UNSET else з)
                      for к, з in (view_state or {}).items()},
            "alias": "t"}


def _одна(ctx, работа):
    ответ = call("compile_query", json.dumps({"ctx": ctx, "ops": [работа]},
                                             ensure_ascii=False))[0]
    if "error" in ответ:
        raise DslError(ответ["error"]["message"])
    return ответ["ok"]


def compile_domain(expr, ctx):
    ok = _одна(ctx, {"do": "domain", "node": to_json(expr)})
    return ok["sql"], ok["params"]


def видно(узел, запись, состояние=None):
    """Виден ли узел -- по тому вычислителю, который это и решает.

    Питоновский был вторым и удалён 21.08.2026. Перед удалением оба сверены на
    этих же случаях; разошлись они ровно в одном -- **пропущенный ключ записи**.
    У JS такой ключ значит «не выбрано» и расширяет условие, у питона значил
    «нет значения». На устройстве случай недостижим: колонка приходит из базы
    всегда, пустая приезжает как `null`, и на `null` обе стороны отвечали
    одинаково. Поэтому проверка спрашивает про `null`, а не про пропуск.
    """
    если = узел.visible
    if isinstance(если, bool):
        return если
    return call("evaluate", to_json(если), запись, состояние or {})


def compile_order(terms, ctx):
    return _одна(ctx, {"do": "order", "terms": [to_json(t) for t in terms]})["sql"]
from oneframework.ui.view import build_ui, document


class Tag(Model):
    name = String("Name", required=True)
    color = Color("Color")


class Line(Model):
    text = String("Task", required=True)
    description = Text("Description")
    tag = Many2one(Tag, "Tag")
    completed = Boolean("Done")
    sequence = Integer()


def tree(view_cls):
    """The view's tree, as a render would build it."""
    return build_ui(view_cls, None)


# ---------------------------------------------------------------- record refs
def test_record_refs_bind_to_the_view_model():
    class ItemView(View):
        model = Line

        def ui(self, record):
            return Row(
                record.sequence(widget="handle"),
                record.completed(widget="toggle"),
                record.text(widget="title"),
                record.tag(widget="tag"),
            )

    fields = [n for n in tree(ItemView).walk() if n.node_type == "field"]
    assert [f.field.name for f in fields] == ["sequence", "completed", "text", "tag"]
    assert all(isinstance(f.field, Field) for f in fields)
    assert [f.widget for f in fields] == ["handle", "toggle", "title", "tag"]


def test_a_ui_method_is_ordinary_python():
    """No namespace magic left: locals, loops and imports are just themselves."""
    class Probe(View):
        model = Line

        def ui(self, record):
            widgets = ["title", "subtitle"]
            return tuple(record.text(widget=w) for w in widgets)

    fields = [n for n in tree(Probe).walk() if n.node_type == "field"]
    assert [f.widget for f in fields] == ["title", "subtitle"]


def test_record_refs_inside_a_list_bind_to_the_list_model():
    class Board(View):
        def ui(self, record):
            return (
                List(
                    Line,
                    search=Search(
                        record.text,
                        Filter("Left", ~record.completed, default=True),
                        Sort("Manual", record.sequence, default=True),
                        Sort("Newest", record.created_at.desc()),
                    ),
                ),
            )

    node = next(n for n in tree(Board).walk() if n.node_type == "list")
    assert [f.name for f in node.search.fields] == ["text"]
    assert node.search.filters[0].domain.expr.name == "completed"
    assert node.search.sorts[1].orders[0].direction == "desc"
    assert node.search.sorts[1].orders[0].ref.name == "created_at"


def test_ui_as_a_class_body_value_says_how_to_rewrite_it():
    with pytest.raises(DslError) as excinfo:
        class Stale(View):
            model = Line
            ui = Row(Button("x", action=record.delete()))

    message = str(excinfo.value)
    assert "'ui' is a method" in message
    assert "def ui(self, record):" in message
    assert "record.<name>" in message


def test_unknown_record_field_reports_a_suggestion():
    class Broken(View):
        model = Line

        def ui(self, record):
            return Row(record.complted(widget="toggle"))

    with pytest.raises(DslError) as excinfo:
        tree(Broken)
    message = str(excinfo.value)
    assert "complted" in message
    assert "completed" in message
    assert "Broken" in message


def test_unknown_field_inside_a_list_reports_the_list_context():
    class Broken2(View):
        def ui(self, record):
            return (List(Line, search=Search(record.txet)),)

    with pytest.raises(DslError) as excinfo:
        tree(Broken2)
    message = str(excinfo.value)
    assert "txet" in message and "text" in message
    assert "List(Line)" in message


def test_bad_widget_reports_valid_options():
    class Broken3(View):
        model = Line

        def ui(self, record):
            return Row(record.completed(widget="toggl"))

    with pytest.raises(DslError) as excinfo:
        tree(Broken3)
    message = str(excinfo.value)
    assert "toggl" in message and "toggle" in message


def test_widget_must_match_the_field_type():
    class Broken4(View):
        model = Line

        def ui(self, record):
            return Row(record.text(widget="handle"))

    with pytest.raises(DslError):
        tree(Broken4)


def test_unknown_view_state_is_reported_against_the_view():
    class Broken6(View):
        chosen = Many2one(Tag, "Tag")

        def ui(self, record):
            return (view.chsen(widget="chips"),)

    with pytest.raises(DslError) as excinfo:
        tree(Broken6)
    message = str(excinfo.value)
    assert "view.chsen" in message and "chosen" in message


def test_an_empty_list_says_it_in_one_line_or_two():
    """One string is the whole of it; a pair is a line and the line under it."""
    assert List(Line, empty="Ничего нет").ir()["empty"] == ["Ничего нет"]
    assert List(Line, empty=("Ничего нет", "Нажмите +")).ir()["empty"] == [
        "Ничего нет", "Нажмите +",
    ]
    assert List(Line).ir()["empty"] is None
    with pytest.raises(DslError) as excinfo:
        List(Line, empty=("a", "b", "c"))
    assert "empty" in str(excinfo.value)


def test_item_view_model_must_match_the_list_model():
    class TagItem(View):
        model = Tag

        def ui(self, record):
            return Row(record.name(widget="title"))

    class Board2(View):
        def ui(self, record):
            return (List(Line, item=TagItem),)

    with pytest.raises(DslError) as excinfo:
        tree(Board2)
    message = str(excinfo.value)
    assert "TagItem" in message and "Tag" in message and "Line" in message


# ------------------------------------------------- field: ref + UI factory
def test_a_field_is_both_a_reference_and_a_ui_factory():
    assert isinstance(Line.text, Field)                      # reference
    assert Line.text().node_type == "field"                  # UI, default widget
    assert Line.text(widget="title").widget == "title"       # UI, override
    assert isinstance(Line.sequence == 3, Cmp)               # reference
    assert isinstance(~Line.completed, Not)                  # boolean reference
    assert isinstance(Line.created_at.desc(), Order)
    assert Line.text().widget is None  # falls back to the field's default


def test_default_widget_is_reported_in_the_ir():
    node = Line.description(widget="textarea")
    assert node.ir()["widget"] == "textarea"
    assert Line.description().ir()["widget"] == "textarea"
    assert Line.text().ir()["widget"] == "text"


def test_expression_operators_build_a_tree_not_a_bool():
    expr = ~Line.completed & (Line.sequence > 3)
    assert expr.__class__.__name__ == "And"
    with pytest.raises(DslError):
        bool(expr)


def test_context_proxies_build_typed_refs():
    domain = record.tag == view.tag
    assert isinstance(domain, Cmp)
    assert isinstance(domain.left, RecordFieldRef)
    assert isinstance(domain.right, ViewFieldRef)


# -------------------------------------------------------------------- UNSET
def test_unset_view_state_drops_the_condition_entirely():
    ctx = QueryContext(Line, view_state={"tag": UNSET})
    sql, params = compile_domain(record.tag == view.tag, ctx)
    assert sql is None, "UNSET must widen the query, not add IS NULL"
    assert params == []


def test_set_view_state_produces_a_parameterised_equality():
    ctx = QueryContext(Line, view_state={"tag": "0198f0e2-1111-7000-8000-000000000005"})
    sql, params = compile_domain(record.tag == view.tag, ctx)
    assert sql == '(t."tag_id" = ?)'
    assert params == ["0198f0e2-1111-7000-8000-000000000005"]


def test_is_null_is_explicit_and_distinct_from_unset():
    ctx = QueryContext(Line, view_state={})
    sql, params = compile_domain(Line.tag.is_null(), ctx)
    assert sql == '(t."tag_id" IS NULL)'
    assert params == []


def test_unset_absorbs_through_and_but_widens_or():
    ctx = QueryContext(Line, view_state={"tag": UNSET})
    both = (record.tag == view.tag) & ~record.completed
    sql, params = compile_domain(both, ctx)
    assert sql == '((NOT (t."completed" = 1)))'
    assert params == []

    either = (record.tag == view.tag) | ~record.completed
    sql, _ = compile_domain(either, ctx)
    assert sql is None, "an unconstrained OR branch leaves the whole OR open"


def test_boolean_values_are_adapted_for_sqlite():
    """У SQLite нет булева типа, и истина обязана дойти до неё числом.

    **Где именно приводится -- не важно, и проверять это здесь нельзя.**
    Питоновский компилятор печатал в параметр ``1``; тот, что на устройстве,
    печатает ``true`` и полагается на драйвер. Замерено: `sqlite-wasm`
    связывает `true` как 1, а `false` как 0, то есть обе дороги приводят к
    одному. Утверждение о типе параметра требовало бы от устройства лишнего --
    и покраснело бы на верном коде.
    """
    ctx = QueryContext(Line, view_state={"flag": True})
    sql, params = compile_domain(record.completed == view.flag, ctx)
    assert sql == '(t."completed" = ?)'
    assert params == [1]


def test_a_boolean_field_is_a_condition_by_itself():
    """What E712 exists to stop people writing, said the way Python says it."""
    ctx = QueryContext(Line, view_state={})
    assert compile_domain(record.completed, ctx) == ('(t."completed" = 1)', [])
    assert compile_domain(~record.completed, ctx) == (
        '(NOT (t."completed" = 1))', []
    )


def test_only_a_boolean_may_stand_alone_as_a_condition():
    ctx = QueryContext(Line, view_state={})
    with pytest.raises(DslError) as excinfo:
        compile_domain(record.sequence, ctx)
    assert "sequence" in str(excinfo.value) and "integer" in str(excinfo.value)


def test_order_compiles_with_direction_aware_tie_break():
    ctx = QueryContext(Line, view_state={})
    assert compile_order([Line.sequence], ctx) == 't."sequence" ASC, t."id" ASC'
    assert compile_order([Line.created_at.desc()], ctx) == (
        't."created_at" DESC, t."id" DESC'
    )


def test_multi_field_sort_is_supported():
    ctx = QueryContext(Line, view_state={})
    sql = compile_order([Line.completed.desc(), Line.sequence, Line.text], ctx)
    assert sql == (
        't."completed" DESC, t."sequence" ASC, t."text" ASC, t."id" ASC'
    )


def test_record_outside_a_record_context_is_a_clear_error():
    ctx = QueryContext(None, view_state={})
    with pytest.raises(DslError) as excinfo:
        compile_domain(record.tag == 1, ctx)
    assert "record.tag" in str(excinfo.value)


# ------------------------------------------------------------------ buttons
def test_button_requires_an_explicit_action():
    with pytest.raises(DslError):
        Button(icon="trash")


def test_action_is_separate_from_the_button():
    button = Button("Delete", action=record.delete())
    assert button.action.ir() == {"type": "delete", "confirm": True, "swipe": False}
    assert button.style == "destructive"
    assert button.ir()["label"] == "Delete"


def test_delete_can_ask_for_a_swipe_gesture():
    assert Delete(swipe=True).ir()["swipe"] is True
    assert Delete().ir()["swipe"] is False


def test_an_action_says_how_the_screen_it_opens_arrives():
    class Detail(View):
        model = Line

        def ui(self, record):
            return (record.text(),)

    # The same view, opened both ways -- which is the whole reason the choice
    # sits on the action: a property on the class would force a twin.
    assert Open(Detail, 1).target == "page"
    assert Open(Detail, 1, target="sheet").target == "sheet"
    assert Line.create(open=Detail).target == "page"
    assert Line.create(open=Detail, target="sheet").target == "sheet"


def test_an_unknown_target_reports_the_valid_ones():
    with pytest.raises(DslError) as excinfo:
        Line.create(target="new")
    assert "page" in str(excinfo.value) and "sheet" in str(excinfo.value)


def test_present_on_a_view_says_how_to_rewrite_it():
    with pytest.raises(DslError) as excinfo:
        class Sheet(View):
            model = Line
            present = "sheet"

    assert 'target="sheet"' in str(excinfo.value)


# ------------------------------------------------------------------ visible
def test_visible_is_answered_per_record():
    class RowView(View):
        model = Line

        def ui(self, record):
            return Row(
                record.text(widget="title"),
                record.description(visible=record.completed),
                record.tag(visible=~record.completed),
            )

    cells = tree(RowView).children[0].children
    done = {"completed": 1}
    open_ = {"completed": 0}
    assert [видно(c, done) for c in cells] == [True, True, False]
    assert [видно(c, open_) for c in cells] == [True, False, True]


def test_visible_takes_everything_a_domain_takes():
    class RowView(View):
        model = Line

        def ui(self, record):
            return Row(
                record.text(visible=(record.sequence > 10) & ~record.completed),
                record.tag(visible=record.tag.is_null()),
            )

    first, second = tree(RowView).children[0].children
    assert видно(first, {"sequence": 20, "completed": 0}) is True
    assert видно(first, {"sequence": 5, "completed": 0}) is False
    assert видно(first, {"sequence": 20, "completed": 1}) is False
    # Пустая колонка отвечает «нет», а не падает: SQL говорит NULL, и строку из
    # этого тоже не нарисовать.
    assert видно(first, {"sequence": None, "completed": 0}) is False
    assert видно(second, {"tag": None}) is True
    assert видно(second, {"tag": 3}) is False


def test_visible_takes_screen_state_too():
    """A row that appears when a button reveals it: the condition says so.

    Written as an `if` in ui() this was a fact about the moment the tree was
    built, which is why a view holding one could never be a document. As a
    condition it is a fact about the screen, answered wherever the screen is.
    """
    class RowView(View):
        model = Line
        flag = Boolean()

        def ui(self, record):
            return Row(record.text(visible=view.flag))

    cell = tree(RowView).children[0].children[0]
    assert видно(cell, {}, {"flag": True}) is True
    assert видно(cell, {}, {"flag": False}) is False
    # State nobody has touched yet is not a state that shows anything.
    assert видно(cell, {}, {}) is False


def test_a_button_takes_the_same_condition():
    assert Button(icon="delete", action=record.delete(),
                  visible=record.completed).visible is not True


def test_delete_alone_is_not_a_component():
    class Broken5(View):
        model = Line

        def ui(self, record):
            return (Delete(),)

    with pytest.raises(DslError):
        tree(Broken5)


# --------------------------------------------------------------- tab titles
def test_a_tab_title_is_made_of_the_parts_it_was_given():
    """`Icon` and `Pill` are title, everything else is the page behind it."""
    tab = Tab(Icon("star"), Pill(3, when="closed"), Button("Go", action=record.delete()))
    assert [type(part).__name__ for part in tab.title] == ["IconNode", "PillNode"]
    assert len(tab.children) == 1
    # A tab named by a glyph has no word to be named by, and says so.
    assert tab.label == ""


def test_an_icon_in_a_title_carries_its_name_over_the_wire():
    tab = Tab(Icon("star"))
    ir = tab.ir()["title"][0]
    assert ir["type"] == "icon" and ir["name"] == "star"


def test_crumbs_says_what_it_takes_when_told_something_else():
    """Путь над содержимым -- три состояния, и четвёртого нет.

    Написанное значением вроде ``crumbs = "off"`` доехало бы до рендерера
    строкой, а строка -- не ``false``: цепочка осталась бы на месте, и
    объявивший узнал бы об этом только глазами, на широком окне, случайно.
    """
    with pytest.raises(DslError) as excinfo:
        class Loud(View):
            model = Line
            crumbs = "off"

            def ui(self, record):
                return Row(record.text())

    message = str(excinfo.value)
    assert "crumbs='off'" in message
    assert "True, False" in message


def test_crumbs_reaches_the_document_as_declared():
    """Признак экрана, а не рендерера: он обязан доехать по проводу.

    Умолчание -- ``None``: экран промолчал, решает правило. Молчание тоже
    везётся ключом, потому что рантайм на новом языке читает схему кадра, а не
    догадывается по отсутствию.
    """
    class Silent(View):
        model = Line

        def ui(self, record):
            return Row(record.text())

    class Never(View):
        model = Line
        crumbs = False

        def ui(self, record):
            return Row(record.text())

    assert Silent._crumbs is None
    assert Never._crumbs is False
    assert document(Silent)["crumbs"] is None
    assert document(Never)["crumbs"] is False


def test_a_scrubber_without_sections_is_refused_aloud():
    """`index=True` без единого раздела -- объявление, которое не может работать.

    Скребок берёт буквы из заголовков разделов, а ставит их сортировка. Без
    неё полоска есть, за неё тянут, и ничего не происходит -- увидеть такое
    можно только глазами и только на длинном списке.

    Поймано на живом: в примере kitchen `index=True` стоял без разделов, и
    единственным «заголовком», который скребок находил, была шапка отборов --
    она лежала в том же `ul` и несла тот же класс. Когда шапка переехала над
    карточкой, как велят гайдлайны, скребок опустел, и проверка, годами
    подтверждавшая «пунктов больше нуля», оказалась пустой по смыслу.
    """
    with pytest.raises(DslError) as excinfo:
        List(Line, index=True, search=Search(Sort("По названию", Line.text)))

    message = str(excinfo.value)
    assert "index=True" in message
    assert "section=True" in message


def test_a_scrubber_with_a_section_is_allowed():
    """Раздел есть -- значит скребку есть что показать, и отказа нет."""
    node = List(Line, index=True,
                search=Search(Sort("По названию", Line.text, section=True)))
    assert node.index is True

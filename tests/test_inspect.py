"""``Model.get`` и ``oneframework inspect`` -- инструменты отладки.

Проверяется то, ради чего они сделаны: одна запись достаётся по ключу и достаётся
реактивно; разница двух снимков показывает изменившееся, а не всё; узел
называется устойчивой частью номера; определения из базы видны с отпечатками; и
выгруженный случай -- ровно тот вход, который читает второй рантайм.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import the_list
from oneframework.cli import inspect as ins


def _stack(snap):
    """Стек активного раздела. Отдельного ключа ``stack`` в снимке нет."""
    return snap["stacks"][snap["active"]]


ROOT = Path(__file__).resolve().parents[1]
TODO = ROOT / "examples" / "todo" / "app.py"
GTASKS = ROOT / "examples" / "gtasks" / "app.py"


@pytest.fixture()
def рт(todo_app):
    """Приложение, поднятое рантаймом с устройства."""
    import seed as seed_module

    from jsrt import Рантайм

    r = Рантайм(todo_app.app, seed=seed_module.seed)
    yield r
    r.close()


# --------------------------------------------------------------- Model.get
#: Три проверки ``Model.get``/``Model.all`` стояли здесь. Оба метода читали
#: **через живой питоновский рантайм** -- затем и существовали: экран сам
#: перерисовывался при правке таблицы. Рантайм переехал на устройство, метод
#: ``ui`` там не исполняется вовсе (виды едут документами), и звать их стало
#: неоткуда: ни один пример их не звал уже давно -- цикл ``for board in
#: Board.all()`` заменён на ``Repeat(Board, Tab(...))``.
#:
#: Само правило -- «правка записи перерисовывает экран» -- живо и проверяется
#: на том рантайме, что стоит на устройстве:
#: ``test_runtime.py::test_writing_a_record_invalidates_the_list_without_an_explicit_refresh``
#: и ``test_wasm_hooks.py::test_the_number_follows_a_change_in_another_model``.


# -------------------------------------------------------------------- diff
def test_diff_reports_only_what_moved():
    before = {"a": 1, "b": {"c": 2}, "same": [1, 2]}
    after = {"a": 1, "b": {"c": 3}, "same": [1, 2]}
    assert [(c.op, c.path, c.old, c.new) for c in ins.diff(before, after)] == [
        ("~", "b.c", 2, 3)
    ]


def test_diff_of_equal_values_is_empty():
    doc = {"x": [{"id": "a", "v": 1}], "y": None}
    assert ins.diff(doc, json.loads(json.dumps(doc))) == []


def test_diff_keys_rows_by_id_rather_than_position():
    """Вставка строки в начало не обязана объявлять изменившимися все за ней."""
    before = {"rows": [{"id": "b", "v": 1}, {"id": "c", "v": 2}]}
    after = {"rows": [{"id": "a", "v": 0}, {"id": "b", "v": 1}, {"id": "c", "v": 2}]}
    changes = ins.diff(before, after)
    assert [(c.op, c.path) for c in changes] == [("+", "rows[a]")]


def test_diff_notices_a_reorder_that_changed_nothing_else():
    before = {"rows": [{"id": "a"}, {"id": "b"}]}
    after = {"rows": [{"id": "b"}, {"id": "a"}]}
    changes = ins.diff(before, after)
    assert [(c.op, c.path, c.old, c.new) for c in changes] == [
        (">", "rows", ["a", "b"], ["b", "a"])
    ]


def test_diff_falls_back_to_position_without_keys():
    changes = ins.diff({"v": [1, 2]}, {"v": [1, 3, 4]})
    assert [(c.op, c.path) for c in changes] == [("~", "v[1]"), ("+", "v[2]")]


def test_diff_reports_added_and_removed_keys():
    changes = ins.diff({"gone": 1}, {"new": 2})
    assert {(c.op, c.path) for c in changes} == {("-", "gone"), ("+", "new")}


def test_comparable_drops_the_derived_halves_of_a_snapshot():
    """``stack`` -- это ``stacks[active]``: сравнивать оба значит удвоить вывод."""
    snapshot = {"stack": [1], "depth": 1, "stacks": {"a": [1]}, "active": "a"}
    assert set(ins.comparable(snapshot)) == {"stacks", "active"}


def test_format_diff_says_so_when_nothing_moved():
    assert ins.format_diff([]) == ["    (no change)"]


def test_a_whole_row_is_named_rather_than_dumped():
    """У всех строк одинаковое начало: обрезанный JSON про них не говорит ничего."""
    row = {"id": "r1", "children": [{"type": "field", "name": "text",
                                     "value": "Купить молоко"}]}
    changes = ins.diff({"rows": []}, {"rows": [row]})
    assert "row 'Купить молоко'" in "\n".join(ins.format_diff(changes))


def test_a_new_screen_is_named_by_its_view_and_title():
    frame = {"id": "s2", "view": "TodoLineDetail", "title": "Оплатить интернет"}
    changes = ins.diff({"stacks": {"a": []}}, {"stacks": {"a": [frame]}})
    assert "screen TodoLineDetail" in "\n".join(ins.format_diff(changes))


def test_format_diff_stops_at_the_limit():
    changes = [ins.Change("~", f"p{i}", i, i + 1) for i in range(10)]
    lines = ins.format_diff(changes, limit=3)
    assert lines[-1].strip().startswith("… 7 more")


# ------------------------------------------------------------- поиск узлов
def test_find_node_returns_the_path_to_it():
    """Путь тот же, что печатает разница: одна запись адреса на весь инструмент."""
    tree = {"children": [{"id": "a"}, {"id": "b", "children": [{"id": "c"}]}]}
    path, node = ins.find_node(tree, "c")
    assert node == {"id": "c"}
    assert path == "children[b].children[c]"


def test_a_path_falls_back_to_position_where_there_are_no_keys():
    path, node = ins.find_node({"v": [{"x": 1}, {"id": "z"}]}, "z")
    assert node == {"id": "z"} and path == "v[1]"


def test_the_path_of_a_node_matches_the_path_the_diff_prints(рт):
    """Иначе путь, увиденный в разнице, нельзя передать в --screen."""
    snapshot = рт.snapshot()
    node_id = the_list(рт)["id"]
    path, _ = ins.find_node(snapshot, node_id)
    changed = json.loads(json.dumps(snapshot))
    ins.find_node(changed, node_id)[1]["count"] = 999
    change = ins.diff(ins.comparable(snapshot), ins.comparable(changed))[0]
    assert change.path == f"{path}.count"


def test_resolve_id_accepts_the_stable_half_of_a_repeated_node():
    """Номер внутри повторителя несёт ключ записи, а ключ -- новый каждый раз."""
    snapshot = {"children": [{"id": "V.l1#k1"}]}
    assert ins.resolve_id(snapshot, "V.l1") == "V.l1#k1"


def test_resolve_id_refuses_to_guess_between_several():
    snapshot = {"children": [{"id": "V.l1#k1"}, {"id": "V.l1#k2"}]}
    with pytest.raises(SystemExit) as exc:
        ins.resolve_id(snapshot, "V.l1")
    assert "names 2 nodes" in str(exc.value)


def test_resolve_event_rewrites_the_ids_an_event_names():
    snapshot = {"children": [{"id": "V.l1#k1"}]}
    event = {"type": "set_search", "list_id": "V.l1", "value": "x"}
    assert ins.resolve_event(event, snapshot)["list_id"] == "V.l1#k1"


# --------------------------------------------------------- дерево и разделы
def test_tree_shows_every_node_id_and_the_rows_of_a_list(рт):
    lines = ins.render_screens(рт.snapshot())
    text = "\n".join(lines)
    assert "view Todo" in text
    assert the_list(рт)["id"] in text
    # ключи строк нужны, чтобы событие могло назвать запись
    assert the_list(рт)["rows"][0]["id"] in text


def test_tree_summarises_rows_instead_of_drawing_them(рт):
    lines = ins.render_screens(рт.snapshot(), rows=1)
    assert any("more" in line for line in lines)


# ------------------------------------------------------------ запуск и вывод
@pytest.fixture()
def opened():
    o = ins.open_app(TODO)
    yield o
    o.close()


def test_open_app_runs_the_seed_rather_than_an_empty_base(opened):
    """Смотреть на пустую базу бессмысленно: экран пуст по другой причине."""
    line = next(m for m in opened.app.models if m.__name__ == "TodoLine")
    assert opened.rt.counts["TodoLine"] > 0


def test_overview_lists_definitions_with_fingerprints_and_sizes(opened):
    text = "\n".join(ins.overview(opened, TODO))
    assert "TodoLine" in text and "definitions" in text
    row = next(r for r in ins.def_rows(opened.db) if r["name"] == "TodoLine")
    assert len(row["fingerprint"]) == 16 and row["bytes"] > 0
    # чужие инструменты названы, а не переписаны
    assert "sqlite3" in text and "datasette" in text


def test_view_document_is_what_goes_into_the_base(opened):
    """Собранный из исходника документ и лежащий в базе -- одно и то же.

    Разойдись они -- на устройстве нарисуется не тот экран, и объяснить это
    можно будет только сравнив эти двое. Стороны спрашиваются раздельно:
    исходник -- у питона, база -- у рантайма, который её открыл.
    """
    doc = ins.show_view(opened.app, "Todo")
    stored = opened.rt.doc("view", "Todo")
    assert stored is not None, "документа вида нет в базе"
    assert doc == stored


def test_model_schema_carries_the_widget_and_the_display_field(opened):
    doc = ins.show_model(opened.app, "TodoLine")
    text = next(f for f in doc["fields"] if f["name"] == "text")
    # чем запись подписывается -- вопрос, который задают о модели чаще всего
    assert text["display_field"] is True
    assert doc["fields"][1]["display_field"] is False
    assert text["widget"] and text["widgets"]
    assert any(f["system"] for f in doc["fields"])
    tag = next(f for f in doc["fields"] if f["name"] == "tag")
    assert tag["comodel"] == "Tag"


def test_unknown_names_say_what_there_is(opened):
    with pytest.raises(SystemExit) as exc:
        ins.show_model(opened.app, "Nope")
    assert "TodoLine" in str(exc.value)
    with pytest.raises(SystemExit) as exc:
        ins.show_view(opened.app, "Nope")
    assert "Todo" in str(exc.value)


def test_where_names_the_view_that_declares_a_node(opened):
    node_id = ins.show_view(opened.app, "Todo")["children"][1]["id"]
    found = ins.where(opened.app, node_id)
    assert [hit["view"] for hit in found] == ["Todo"]
    assert found[0]["node"]["id"] == node_id


def test_explain_expr_gives_every_branch_its_value(opened):
    """Odoo показывает объявленное условие и молчит о том, что оно дало.

    Значения веток считает **тот** вычислитель, что решает видимость на
    устройстве: до 21.08.2026 объяснял питоновский, а решал этот, и на
    пропущенном ключе они расходились. Объяснение не тем вычислителем -- худший
    род объяснения: оно выглядит ответом.
    """
    cond = {"op": "&", "p": [{"r": "done"}, {"op": "!", "e": {"r": "starred"}}]}
    строка = {"done": True, "starred": True}
    значения = ins._значения(opened.rt, cond, строка, {})
    lines = ins.explain_expr(cond, строка, {}, 0, значения)
    text = "\n".join(lines)
    assert "and" in text and "record.done" in text and "record.starred" in text
    assert "true" in text and "false" in text


def test_explain_expr_marks_the_branch_that_decided(opened):
    cond = {"op": "&", "p": [{"r": "a"}, {"r": "b"}]}
    строка = {"a": True, "b": False}
    значения = ins._значения(opened.rt, cond, строка, {})
    lines = ins.explain_expr(cond, строка, {}, 0, значения)
    assert lines[-1].endswith("<- decides")     # ложная часть решила исход `and`


def test_explain_expr_shows_a_reference_as_its_value_not_its_truth():
    """``0`` полезнее, чем ``false``: видно, что именно лежит в записи."""
    assert "0" in ins.explain_expr({"r": "n"}, {"n": 0}, {})[0]


@pytest.fixture()
def gtasks():
    o = ins.open_app(GTASKS)
    yield o
    o.close()


def test_why_evaluates_a_condition_on_the_record_it_was_drawn_for(gtasks):
    out = "\n".join(ins.why(gtasks.app, gtasks.rt, gtasks.db, "TaskRow.f4"))
    assert "declared in view TaskRow" in out
    assert "visible ->" in out
    assert "record.done" in out
    assert "drawn for Task" in out


def test_why_can_be_pointed_at_one_row_of_many(gtasks):
    snapshot = gtasks.rt.snapshot()
    # Узел строки на проводе один, а записей много: ключ лежит в rows списка,
    # а не на узле -- узел описывает форму, строка отвечает значениями.
    lists = ins.rows_of(snapshot, "TaskRow.f4")
    rows = [r for lst in lists for r in lst.get("rows") or []]
    assert len(rows) > 1
    wanted = rows[-1]["id"]
    out = "\n".join(ins.why(gtasks.app, gtasks.rt, gtasks.db, "TaskRow.f4", record_id=wanted))
    assert wanted in out
    with pytest.raises(SystemExit):
        ins.why(gtasks.app, gtasks.rt, gtasks.db, "TaskRow.f4", record_id="no-such")


def test_why_refuses_a_node_that_is_not_on_screen(gtasks):
    with pytest.raises(SystemExit):
        ins.why(gtasks.app, gtasks.rt, gtasks.db, "Nope.x1")


def test_refs_finds_a_field_inside_conditions_and_domains(gtasks):
    """Ссылка лежит внутри JSON-документа -- граф внешних ключей туда не достаёт."""
    found = ins.refs(gtasks.app, "Task.done")
    assert {hit["view"] for hit in found} >= {"TaskRow", "Tasks"}
    assert any(h["what"].startswith("drawn") for h in found)
    assert any("domain" in h["path"] for h in found)
    # имя без модели ищет то же самое
    assert ins.refs(gtasks.app, "done") == found
    assert ins.refs(gtasks.app, "no_such_field") == []


def test_shell_has_the_models_loaded_and_the_app_running(opened):
    """В консоли уже разложено всё, без единого ввоза -- в этом её смысл.

    Записи читаются через ``db``: ``Model.get`` читал через питоновский рантайм
    и ушёл вместе с ним 21.08.2026.
    """
    space = ins.shell_namespace(opened)
    line = space["TodoLine"]
    assert space["Todo"] in opened.app.views
    assert {"app", "rt", "db", "document", "defs", "diff", "snapshot"} <= set(space)
    record_id = opened.db.all("TodoLine")[0]["id"]
    assert opened.db.read("TodoLine", record_id)["text"]


def test_export_is_the_input_the_other_runtime_reads(opened):
    case = ins.export_case(opened, [], [opened.rt.snapshot()])
    # ровно те ключи, которые читает хост рантайма
    assert {"schema", "models", "documents", "screens", "rows"} <= set(case)
    assert case["documents"]["Todo"] == ins.show_view(opened.app, "Todo")
    assert case["rows"]["TodoLine"]
    assert case["expected"]["snapshot"]["type"] == "render"


# ------------------------------------------------------------------- база
def test_db_is_created_once_and_then_keeps_its_keys(tmp_path):
    """Ключи выдаются при вставке: без файла событие не может назвать запись."""
    path = tmp_path / "app.db"
    first = ins.open_app(TODO, str(path))
    ids = [r["id"] for r in _stack(first.rt.snapshot())[0]["children"][1]["rows"]]
    first.close()
    assert path.exists()

    second = ins.open_app(TODO, str(path))
    again = [r["id"] for r in _stack(second.rt.snapshot())[0]["children"][1]["rows"]]
    second.close()
    assert ids == again


def test_the_real_file_is_never_written_to(tmp_path):
    """Смотреть приходится в рабочую базу, а событие -- это запись."""
    path = tmp_path / "app.db"
    ins.open_app(TODO, str(path)).close()
    before = path.read_bytes()

    opened = ins.open_app(TODO, str(path))
    record_id = opened.db.all("TodoLine")[0]["id"]
    opened.rt.dispatch({"type": "write", "model": "TodoLine",
                        "record_id": record_id, "values": {"text": "Правка"}})
    opened.close()
    assert path.read_bytes() == before


def test_a_definition_that_differs_from_the_source_is_marked_stale(tmp_path):
    """«Почему на устройстве не тот экран» -- вопрос про отпечаток, а не про код."""
    path = tmp_path / "app.db"
    ins.open_app(TODO, str(path)).close()

    #: Отпечаток портится **прямо в файле**, обычным sqlite3. Своего писателя
    #: базы у питона больше нет, а подделывать расхождение через сборщик
    #: значило бы просить его написать неверно -- он на это и не согласится.
    import sqlite3

    con = sqlite3.connect(path)
    try:
        con.execute('UPDATE "_oneframework_def" SET "fingerprint" = ? '
                    'WHERE "kind" = ? AND "name" = ?', ("0" * 16, "view", "Todo"))
        con.commit()
    finally:
        con.close()

    opened = ins.open_app(TODO, str(path))
    try:
        assert ("view", "Todo") in opened.stale
        assert "stale" in "\n".join(ins.overview(opened, TODO))
    finally:
        opened.close()


# -------------------------------------------------------------------- CLI
def run_cli(*args):
    done = subprocess.run(
        [sys.executable, "-m", "oneframework.cli.main", "inspect", *args],
        capture_output=True, text=True, cwd=str(ROOT), encoding="utf-8",
    )
    assert done.returncode == 0, done.stderr
    return done.stdout


def test_cli_overview_runs(tmp_path):
    out = run_cli(str(TODO), "--db", str(tmp_path / "app.db"))
    assert "definitions" in out and "TodoLine" in out


def test_cli_dispatches_an_event_and_prints_a_diff(tmp_path):
    path = str(tmp_path / "app.db")
    run_cli(str(TODO), "--db", path)
    out = run_cli(str(TODO), "--db", path,
                  "--event", '{"type":"set_filter","list_id":"Todo.l1","index":1}')
    assert "event 1:" in out
    assert "state.filter" in out
    # разница, а не два полотна: снимок целиком сюда не попадает
    assert "\"type\": \"render\"" not in out


def test_cli_shows_a_part_of_the_screen(tmp_path):
    out = run_cli(str(TODO), "--db", str(tmp_path / "app.db"), "--screen", "Todo.l1")
    assert json.loads(out.split("\n", 1)[1])["id"] == "Todo.l1"


def test_cli_view_and_model_print_json(tmp_path):
    db = str(tmp_path / "app.db")
    assert json.loads(run_cli(str(TODO), "--db", db, "--view", "Todo"))["name"] == "Todo"
    assert json.loads(run_cli(str(TODO), "--db", db, "--model", "Tag"))["table"] == "tag"


def test_cli_replays_a_recorded_sequence(tmp_path):
    path = str(tmp_path / "app.db")
    run_cli(str(TODO), "--db", path)
    log = tmp_path / "events.json"
    log.write_text(json.dumps([
        {"type": "set_filter", "list_id": "Todo.l1", "index": 1},
        {"type": "set_search", "list_id": "Todo.l1", "value": "книгу"},
    ]), encoding="utf-8")
    out = run_cli(str(TODO), "--db", path, "--replay", str(log))
    assert "event 1:" in out and "event 2:" in out


def test_cli_resolves_a_repeated_node_by_its_stable_half(tmp_path):
    """В gtasks список задач лежит внутри повторителя по доскам."""
    path = str(tmp_path / "gtasks.db")
    run_cli(str(GTASKS), "--db", path)
    out = run_cli(str(GTASKS), "--db", path, "--tree", "Tasks.l1")
    assert out.startswith("list ")


def test_cli_reports_a_bad_event_against_the_event(tmp_path):
    done = subprocess.run(
        [sys.executable, "-m", "oneframework.cli.main", "inspect", str(TODO),
         "--event", '{"type":"set_filter","list_id":"Nope","index":1}'],
        capture_output=True, text=True, cwd=str(ROOT), encoding="utf-8",
    )
    assert done.returncode == 1
    #: Слова -- рантайма на JS: с 21.08.2026 `inspect` спрашивает его, а не
    #: питоновский. Тот говорил «Unknown list»; расхождение в словах вскрыл
    #: сам переезд, и осталось то, что человек правда увидит.
    assert "Неизвестный список" in done.stdout


def test_cli_explains_why_a_node_looks_like_that(tmp_path):
    path = str(tmp_path / "gtasks.db")
    run_cli(str(GTASKS), "--db", path)
    out = run_cli(str(GTASKS), "--db", path, "--why", "TaskRow.f4")
    assert "visible ->" in out and "record.done" in out


def test_cli_lists_every_mention_of_a_field(tmp_path):
    out = run_cli(str(GTASKS), "--db", str(tmp_path / "g.db"), "--refs", "Task.done")
    assert "TaskRow" in out and "Tasks" in out

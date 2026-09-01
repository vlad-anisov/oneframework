"""Реляционный слой: смысл сохраняется, форма сливается, отказ называет причину.

Тесты не проверяют «напечатался ли SQL». Они исполняют его на настоящей SQLite
и смотрят на план запроса: коррелированный подзапрос в слитой выборке -- это
провал, даже если ответ верный.
"""

import sqlite3

import pytest

from oneframework.errors import DslError

from jsrel import (
    EXACT_ADAPTED, EXACT_NATIVE, GROUPED, RECURSIVE, ROW_SCALAR, UNSUPPORTED,
    AccessPath, Кусок, ОтказJs, call, needs_node,
)

pytestmark = needs_node


def _зов(op, *args):
    """Отказ компилятора -- тот же ``DslError``, что и раньше.

    Тип исключения -- подробность питоновской стороны: за проводом отказ едет
    словами. Переводится здесь, чтобы утверждения сюиты остались про отказ, а
    не про то, как он переехал.
    """
    try:
        return call(op, *args)
    except ОтказJs as отказ:
        raise DslError(отказ.message) from None


def canonical(node):
    return _зов("canonical", node)


def compile_expr(node, table="t"):
    return Кусок(_зов("compile_expr", node, {"table": table}))


def compile_screen(table, row_fields=None, aggregates=None, consumer="screen", key="id"):
    ответ = _зов("compile_screen", table,
                 {"row_fields": row_fields or {}, "aggregates": aggregates or [],
                  "consumer": consumer, "key": key})
    # Пути доступа -- объектами: сюита спрашивает у них `satisfied_by`, а не
    # только сравнивает.
    ответ["access"] = [AccessPath(**{**a, "prefix": a["prefix"]}) for a in ответ["access"]]
    return Кусок(ответ)


def compile_rule(rule):
    """Отдаёт пару (кусок, пути) -- в той же форме, что отдавал эталон."""
    ответ = _зов("compile_rule", rule)
    пути = [AccessPath(**a) for a in ответ.pop("access")]
    return Кусок(ответ), пути


class Mutation:
    """Правка по правилу. Считает её та же половина, что на устройстве."""

    def __init__(self, table, source, assignments):
        self.аргументы = (table, source, assignments)

    def compile(self, rule_sql=None):
        ответ = _зов("mutation", *self.аргументы, rule_sql)
        return ответ["sql"], ответ["params"]


def _boom(*_args):
    """Отказ базы на делении на ноль -- то же, что делает хост в приложении."""
    raise ZeroDivisionError("division by zero")


@pytest.fixture()
def db():
    con = sqlite3.connect(":memory:")
    # Те же две функции, что ставит хост: без них база вела бы себя не как
    # питон, и тесты мерили бы не то, что работает у пользователя.
    con.create_function("oneframework_zero_division", 0, _boom)
    con.create_function("oneframework_round", 1, lambda x: None if x is None else round(x))
    con.create_function("pyupper", 1, lambda x: x if x is None else x.upper())
    con.create_function("pylower", 1, lambda x: x if x is None else x.lower())
    con.executescript("""
        CREATE TABLE board(id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE task(id TEXT PRIMARY KEY, board TEXT, parent TEXT,
                          title TEXT, details TEXT, done INT, total INT);
        INSERT INTO board VALUES ('b1','Дом'),('b2','Пусто');
        INSERT INTO task VALUES
            ('t1','b1',NULL,'Крыша',NULL,0,4),
            ('t2','b1','t1','Стропила','есть',1,4),
            ('t3','b1','t2','Гвозди',NULL,0,4),
            ('t4','b1',NULL,'Забор','есть',1,0);
    """)
    return con


def plan_of(con, sql, params=None):
    return " | ".join(r[3] for r in con.execute("EXPLAIN QUERY PLAN " + sql, params or {}))


# ==========================================================================
# каноническая форма: ради того, чтобы индекс по выражению совпадал
# ==========================================================================
def test_commutative_operands_are_ordered():
    a = canonical({"op": "+", "args": [{"field": "done"}, {"field": "total"}]})
    b = canonical({"op": "+", "args": [{"field": "total"}, {"field": "done"}]})
    assert a == b
    assert compile_expr(a).sql == compile_expr(b).sql


def test_non_commutative_operands_are_left_alone():
    minus = {"op": "-", "args": [{"field": "done"}, {"field": "total"}]}
    assert canonical(minus) == minus
    assert compile_expr(minus).sql == '("t"."done" - "t"."total")'


def test_canonical_reaches_into_aggregate_condition():
    node = {"agg": "count", "where": {"op": "and", "args": [
        {"field": "b"}, {"field": "a"}]}}
    assert canonical(node)["where"]["args"][0] == {"field": "a"}


# ==========================================================================
# исход перевода: смысл или отказ с именем
# ==========================================================================
def test_is_null_is_native():
    piece = compile_expr({"op": "is_null", "args": [{"field": "details"}]})
    assert piece.status == EXACT_NATIVE and piece.form == ROW_SCALAR
    assert piece.reads == ("details",)


def test_not_of_nullable_field_is_adapted_not_native():
    """`NOT NULL` даёт NULL -- третьего состояния на экране не бывает."""
    piece = compile_expr({"op": "not", "args": [{"field": "done"}]})
    assert piece.status == EXACT_ADAPTED
    assert "coalesce" in piece.sql


def test_concat_survives_null(db):
    piece = compile_expr({"op": "concat", "args": [{"field": "title"},
                                                   {"const": ": "},
                                                   {"field": "details"}]})
    assert piece.status == EXACT_ADAPTED
    got = db.execute(f'SELECT {piece.sql} FROM task "t" WHERE "t".id = ?', ("t1",)).fetchone()
    assert got[0] == "Крыша: "        # а не NULL


def test_division_by_zero_is_an_error_like_in_python(db):
    """В питоне это ``ZeroDivisionError``, а SQLite молча отдаёт пустоту.

    Молчание тут хуже отказа: пустая клетка на экране выглядит как ответ, и
    заметит её не разработчик, а пользователь.
    """
    piece = compile_expr({"op": "/", "args": [{"field": "done"}, {"field": "total"}]})
    assert piece.status == EXACT_ADAPTED
    assert "oneframework_zero_division" in piece.sql

    # Драйвер `sqlite3` заворачивает текст отказа в своё «user-defined function
    # raised exception»; apsw пропускает исходный. Важно не слово, а то, что
    # запрос **падает**, а не отдаёт пустую клетку.
    with pytest.raises(sqlite3.OperationalError):
        db.execute(f'SELECT {piece.sql} FROM task "t" WHERE "t".id = ?', ("t4",)).fetchall()


def test_the_untaken_branch_is_not_evaluated(db):
    """``x / total if total else 0`` -- обычный питон, и он безопасен.

    Ветка, которую не выбрали, в SQLite не вычисляется, поэтому деления на ноль
    у пустого списка не происходит вовсе. Автору формулы не нужно ни объявлять
    ветку особым словом, ни знать про SQL.
    """
    node = {"op": "if", "args": [
        {"field": "total"},
        {"op": "/", "args": [{"op": "*", "args": [{"field": "done"}, {"const": 100}]},
                             {"field": "total"}]},
        {"const": 0},
    ]}
    piece = compile_expr(node)
    rows = dict(db.execute(f'SELECT "t".id, {piece.sql} FROM task "t"').fetchall())
    assert rows["t2"] == 25      # 1*100/4
    assert rows["t4"] == 0       # total = 0 -- деление не выполнялось


def test_unicode_case_is_answered_by_the_host_not_refused(db):
    """Регистр кириллицы -- питоновский, и потому своей функцией.

    ``upper`` у SQLite знает только ASCII: «крыша» он оставляет «крыша» и
    ничего об этом не говорит. Похожий ответ здесь хуже отказа, а верный --
    лучше обоих, и стоит он одной функции хоста, как ``round``.
    """
    piece = compile_expr({"op": "upper", "args": [{"field": "title"}]})
    assert piece.status != UNSUPPORTED
    got = db.execute(f'SELECT {piece.sql} FROM task "t" WHERE "t".id = ?',
                     ("t1",)).fetchone()[0]
    assert got == "КРЫША"


def test_a_string_method_python_has_but_sqlite_lacks_is_exact(db):
    """``startswith`` пишется срезом, а не ``LIKE``.

    ``LIKE`` считает ``%`` в образце подстановкой и не различает регистр
    ASCII -- то есть отвечает **похоже**, а не то же.
    """
    piece = compile_expr({"op": "startswith",
                          "args": [{"field": "title"}, {"const": "Кры"}]})
    rows = dict(db.execute(f'SELECT "t".id, {piece.sql} FROM task "t"').fetchall())
    assert rows["t1"] == 1 and rows["t2"] == 0


def test_workday_calendar_is_refused_by_name():
    piece = compile_expr({"op": "add_workdays",
                          "args": [{"field": "title"}, {"const": 3}]})
    assert piece.missing == ("workday_calendar",)


def test_worst_outcome_wins_over_the_whole_node():
    node = {"op": "and", "args": [
        {"op": "is_null", "args": [{"field": "details"}]},
        {"op": "add_workdays", "args": [{"field": "title"}, {"const": 3}]},
    ]}
    assert compile_expr(node).status == UNSUPPORTED


# ==========================================================================
# экран: одна выборка, а не N подзапросов
# ==========================================================================
def test_row_fields_become_columns_of_one_select(db):
    screen = compile_screen("task", row_fields={
        "vis_details": {"op": "not", "args": [{"field": "done"}]},
        "has_details": {"op": "not", "args": [
            {"op": "is_null", "args": [{"field": "details"}]}]},
    })
    assert screen.sql.count("SELECT") == 1
    rows = {r[0]: r[-2:] for r in db.execute(screen.sql, screen.params)}
    assert rows["t1"] == (0, 1)      # has_details=0, vis_details=1
    assert rows["t2"] == (1, 0)


def test_aggregates_merge_into_one_group_by(db):
    screen = compile_screen("board", row_fields={}, aggregates=[
        {"name": "total", "model": "task", "via": "board", "agg": "count"},
        {"name": "done", "model": "task", "via": "board", "agg": "count",
         "where": {"field": "done"}},
        {"name": "open", "model": "task", "via": "board", "agg": "count",
         "where": {"op": "not", "args": [{"field": "done"}]}},
    ])
    assert screen.sql.count("GROUP BY") == 1
    assert screen.sql.count("LEFT JOIN") == 1
    rows = {r[0]: r[2:] for r in db.execute(screen.sql, screen.params)}
    # Порядок колонок -- **как объявлено**, а не по алфавиту: кадр читается
    # по позициям, и переставлять их сортировкой было бы ловушкой.
    assert rows["b1"] == (4, 2, 2)   # total, done, open
    assert rows["b2"] == (0, 0, 0)   # пустой список: нули, а не NULL


def test_merged_screen_has_no_correlated_subquery(db):
    screen = compile_screen("board", aggregates=[
        {"name": "total", "model": "task", "via": "board", "agg": "count"},
        {"name": "done", "model": "task", "via": "board", "agg": "count",
         "where": {"field": "done"}},
    ])
    assert "CORRELATED" not in plan_of(db, screen.sql, screen.params).upper()


def test_screen_requires_access_path_and_does_not_create_it():
    screen = compile_screen("board", aggregates=[
        {"name": "total", "model": "task", "via": "board", "agg": "count"}])
    assert "CREATE INDEX" not in screen.sql
    assert screen.access == [AccessPath("task", ("board",), "group_by",
                                        "screen.agg__task__board")]


def test_access_path_is_covered_by_a_composite_index():
    path = AccessPath("task", ("board",), "group_by", "screen")
    assert path.satisfied_by([("board", "done")])
    assert not path.satisfied_by([("done", "board")])


def test_refused_field_still_has_a_column(db):
    """Форма кадра не зависит от того, что удалось перевести."""
    screen = compile_screen("task", row_fields={
        "shout": {"op": "add_workdays", "args": [{"field": "title"}, {"const": 3}]},
    })
    assert screen.unsupported == {"shout": ("workday_calendar",)}
    row = db.execute(screen.sql, screen.params).fetchone()
    assert row[-1] is None


# ==========================================================================
# правило и изменение набора
# ==========================================================================
def test_rule_walks_the_tree_in_one_query(db):
    piece, access = compile_rule({"name": "d", "table": "task", "via": "parent",
                                  "seed": {"param": "root", "value": "t1"}})
    got = db.execute(piece.sql + " SELECT group_concat(id) FROM d",
                     piece.params).fetchone()[0]
    assert sorted(got.split(",")) == ["t2", "t3"]
    assert piece.form == RECURSIVE
    assert access[0].prefix == ("parent",)


def test_rule_terminates_on_a_cycle_in_data(db):
    """Кольцо заводится само: спор решается по колонкам."""
    db.execute("UPDATE task SET parent='t3' WHERE id='t1'")
    piece, _ = compile_rule({"name": "d", "table": "task", "via": "parent",
                             "seed": {"param": "root", "value": "t1"}})
    got = db.execute(piece.sql + " SELECT count(*) FROM d", piece.params).fetchone()[0]
    assert got == 3


def test_rule_refuses_changing_columns_without_explicit_bound():
    with pytest.raises(DslError, match="max_depth"):
        compile_rule({"name": "d", "table": "task", "via": "parent",
                      "columns": ["id", "depth"], "seed": {"param": "root"}})


def test_rule_with_depth_and_bound_terminates(db):
    db.execute("UPDATE task SET parent='t3' WHERE id='t1'")
    piece, _ = compile_rule({"name": "d", "table": "task", "via": "parent",
                             "columns": ["id", "depth"], "max_depth": 8,
                             "seed": {"param": "root", "value": "t1"}})
    got = db.execute(piece.sql + " SELECT count(*) FROM d", piece.params).fetchone()[0]
    assert got == 9


def test_mutation_applies_to_the_set_the_rule_produced(db):
    piece, _ = compile_rule({"name": "d", "table": "task", "via": "parent",
                             "seed": {"param": "root", "value": "t1"}})
    sql, params = Mutation("task", "d", {"done": {"const": 1}}).compile(piece.sql)
    db.execute(sql, {**piece.params, **params})
    assert [r[0] for r in db.execute(
        "SELECT id FROM task WHERE done ORDER BY id")] == ["t2", "t3", "t4"]


def test_mutation_refuses_an_untranslatable_value():
    with pytest.raises(DslError, match="workday_calendar"):
        Mutation("task", "d", {"title": {"op": "add_workdays",
                                         "args": [{"field": "title"},
                                                  {"const": 3}]}}).compile()


# ==========================================================================
# корпус: обе разметки сразу
# ==========================================================================
def test_gtasks_corpus_classification(db):
    """Разметка корпуса: частый путь переводится точно, отказ -- редкий и именной."""
    screen = compile_screen(
        "task",
        row_fields={
            "vis_details": {"op": "not", "args": [{"field": "done"}]},
            "vis_finished": {"field": "done"},
            "no_details": {"op": "is_null", "args": [{"field": "details"}]},
            "label": {"op": "concat", "args": [{"field": "title"}, {"const": "!"}]},
            "percent": {"op": "if", "args": [
                {"field": "total"},
                {"op": "/", "args": [{"op": "*", "args": [{"field": "done"}, {"const": 100}]},
                                     {"field": "total"}]},
                {"const": 0}]},
            "shout": {"op": "add_workdays",
                      "args": [{"field": "title"}, {"const": 3}]},
        },
        aggregates=[
            {"name": "open", "model": "task", "via": "board", "agg": "count",
             "where": {"op": "not", "args": [{"field": "done"}]}},
        ],
    )
    outcomes = {n: s for n, (s, _) in screen.fields.items()}
    assert outcomes["vis_finished"] == EXACT_NATIVE
    assert outcomes["no_details"] == EXACT_NATIVE
    assert outcomes["open"] == EXACT_ADAPTED
    assert outcomes["shout"] == UNSUPPORTED
    assert set(screen.unsupported) == {"shout"}
    assert {n for n, (_, f) in screen.fields.items() if f == GROUPED} == {"open"}
    db.execute(screen.sql, screen.params).fetchall()


# ==========================================================================
# предел работы: тяжёлый запрос обязан прерываться, а не вешать устройство
# ==========================================================================


#: Здесь стояли проверки предела шагов -- обрыв убегающего запроса, счёт
#: шагами, а не вызовами сторожа, и сброс на каждый запрос. Все мерили
#: питоновскую базу. Её писателя больше нет, а живая половина правила оказалась
#: беззащитной: снятый предел в `db.js` оставлял всю сюиту зелёной. Правило
#: переехало туда, где оно и работает: `tests/test_js_step_limit.py`.

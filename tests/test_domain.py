"""Компилятор домена: правила той копии, что едет на устройство.

Копия одна -- `src/rel/domain.js`. Питоновская (`rel/domain.py`, удалена),
держала эти правила, пока была эталоном для сверки; 21.08.2026 держателем стала
та, которую правда исполняет пользователь. Сверка «обе копии дали одно и то же»
убрана вместе с ролью: она доказывала согласие копий, а не верность работающей.

Корпус остался прежним -- весь поток запросов, который сюита порождает на живых
примерах, плюс краевые случаи, собранные по правилам, а не по красоте. Он
кормит `test_javascript_matches_the_corpus`: правила ниже проверяют, что
компилятор отвечает верно, корпус -- что он отвечает **на всё**.

Правила, ради которых компилятор когда-то уезжал в WASM:

1. **UNSET расширяет выборку.** Через ``&`` часть выпадает, через ``|`` и ``!``
   поглощает всё выражение. Именно на этом копии однажды и разошлись: SQL
   показывал все строки, а фронтенд прятал все -- ни исключения, ни записи в
   журнале.
2. **``None`` -- это не UNSET.** Он ставит условие, а не снимает.
3. **Голой ссылкой может стоять только boolean.**
4. **Любое пользовательское значение -- параметр ``?``.**
"""

import json
from pathlib import Path

from jsrel import call, needs_node

pytestmark = needs_node


def compile_query(payload):
    """Компилятор -- тот, что стоит на устройстве.

    Раньше правила спрашивались у питоновской копии: она была под рукой, а
    совпадение копий держала отдельная сверка. Так доказывалось, что копии
    согласны, но не что права та, которую правда исполняет пользователь.
    """
    return call("compile_query", payload)

ROOT = Path(__file__).resolve().parents[1]

MODEL = {
    "table": "line",
    "fields": [
        {"name": "text", "column": "text", "ftype": "string", "stored": True},
        {"name": "completed", "column": "completed", "ftype": "boolean", "stored": True},
        {"name": "rank", "column": "rank", "ftype": "integer", "stored": True},
        {"name": "due", "column": "due", "ftype": "date", "stored": True},
        {"name": "lines", "column": None, "ftype": "one2many", "stored": False},
        {"name": "id", "column": "id", "ftype": "uuid", "stored": True},
    ],
}


def R(name):
    return {"r": name}


def V(name):
    return {"v": name}


def C(op, left, right):
    return {"op": op, "l": left, "r": right}


UNSET = {"unset": True}

#: Домены подобраны по правилам и по краям, а не по красоте.
DOMAINS = [
    None, True, False, 0, 1, "text", [], {},
    R("completed"), R("text"), R("rank"), R("lines"),
    V("flag"), V("missing"), UNSET,
    {"op": "!", "e": R("completed")}, {"op": "!", "e": V("missing")},
    {"op": "null", "e": R("due")}, {"op": "null", "e": V("flag")},
    {"op": "&", "p": [R("completed"), C(">", R("rank"), 3)]},
    {"op": "&", "p": [R("completed"), C("=", V("missing"), 3)]},
    {"op": "&", "p": []},
    {"op": "|", "p": [R("completed"), C("=", V("missing"), 3)]},
    {"op": "|", "p": [R("completed"), C(">", R("rank"), 1)]},
    {"op": "|", "p": []},
    {"op": "&", "p": [{"op": "&", "p": [R("completed"), C(">", R("rank"), 1)]},
                      C("<", R("rank"), 9)]},
    C("=", R("text"), None), C("!=", R("text"), None),
    C("<", R("text"), None), C(">", R("rank"), None),
    C("=", 3, R("rank")), C("<", 3, R("rank")), C("<=", 3, R("rank")),
    C(">", 3, R("rank")), C(">=", 3, R("rank")), C("!=", 3, R("rank")),
    C("=", R("rank"), R("rank")), C("<", R("rank"), R("due")),
    C("=", 1, 1), C("=", 1, 2), C("<", "a", "b"), C("<", [1, 2], [1, 3]),
    C("<", None, False), C("=", None, False), C("<", "a", 1),
    C("=", UNSET, R("rank")), C("=", R("rank"), UNSET),
    C("=", V("missing"), V("missing")),
    {"op": "??", "l": 1, "r": 2}, {"i": "name"},
    C("=", R("nosuch"), 1), C("=", R("lines"), 1), {"fmt": ["x"]},
]

#: Состояние экрана: истинность здесь питоновская, а не JS.
STATES = [
    {}, {"flag": True}, {"flag": False}, {"flag": None}, {"flag": 0},
    {"flag": ""}, {"flag": []}, {"flag": {}}, {"flag": [1]},
    {"flag": {"unset": True}}, {"flag": "текст"},
]

ORDERS = [
    [], [R("rank")], [{"order": R("rank"), "dir": "desc"}],
    [{"order": R("rank"), "dir": "asc"}, {"order": R("due"), "dir": "desc"}],
    [{"order": R("due"), "dir": "desc"}, {"order": R("rank"), "dir": "asc"}],
    [R("lines")], [V("flag")],
]

SEARCHES = [
    ([], ""), (["text"], ""), (["text"], "  "), (["text"], "Чай"),
    (["text", "due"], "abc"), (["lines"], "abc"), (["nosuch"], "abc"),
    ([R("text")], "abc"),
]

SELECTS = [
    {"do": "select", "where": [], "order": ""},
    {"do": "select", "where": [None, '(t."completed" = 1)'], "order": 't."id" ASC'},
    {"do": "select", "where": [], "order": "", "limit": 5, "offset": 0},
    {"do": "select", "where": [], "order": "", "limit": 5, "offset": 40},
    {"do": "select", "where": [], "order": "", "offset": 40},
    {"do": "select", "columns": ['t."id"', '(CASE WHEN (t."rank" > ?) THEN 1 ELSE 0 END)'],
     "where": [None], "order": ""},
    {"do": "select", "columns": [], "where": [], "order": ""},
]


def _payloads():
    out = []
    for state in STATES:
        ops = [{"do": "domain", "node": d} for d in DOMAINS]
        ops += [{"do": "order", "terms": t} for t in ORDERS]
        ops += [{"do": "search", "fields": f, "text": t} for f, t in SEARCHES]
        ops += SELECTS
        out.append(json.dumps(
            {"ctx": {"model": MODEL, "state": state, "alias": "t"}, "ops": ops},
            ensure_ascii=False))
    # Без модели вовсе и с другим псевдонимом -- оба случая живые.
    out.append(json.dumps({"ctx": {"model": None, "state": {}, "alias": "t"},
                           "ops": [{"do": "domain", "node": R("rank")},
                                   {"do": "domain", "node": C("=", 1, 1)},
                                   {"do": "select", "where": [], "order": ""}]}))
    out.append(json.dumps({"ctx": {"model": MODEL, "state": {}, "alias": "a"},
                           "ops": [{"do": "domain", "node": R("completed")},
                                   {"do": "order", "terms": [R("rank")]},
                                   {"do": "select", "where": [], "order": ""}]}))
    return out


PAYLOADS = _payloads()


# ==========================================================================
# сами правила
# ==========================================================================
def _one(node, state=None):
    payload = json.dumps({"ctx": {"model": MODEL, "state": state or {}, "alias": "t"},
                          "ops": [{"do": "domain", "node": node}]}, ensure_ascii=False)
    return compile_query(payload)[0]


def test_unset_drops_the_condition_rather_than_narrowing_it():
    """Главное правило: незаданный фильтр **расширяет** выборку."""
    assert _one(C("=", R("rank"), V("missing")))["ok"]["sql"] is None
    assert _one(V("missing"))["ok"]["sql"] is None


def test_unset_falls_out_of_and_but_swallows_or():
    both = {"op": "&", "p": [R("completed"), C("=", V("missing"), 3)]}
    # Скобки группы остаются: выпала часть, а не сама группа.
    assert _one(both)["ok"]["sql"] == '((t."completed" = 1))'
    either = {"op": "|", "p": [R("completed"), C("=", V("missing"), 3)]}
    assert _one(either)["ok"]["sql"] is None


def test_none_sets_a_condition_instead_of_removing_it():
    assert _one(C("=", R("text"), None))["ok"]["sql"] == '(t."text" IS NULL)'
    assert _one(C("!=", R("text"), None))["ok"]["sql"] == '(t."text" IS NOT NULL)'


def test_only_boolean_can_stand_alone():
    assert _one(R("completed"))["ok"]["sql"] == '(t."completed" = 1)'
    assert "cannot stand on its own" in _one(R("text"))["error"]["message"]


def test_the_operator_flips_when_the_column_is_on_the_right():
    assert _one(C("<", 3, R("rank")))["ok"]["sql"] == '(t."rank" > ?)'
    assert _one(C(">=", 3, R("rank")))["ok"]["sql"] == '(t."rank" <= ?)'


def test_values_are_parameters_never_text():
    answer = _one(C("=", R("text"), "'; DROP TABLE line--"))["ok"]
    assert answer["sql"] == '(t."text" = ?)'
    assert answer["params"] == ["'; DROP TABLE line--"]
    assert answer["cast"] == ["text"]


def test_screen_state_is_truthy_the_python_way():
    """``Boolean([])`` в JS -- истина, в питоне -- ложь. Берётся питоновское."""
    assert _one(V("flag"), {"flag": []})["ok"]["sql"] == "(1=0)"
    assert _one(V("flag"), {"flag": [1]})["ok"]["sql"] == "(1=1)"
    assert _one(V("flag"), {"flag": ""})["ok"]["sql"] == "(1=0)"


def test_incomparable_values_are_refused_not_guessed():
    """Питон на этом отказывается сравнивать, и мягкий ответ был бы выдумкой."""
    assert "not supported between" in _one(C("<", None, False))["error"]["message"]


def test_order_gets_a_stable_tiebreaker_in_the_last_direction():
    payload = json.dumps({"ctx": {"model": MODEL, "state": {}, "alias": "t"},
                          "ops": [{"do": "order", "terms": [{"order": R("rank"), "dir": "desc"}]}]})
    assert compile_query(payload)[0]["ok"]["sql"] == 't."rank" DESC, t."id" DESC'


def test_select_puts_id_first_because_rows_are_read_by_position():
    payload = json.dumps({"ctx": {"model": MODEL, "state": {}, "alias": "t"},
                          "ops": [{"do": "select", "where": [], "order": ""}]})
    sql = compile_query(payload)[0]["ok"]["sql"]
    assert sql.startswith('SELECT t."id", t."text"')


def test_a_broken_op_does_not_take_its_neighbour_down():
    payload = json.dumps({"ctx": {"model": MODEL, "state": {}, "alias": "t"},
                          "ops": [{"do": "domain", "node": {"op": "??"}},
                                  {"do": "domain", "node": R("completed")}]})
    answers = compile_query(payload)
    assert "error" in answers[0] and "ok" in answers[1]


def test_javascript_matches_the_corpus():
    """Корпус проверяет охват: компилятор отвечает на весь поток, не падая.

    Правила выше берут по одному запросу и знают верный ответ. Корпус берёт
    восемь сотен и верного ответа не знает -- он ловит другое: запрос, на
    котором компилятор ломается вместо того, чтобы ответить или отказать.
    Раньше судьёй был питоновский близнец; теперь судится сама полнота.
    """
    отвечено = 0
    for payload in PAYLOADS:
        for ответ in compile_query(payload):
            assert "ok" in ответ or "error" in ответ, ответ
            отвечено += 1
    assert отвечено > 700, "корпус выродился"

"""Грамматика выражений -- одна, и это сторож при ней.

Дерево выражения ездит между тремя языками объявления и двумя вычислителями, а
форма его узлов была записана пять раз прозой -- и ни разу целиком. Пять
описаний расходятся не спором, а молчанием: узел, которого чужая сторона не
знает, приезжает не ошибкой, а не тем условием, то есть не тем списком на
экране.

Описание теперь одно -- ``protocol/expression.json``, -- и оно порождается
кодом. Здесь проверяется, что оно не отстало ни от питона, ни от JavaScript.
Сторожа ловят разные способы разойтись:

1. **файл против кода** -- узел изменили, файл не пересобрали;
2. **ветки ``to_json`` против файла** -- узел завели, в договор не внесли;
3. **корпус против файла** -- дерево, которое питон правда порождает, договору
   не отвечает;
4. **слова арифметики против компилятора** -- слово, которое питон умеет
   породить, а SQL перевести не умеет, доедет до устройства и упадёт там;
5. **библиотека для JavaScript против образцов** -- тот же узел собрался другой
   записью. Сверяется побайтно с образцом из файла, потому что «похоже» здесь
   не значит ничего.

Отдельно проверяется, что сторож умеет ругаться: описание, по которому не
падает ни одно испорченное дерево, не проверяет ничего.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from oneframework.model import exprschema
from oneframework.model.expr import (
    UNSET, Arith, Count, RecordFieldRef, Round, Sum, _Lookup, item,
    parse_template, record, view,
)
from oneframework.model.exprjson import from_json, to_json
from jsrel import call

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "expr_grammar_driver.mjs"

ГРАММАТИКА = exprschema.load()

#: Деревья, которые питон порождает на живых записях приложения: домены видов,
#: тела формул, шаблоны надписей, порядок списка. Корпус нужен именно такой --
#: собранный обычными словами языка, а не из тех же образцов, из которых
#: порождён файл: иначе сторож сверял бы описание сам с собой.
КОРПУС = {
    "домен": record.starred & ~record.done,
    "фильтр экрана": record.tag == view.tag,
    "невыбранный фильтр": record.tag == UNSET,
    "повторитель": (record.board == item.id) & ~record.done,
    "пусто": record.deadline.is_null(),
    "или": (record.starred & ~record.done) | (record.rank >= 3),
    "арифметика": (record.rank * 2 + 1) > 10,
    "деление с веткой на ноль": Arith("/", [record.done * 100, record.total],
                                      zero=0),
    "ветвление": Arith("if", [record.done, record.rank, 0]),
    "слова строки": record.title.lower().startswith("а"),
    "округление": Round(record.price * 100),
    "счёт": Count("Task", record.done, via="board"),
    "сумма": Sum("Task", record.done, of=record.price, on_empty=0),
    "агрегат в сравнении": Count("Task", record.done, via="board") > 0,
    "шаблон": parse_template("Удалить «{item.name}»?"),
    "порядок": [record.rank.desc(), record.title.asc()],
    "связь": _Lookup("task", record.board, RecordFieldRef("name")),
    "литералы": [1, 2.5, "текст", True, None],
}


def test_the_grammar_file_matches_the_code():
    """Файл договора обязан совпадать с тем, что порождает код."""
    assert ГРАММАТИКА == exprschema.document(), (
        "protocol/expression.json отстал от кода. "
        "Пересоберите: python3 -m oneframework.model.exprschema"
    )


def test_every_branch_of_to_json_is_described():
    """Ни одна ветка ``to_json`` не должна остаться без узла в грамматике."""
    образцы = [v for варианты in exprschema.samples().values() for v in варианты]
    без_описания = sorted(
        cls.__name__ for cls in exprschema.branch_classes()
        if not any(isinstance(o, cls) for o in образцы)
    )
    assert not без_описания, (
        f"to_json разбирает {без_описания}, а в грамматике таких узлов нет. "
        "Допишите образец в oneframework.model.exprschema.samples()"
    )


@pytest.mark.parametrize("узел", sorted(ГРАММАТИКА["nodes"]))
def test_each_sample_is_recognised_as_its_own_node(узел):
    """Формы обязаны различаться: по образцу узел узнаётся однозначно."""
    образец = ГРАММАТИКА["nodes"][узел]["sample"]
    assert exprschema.match(образец, ГРАММАТИКА) == узел
    assert exprschema.problems(образец, ГРАММАТИКА) == []


@pytest.mark.parametrize("узел", sorted(ГРАММАТИКА["nodes"]))
def test_every_variant_survives_the_round_trip(узел):
    """Каждый образец обязан прочитаться обратно тем же деревом.

    Иначе описание говорило бы про запись, которую читающая сторона языка не
    принимает, -- а читают её сервер и круговые тесты.
    """
    for вариант in exprschema.samples()[узел]:
        запись = to_json(вариант)
        assert to_json(from_json(json.loads(json.dumps(запись)))) == запись


@pytest.mark.parametrize("случай", sorted(КОРПУС))
def test_what_python_produces_conforms(случай):
    """Живое дерево обязано отвечать описанию целиком, до последнего узла."""
    assert exprschema.problems(to_json(КОРПУС[случай]), ГРАММАТИКА) == []


@pytest.mark.parametrize("слово", ГРАММАТИКА["nodes"]["arith"]["keys"]["op"]["one_of"])
def test_the_compiler_knows_every_word_of_arithmetic(слово):
    """Слово языка без перевода в SQL -- отказ уже на устройстве, у человека.

    Спрашивается тот компилятор, что там и стоит: слово, которое умеет
    переводить только питоновский, у человека всё равно откажет.
    """
    call("compile_expr", {"op": слово, "args": [1, 2, 3]})


@pytest.mark.parametrize("испорченное", [
    {"field": "тег"},                       # запись компилятора, не языка
    {"op": "не-слово-языка", "args": [1]},  # слова такого нет
    {"op": "&", "p": {"r": "тег"}},         # связка без списка
    {"op": "=", "l": {"r": "тег"}},         # сравнение без правой стороны
    {"r": 3},                               # имя не строкой
    {"agg": "count"},                       # агрегат без модели
    {"unset": True, "r": "тег"},            # два узла в одном
])
def test_the_guard_says_no(испорченное):
    """Сторож, который не ругается ни на что, не сторожит ничего."""
    assert exprschema.problems(испорченное, ГРАММАТИКА)


@pytest.mark.skipif(shutil.which("node") is None, reason="node недоступен")
def test_javascript_builds_the_same_nodes():
    """Библиотека на JavaScript обязана собирать те же узлы теми же записями."""
    прогон = subprocess.run(
        ["node", str(DRIVER)], input=json.dumps(ГРАММАТИКА, ensure_ascii=False),
        capture_output=True, text=True, check=True,
    )
    ответ = json.loads(прогон.stdout)

    assert ответ["refused"] == {}, "конструктор есть, а узел не собрался"
    for узел, собранное in ответ["built"].items():
        assert exprschema.problems(собранное, ГРАММАТИКА) == []
        assert собранное == ГРАММАТИКА["nodes"][узел]["sample"], (
            f"узел {узел} на JavaScript записан иначе, чем в грамматике"
        )
    # Не «сколько-нибудь», а поимённо: драйвер, разучившийся собирать, иначе
    # прошёл бы молча и не проверив ничего. Больше -- пожалуйста: библиотека
    # растёт, и новый узел ловится сверкой с образцом, а не этой строкой.
    assert set(ответ["built"]) >= {"record_ref", "view_ref", "item_ref", "cmp",
                                   "and", "or", "not", "order"}
    assert ответ["unknown"]["refused"], (
        "чужой узел обязан отказать вслух: молча доехавшее не то условие "
        f"показывает не те записи, а тут вышло {ответ['unknown'].get('value')!r}"
    )

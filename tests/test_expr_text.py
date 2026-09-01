"""Выражение строкой -- то же дерево, что строит питоновский DSL.

Зачем текстовая запись. Сегодня выражение нельзя написать, его можно только
построить, запустив язык: питон -- перегрузкой операторов (33 класса, 80
методов вида ``__eq__``), Kotlin -- инфиксными функциями. За одну и ту же
выразительность питон платит 257 строк против 56, и так будет в каждой новой
привязке. Хуже другое: ``Expr.kt`` покрывает семь родов узлов из четырнадцати,
и на Kotlin нельзя объявить ни арифметику, ни свёртку по набору.

Разборщик один, в ядре (`src/build/exprtext.mjs`). Привязке довольно
передать строку -- дерево соберёт ядро.

Сверять есть с чем, и это главное: питоновский DSL строит те же деревья уже
сегодня. Он и есть образец. Разойдись разборщик с ним -- одно и то же условие
показывало бы разные записи в зависимости от языка, на котором объявлено.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import needs_node
from oneframework import Boolean, Integer, Many2one, Model, String
from oneframework.model.expr import record, view
from oneframework.model.exprjson import to_json

ROOT = Path(__file__).resolve().parents[1]
РАЗБОРЩИК = ROOT / "src" / "build" / "exprtext.mjs"

pytestmark = needs_node


class ТегДляТекста(Model):
    name = String("Имя")


class СтрокаДляТекста(Model):
    text = String("Текст")
    n = Integer("Сколько")
    done = Boolean("Готово")
    tag = Many2one(ТегДляТекста, "Тег")


#: Текст и то же самое, построенное питоном. Пары, а не отдельные списки:
#: проверяется именно совпадение, и разъехаться им негде.
ПАРЫ = [
    ("record.done",                    record.done),
    ("record.n",                       record.n),
    ("view.q",                         view.q),
    ("record.n > 3",                   record.n > 3),
    ("record.n >= 3",                  record.n >= 3),
    ("record.n < 3",                   record.n < 3),
    ("record.n <= 3",                  record.n <= 3),
    ("record.n = 3",                   record.n == 3),
    ("record.n != 3",                  record.n != 3),
    ('record.text = "да"',             record.text == "да"),
    ("record.done & record.n",         record.done & record.n),
    ("record.done | record.n",         record.done | record.n),
    ("!record.done",                   ~record.done),
    ("record.done & !record.n",        record.done & ~record.n),
    ("record.n + 1",                   record.n + 1),
    ("record.n - 1",                   record.n - 1),
    ("record.n * 2",                   record.n * 2),
    ("record.n / 2",                   record.n / 2),
    ("record.n // 2",                  record.n // 2),
    ("record.n % 2",                   record.n % 2),
    ("record.n ** 2",                  record.n ** 2),
    ("-record.n",                      -record.n),
    ("record.n * 2 - 1",               record.n * 2 - 1),
    # Порядок действий -- на полях, а не на числах: `2 * 3` питон сложит сам,
    # своей арифметикой, ещё до DSL, и сравнивать было бы нечего.
    ("record.n + record.n * 3",        record.n + record.n * 3),
    ("(record.n + 2) * 3",             (record.n + 2) * 3),
    ("abs(record.n)",                  abs(record.n)),
    # Степень правоассоциативна у обоих: `a ** b ** c` -- это `a ** (b ** c)`.
    # Без этой пары левая ассоциативность проходила проверку -- замерено.
    ("record.n ** record.n ** 2",      record.n ** record.n ** 2),
    # Пусто у SQL не равно ничему, включая себя, поэтому это отдельный род
    # узла, а не сравнение. Без пары «is not null» неотличимо от «is null».
    ("record.n is null",               record.n.is_null()),
    ("record.n is not null",           ~record.n.is_null()),
]


def _на_js(тексты):
    скрипт = (
        'import { parseExpr } from ' + json.dumps(str(РАЗБОРЩИК)) + ';\n'
        'const из = JSON.parse(process.argv[1]);\n'
        'process.stdout.write(JSON.stringify(из.map((т) => {\n'
        '  try { return { ok: parseExpr(т) }; }\n'
        '  catch (о) { return { error: о.message }; }\n'
        '})));'
    )
    г = subprocess.run(["node", "--input-type=module", "-e", скрипт,
                        json.dumps(тексты, ensure_ascii=False)],
                       capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert г.returncode == 0, г.stderr
    return json.loads(г.stdout)


@pytest.fixture(scope="module")
def разобрано():
    return _на_js([т for т, _ in ПАРЫ])


@pytest.mark.parametrize("номер", range(len(ПАРЫ)), ids=[т for т, _ in ПАРЫ])
def test_the_text_form_builds_the_same_tree(разобрано, номер):
    текст, узел = ПАРЫ[номер]
    ответ = разобрано[номер]
    assert "ok" in ответ, f"{текст}: {ответ.get('error')}"
    ровно = lambda x: json.dumps(x, ensure_ascii=False, sort_keys=True)
    assert ровно(ответ["ok"]) == ровно(to_json(узел)), текст


def test_the_pairs_are_not_all_the_same_shape():
    """Иначе сверка зеленела бы на одном роде узла, повторённом двадцать раз."""
    родов = set()
    for _, узел in ПАРЫ:
        д = to_json(узел)
        родов.add(д.get("op") if isinstance(д, dict) else type(д).__name__)
    assert len(родов) >= 8, sorted(map(str, родов))


#: Каждая строка тут -- отказ, и он обязан назвать место. Молча разобранное «не
#: то» показывает не те записи, а увидеть это можно только по чужой жалобе.
МУСОР = {
    "неизвестное слово":      ("done", "record.done"),
    "поле без приставки":     ("n > 3", "record.n"),
    "лишний хвост":           ("record.n 5", "лишнее"),
    "оборванное":             ("record.n +", "оборв"),
    "скобка не закрыта":      ("(record.n", "ждали"),
    "строка не закрыта":      ('record.text = "да', "не закрыта"),
    "нет такого действия":    ("считай(record.n)", "нет такого действия"),
    "мало доводов":           ("replace(record.text)", "ждёт"),
    "непонятный знак":        ("record.n @ 3", "непонятный знак"),
    "пусто":                  ("", "оборв"),
}


@pytest.mark.parametrize("случай", sorted(МУСОР))
def test_a_broken_text_is_refused_by_name(случай):
    текст, слово = МУСОР[случай]
    ответ = _на_js([текст])[0]
    assert "error" in ответ, f"{текст!r} разобралось: {ответ.get('ok')}"
    assert слово in ответ["error"], ответ["error"]

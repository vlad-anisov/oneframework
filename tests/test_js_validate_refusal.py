"""Проверка набора на исходном языке -- отказ, а не тишина.

Считается она внутри записи, а запись синхронна: транзакция не умеет
дождаться обещания. Действие на исходном языке обещание и возвращает, и
``validator`` читает у ответа поле с ошибками -- у обещания такого поля нет.
Значит проверка, на которую рассчитывают, молча пропускала бы всё.

Нашёл это разбор со стороны 20.08.2026. Своей проверки на этот случай у нас
не было ни одной, потому что ни один пример такую проверку не объявляет: до
неё доходили только чтением кода.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "validate_driver.mjs"


@needs_node
def ответ():
    вывод = subprocess.run(
        ["node", str(DRIVER)], capture_output=True, text=True, check=True, cwd=ROOT,
    ).stdout
    return json.loads(вывод)


@needs_node
def test_a_source_language_check_is_refused_at_load():
    для = ответ()
    for язык in ("python", "js"):
        assert для[язык]["отвергнуто"], f"{язык}: проверка принята молча"
        #: Отказ обязан называть и причину, и выход -- иначе он бесполезен.
        assert "запись синхронна" in для[язык]["слово"]
        assert "rule" in для[язык]["слово"]


@needs_node
def test_a_declarative_check_still_passes():
    """Отказ обязан быть узким: описанная объявлением проверка работает."""
    assert ответ()["объявлением"]["отвергнуто"] is False

"""Определения в базе устройства: отпечаток, ревизия и «что вам не доехало».

Правила были записаны дважды -- у питоновского писателя (`model/defs.py`) и у
того, что на устройстве. Сторожила их только питоновская запись. Проверено
мутацией 21.08.2026: и «ревизия растёт только на настоящую правку», и сам её
рост можно было снять в `src/runtime/defs.js`, оставив **всю сюиту
зелёной**. Беззащитной была живая половина.

Почему эти правила вообще важны:

* **отпечаток от смысла, а не от записи.** Переставь ключи в документе -- и
  обмен повёз бы то же самое ещё раз, всем устройствам;
* **ревизия растёт только на настоящую правку.** По ней устройство решает, чьё
  определение новее; растущая на пустом месте делает старое новым;
* **`changedSince` отвечает на вопрос доставки.** Ответь она «всё» -- обмен
  возит определения кругами; ответь «ничего» -- новое не доезжает вовсе.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "defs_driver.mjs"

pytestmark = needs_node

_ОТВЕТ = None


def ответ():
    global _ОТВЕТ
    if _ОТВЕТ is None:
        готово = subprocess.run(["node", str(DRIVER)], capture_output=True,
                                text=True, encoding="utf-8", cwd=str(ROOT))
        assert готово.returncode == 0, готово.stderr
        _ОТВЕТ = json.loads(готово.stdout)
    return _ОТВЕТ


def test_the_fingerprint_is_of_the_meaning_not_of_the_spelling():
    """Порядок ключей ничего не значит, а изменение значения -- значит."""
    о = ответ()["fingerprint"]
    assert о["sameOrder"], "переставленные ключи дали другой отпечаток"
    assert о["realChange"], "изменение значения отпечаток не заметил"


def test_putting_the_same_document_twice_is_not_a_change():
    """Иначе каждая сборка возила бы всем устройствам то же самое заново."""
    о = ответ()["put"]
    assert о["first"] is True, "первая выкладка не признана правкой"
    assert о["again"] is False, "повтор того же признан правкой"
    assert о["changed"] is True, "настоящая правка не признана правкой"


def test_the_revision_grows_only_on_a_real_change():
    """По ревизии устройство решает, чьё определение новее."""
    ревизии = dict(ответ()["revisions"])
    assert ревизии["X"] == 2, f"три выкладки, из них две разные -> ревизия 2: {ревизии}"


def test_the_stored_document_is_the_last_one_written():
    """Ревизия ревизией, а лежать обязано последнее."""
    assert ответ()["stored"]["title"] == "Другой"


def test_changed_since_answers_the_delivery_question():
    """Собеседнику везём только то, чего у него нет."""
    о = ответ()["changedSince"]
    assert о["nothingKnown"] == 1, "не знающему ничего не повезли ничего"
    assert о["allKnown"] == 0, "знающему всё повезли лишнее"


def test_an_unknown_kind_is_refused():
    """Вид определения -- закрытый список: чужой не должен лечь молча."""
    assert "выдумка" in ответ()["unknownKind"], ответ()["unknownKind"]

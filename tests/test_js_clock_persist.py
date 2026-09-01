"""Часы устройства переживают перезапуск: узел тот же, отметка растёт.

Номер узла говорит, **кто именно** правил запись. Заведись он заново при каждом
запуске -- сервер обмена перестал бы узнавать своего, и changeset'ы
возвращались бы отправителю. Отметка, начавшая сначала, делает свежую правку
старее чужой давнишней: слияние по колонкам выберет не то значение, и никто
ничего не скажет.

Правило было записано дважды -- у питоновской базы и у той, что на устройстве, --
и сторожилось только на питоновской. Проверено мутацией 21.08.2026: снятое
сохранение узла и снятое сохранение часов оставляли по 698 зелёных проверок.

«Перезапуск» здесь настоящий: база выгружается байтами в файл и поднимается из
него заново, как это делает устройство между запусками приложения.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "clock_persist_driver.mjs"

pytestmark = needs_node

_ОПИСАНИЕ = r"""
import json, sys
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2])
from oneframework.model.schema import app_schema
print(json.dumps({"schema": app_schema(__import__("app").app)}, ensure_ascii=False))
"""


@pytest.fixture(scope="module")
def сеансы():
    описание = subprocess.run(
        [sys.executable, "-c", _ОПИСАНИЕ, str(ROOT), str(ROOT / "examples" / "todo")],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert описание.returncode == 0, описание.stderr

    with tempfile.TemporaryDirectory() as каталог:
        ввод = {"schema": json.loads(описание.stdout)["schema"], "model": "TodoLine",
                "file": str(Path(каталог) / "device.db"),
                "values": {"text": "До перезапуска"}, "change": {"text": "После"}}
        готово = subprocess.run(["node", str(DRIVER)], input=json.dumps(ввод, ensure_ascii=False),
                                capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
        assert готово.returncode == 0, готово.stderr
        return json.loads(готово.stdout)


def test_the_device_keeps_its_node_across_a_restart(сеансы):
    """Два устройства с одним номером узла перестают видеть друг друга молча."""
    первый, второй = сеансы["первый"], сеансы["второй"]
    assert первый["node"], "узел не записан вовсе"
    assert второй["node"] == первый["node"], "после перезапуска узел стал другим"


def test_the_stamp_grows_across_a_restart(сеансы):
    """Отметка, начавшая сначала, делает свежую правку старее чужой давнишней.

    Оговорка, без которой проверка кажется сильнее, чем есть: между сеансами
    идут настоящие часы, поэтому вторая отметка больше первой и **без**
    сохранённой `hlc:last`. Мутация «часы не сохраняются» её не роняет
    (проверено). Питоновская проверка, стоявшая здесь до 21.08.2026, была ровно
    такой же и тем же слабым местом обладала -- переезд ничего не потерял.

    Настоящая работа `hlc:last` -- монотонность, когда настенные часы пошли
    назад или две правки попали в одну миллисекунду. Проверить это можно только
    управляя часами, и такой проверки у нас нет ни на одной стороне. Долг
    записан здесь, чтобы его было видно.
    """
    первый, второй = сеансы["первый"], сеансы["второй"]
    assert второй["stamp"] > первый["stamp"], (первый["stamp"], второй["stamp"])


def test_the_stamp_carries_the_node(сеансы):
    """Узел -- часть отметки: по нему разрешается ничья при равном времени."""
    assert сеансы["первый"]["stamp"].endswith(сеансы["первый"]["node"])

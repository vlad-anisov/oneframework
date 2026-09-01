"""Значки и адрес обмена -- правилами, а не сверкой с питоном.

Сборщик переехал на JavaScript. Пока переезжал, здесь стояла двусторонняя
сверка: питоновский `_png`/`_icon_pixels`/`sync_address` против
`src/build/assets.mjs`, байт в байт. Она свою работу сделала --
питоновской половины больше нет, и сверять не с чем. Остались правила,
записанные прямо.

Значок проверяется не «похож ли», а разбором: заголовок PNG, размеры, тип
цвета, и то, что галочка вправду нарисована. Файл уедет на устройство, и
«похожая картинка» тут не ответ.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import zlib
from pathlib import Path

import pytest

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
pytestmark = needs_node

_НА_JS = r"""
import { writeFileSync } from "node:fs";
import { iconPixels, png, syncAddress } from "ПУТЬ/js/src/build/assets.mjs";

const что = process.argv[2];
if (что === "icon") {
  writeFileSync(process.argv[4], png(Number(process.argv[3]),
                                     iconPixels(Number(process.argv[3]))));
} else if (что === "sync") {
  process.stdout.write(JSON.stringify(syncAddress(JSON.parse(process.argv[3]))));
}
"""


def _скрипт(tmp_path):
    ф = tmp_path / "assets.mjs"
    ф.write_text(_НА_JS.replace("ПУТЬ", str(ROOT / "libs")), encoding="utf-8")
    return ф


def _значок(tmp_path, размер):
    цель = tmp_path / f"icon-{размер}.png"
    г = subprocess.run(["node", str(_скрипт(tmp_path)), "icon", str(размер), str(цель)],
                       capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert г.returncode == 0, г.stderr
    return цель.read_bytes()


def _разобрать_png(байты):
    """Заголовок и точки. Свой разбор, чтобы не тащить зависимость ради проверки."""
    assert байты[:8] == b"\x89PNG\r\n\x1a\n", "это не PNG"
    i, куски = 8, {}
    while i < len(байты):
        (длина,) = struct.unpack(">I", байты[i:i + 4])
        тег = байты[i + 4:i + 8]
        данные = байты[i + 8:i + 8 + длина]
        (сумма,) = struct.unpack(">I", байты[i + 8 + длина:i + 12 + длина])
        assert сумма == zlib.crc32(тег + данные) & 0xFFFFFFFF, f"CRC не сошлась у {тег}"
        куски[тег] = данные
        i += 12 + длина
    ширина, высота, глубина, цвет = struct.unpack(">IIBB", куски[b"IHDR"][:10])
    сырое = zlib.decompress(куски[b"IDAT"])
    строка = ширина * 4 + 1
    точки = []
    for y in range(высота):
        assert сырое[y * строка] == 0, "фильтр строки обязан быть «никакой»"
        точки.append([tuple(сырое[y * строка + 1 + x * 4: y * строка + 5 + x * 4])
                      for x in range(ширина)])
    return {"ширина": ширина, "высота": высота, "глубина": глубина,
            "цвет": цвет, "точки": точки}


@pytest.mark.parametrize("размер", [192, 512])
def test_the_icon_is_a_valid_rgba_png(tmp_path, размер):
    п = _разобрать_png(_значок(tmp_path, размер))
    assert (п["ширина"], п["высота"]) == (размер, размер)
    assert п["глубина"] == 8
    assert п["цвет"] == 6, "тип 6 -- RGBA; без альфы значок потеряет маску"


@pytest.mark.parametrize("размер", [192, 512])
def test_the_icon_actually_draws_a_check_mark(tmp_path, размер):
    """Не «файл есть», а «на нём что-то нарисовано».

    Пустая заливка тоже была бы правильным PNG нужного размера, и проверка
    заголовков её бы пропустила -- на устройстве оказался бы одноцветный
    квадрат.
    """
    точки = _разобрать_png(_значок(tmp_path, размер))["точки"]
    фон = (103, 80, 164, 255)
    белых = sum(1 for строка in точки for т in строка if т[:3] == (255, 255, 255))
    иных = sum(1 for строка in точки for т in строка if т != фон)
    assert точки[0][0] == фон, "угол обязан остаться фоном"
    assert белых > размер, "белого слишком мало для галочки"
    # Сглаженные края -- не фон и не чистый белый: без них галочка ступенчатая.
    assert иных > белых, "краёв нет -- сглаживание пропало"


def test_the_icon_is_the_same_on_every_run(tmp_path):
    """Один и тот же значок при каждом запуске: иначе сборка меняет файл зря.

    Изменившийся байт значка -- изменившийся отпечаток офлайн-кэша, то есть
    перезакачка всего приложения на каждой сборке.
    """
    второй = tmp_path / "второй"
    второй.mkdir()
    assert _значок(tmp_path, 192) == _значок(второй, 192)


#: Пусто и «off» значат одно -- обмена нет. Отсутствие переменной значит другое:
#: оставить то, что объявило приложение. Спутать их -- собрать неотключаемый
#: обмен либо молча выключить объявленный.
ГАСЯТ = ["off", "OFF", "", "0", "none", "  "]
ЗАДАЮТ = {"https://terminal.anisov.by": "https://terminal.anisov.by",
          "  https://x  ": "https://x"}


def _адрес(tmp_path, мета, значение):
    окружение = {**os.environ}
    if значение is None:
        окружение.pop("PYAPP_SYNC_URL", None)
    else:
        окружение["PYAPP_SYNC_URL"] = значение
    г = subprocess.run(
        ["node", str(_скрипт(tmp_path)), "sync", json.dumps(мета, ensure_ascii=False)],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT), env=окружение)
    assert г.returncode == 0, г.stderr
    return json.loads(г.stdout)


@pytest.mark.parametrize("значение", ГАСЯТ)
def test_an_empty_or_off_address_switches_sync_off(tmp_path, значение):
    assert _адрес(tmp_path, {"sync": "объявленный"}, значение)["sync"] is False


@pytest.mark.parametrize("значение", sorted(ЗАДАЮТ))
def test_an_address_replaces_the_declared_one_trimmed(tmp_path, значение):
    assert _адрес(tmp_path, {"sync": "объявленный"}, значение)["sync"] == ЗАДАЮТ[значение]


def test_no_variable_leaves_the_declared_address_alone(tmp_path):
    """Переменной нет -- мета не тронута. Это не то же, что «обмена нет»."""
    мета = {"title": "T", "sync": "объявленный"}
    assert _адрес(tmp_path, мета, None) == мета

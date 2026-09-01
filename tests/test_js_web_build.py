"""Список офлайн-кэша и конфиг сборки -- правилами, а не сверкой с питоном.

Пока сборщик переезжал на JavaScript, здесь стояла двусторонняя сверка с
`oneframework/cli/builders/web.py`. Она нашла то, ради чего и ставилась: питон
сортирует пути **по частям**, а не по строке, и обход по строкам поставил бы
«a/b.js» раньше «a/b/c/deep.js». Питоновской половины больше нет; правило
осталось, и записано здесь прямо.

Порядок важен не сам по себе: по списку считается отпечаток кэша. Другой
порядок -- другой отпечаток, то есть перезакачка всего приложения на ровном
месте, и связать её с обходом каталогов было бы нечем.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
pytestmark = needs_node

#: Каверзное дерево: файл и каталог с общим началом имени, вложенность, и то,
#: чему в кэше не место.
ДЕРЕВО = [
    "index.html", "assets/index-abc.js", "assets/index-abc.css", "assets.txt",
    "a/b/c/deep.js", "a/b.js", "icons/icon-192.png", "sw.js", ".DS_Store",
]

_SW_НА_JS = r"""
import { injectServiceWorker } from "ПУТЬ/js/src/build/web.mjs";
injectServiceWorker(process.argv[2], Number(process.argv[3]));
"""

_ПОРЯДОК_НА_JS = r"""
import { поПорядку } from "ПУТЬ/js/src/build/web.mjs";
const части = JSON.parse(process.argv[2]).map((п) => п.split("/"));
process.stdout.write(JSON.stringify(поПорядку(части).map((ч) => ч.join("/"))));
"""

_КОНФИГ_НА_JS = r"""
import { readFileSync } from "node:fs";
import { Bundle } from "ПУТЬ/js/src/build/bundle.mjs";
import { writeBuildConfig } from "ПУТЬ/js/src/build/web.mjs";
writeBuildConfig(process.argv[3], new Bundle(JSON.parse(readFileSync(process.argv[2], "utf8"))));
"""


def _node(tmp_path, исходник, имя, *аргументы):
    ф = tmp_path / имя
    ф.write_text(исходник.replace("ПУТЬ", str(ROOT / "libs")), encoding="utf-8")
    return subprocess.run(["node", str(ф), *map(str, аргументы)],
                          capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))


def _разложить(корень: Path):
    for имя in ДЕРЕВО:
        ф = корень / имя
        ф.parent.mkdir(parents=True, exist_ok=True)
        ф.write_text("/*__ASSETS__*/ []\n__BUILD_ID__\n" if имя == "sw.js" else имя,
                     encoding="utf-8")


def _список(текст):
    начало = текст.index("[")
    return json.loads(текст[начало:текст.index("]", начало) + 1])


def test_the_precache_list_holds_every_file_but_the_worker(tmp_path):
    dist = tmp_path / "dist"
    _разложить(dist)
    г = _node(tmp_path, _SW_НА_JS, "sw.mjs", dist, 1_700_000_000)
    assert г.returncode == 0, г.stderr

    список = _список((dist / "sw.js").read_text(encoding="utf-8"))
    # Свой файл в свой же кэш класть нельзя: обновиться он тогда не сможет.
    assert "./sw.js" not in список
    assert "./.DS_Store" not in список
    assert set(список) == {"./" + и for и in ДЕРЕВО if и not in ("sw.js", ".DS_Store")}


def test_the_build_id_lands_in_the_worker(tmp_path):
    """Имя кэша обязано смениться вместе со сборкой -- иначе старое останется."""
    dist = tmp_path / "dist"
    _разложить(dist)
    assert _node(tmp_path, _SW_НА_JS, "sw.mjs", dist, 1_700_000_000).returncode == 0
    текст = (dist / "sw.js").read_text(encoding="utf-8")
    assert "__BUILD_ID__" not in текст, "отпечаток не подставлен"


def test_the_build_id_follows_the_moment_of_the_build(tmp_path):
    """Две сборки одного дерева в разные секунды -- разные отпечатки."""
    отпечатки = []
    for время in (1_700_000_000, 1_700_000_001):
        dist = tmp_path / f"dist-{время}"
        _разложить(dist)
        assert _node(tmp_path, _SW_НА_JS, "sw.mjs", dist, время).returncode == 0
        текст = (dist / "sw.js").read_text(encoding="utf-8")
        отпечатки.append(текст.split("\n")[-2] if текст else "")
    assert отпечатки[0] != отпечатки[1], отпечатки


def test_a_missing_service_worker_is_reported_not_crashed(tmp_path):
    """`sw.js` нет -- предупреждение, а не падение: офлайн просто не будет."""
    пусто = tmp_path / "пусто"
    пусто.mkdir()
    г = _node(tmp_path, _SW_НА_JS, "sw.mjs", пусто, 1_700_000_000)
    assert г.returncode == 0, г.stderr
    assert "sw.js missing" in г.stdout


#: Перемешанный список -- чтобы порядок задавала сортировка, а не обход.
#:
#: Через файловую систему это правило **не проверить**: обход выдаёт имена в
#: том порядке, в каком их отдаёт файловая система, а APFS отдаёт их уже
#: отсортированными -- снятая сортировка оставляла ту проверку зелёной,
#: замерено. Проверка, зависящая от файловой системы, -- не проверка. Поэтому
#: правило проверяется прямо и перемешанным входом.
ПУТИ = [
    "assets.txt", "a/b.js", "index.html", "a/b/c/deep.js",
    "assets/index-abc.css", "icons/icon-192.png", "assets/index-abc.js",
    "a/b/c.js", "a/bb.js", "z", "a/b/c/d/e.js",
]


def test_paths_are_ordered_by_their_parts_not_as_strings(tmp_path):
    """«a/b/c/deep.js» раньше «a/b.js»: «b» короче «b.js», а «.» меньше «/».

    Правило то же, что у ``sorted(Path)`` в питоне, и это не совпадение: под
    ним собраны все прежние сборки, и сменить порядок значило бы обесценить
    кэш у всех, кто уже поставил приложение.
    """
    ожидается = [str(p) for p in sorted(Path(x) for x in ПУТИ)]
    г = _node(tmp_path, _ПОРЯДОК_НА_JS, "порядок.mjs", json.dumps(ПУТИ))
    assert г.returncode == 0, г.stderr
    assert json.loads(г.stdout) == ожидается
    # Строчная сортировка дала бы другое -- иначе проверять было бы нечего.
    assert ожидается != sorted(ПУТИ)


def _пакет_todo():
    г = subprocess.run(
        ["python3", "-c",
         "import json, sys; sys.path.insert(0, sys.argv[1]);"
         " sys.path.insert(0, sys.argv[1] + '/examples/todo');"
         " import app; from oneframework.declaration import declare;"
         " print(json.dumps(declare(app.app), ensure_ascii=False, default=str))",
         str(ROOT)],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert г.returncode == 0, г.stderr
    return json.loads(г.stdout)


def _конфиг(tmp_path, имя, поставка=None):
    корень = tmp_path / имя
    (корень / "web" / "public").mkdir(parents=True)
    if поставка is not None:
        (корень / "web" / "public" / "oneframework-bundle.zip").write_bytes(поставка)
    файл = tmp_path / f"пакет-{имя}.json"
    файл.write_text(json.dumps(_пакет_todo(), ensure_ascii=False), encoding="utf-8")
    г = _node(tmp_path, _КОНФИГ_НА_JS, f"конфиг-{имя}.mjs", файл, корень)
    assert г.returncode == 0, г.stderr
    return json.loads((корень / ".oneframework-build.json").read_text(encoding="utf-8"))


def test_the_build_config_carries_what_the_shell_needs_before_the_database(tmp_path):
    """Тема и цвет читаются раньше базы -- по ним строится Framework7."""
    к = _конфиг(tmp_path, "простой")
    assert set(к) == {"theme", "color", "dynamic_color", "title", "build"}
    assert к["title"] == "Todo"
    assert к["color"].startswith("#")
    assert к["build"] == "dev", "поставки нет -- отпечатку неоткуда взяться"


def test_the_build_id_follows_the_shipped_bundle(tmp_path):
    """Отпечаток берётся из `oneframework-bundle.zip`, если он есть.

    Он обесценивает кэш снимка интерпретатора: не сменись он вместе с
    поставкой, устройство подняло бы старый снимок к новому приложению -- и
    разошлись бы они молча, уже у пользователя.
    """
    один = _конфиг(tmp_path, "с-поставкой", b"PK\x03\x04" * 64)
    другой = _конфиг(tmp_path, "иная-поставка", b"PK\x03\x04" * 65)
    assert один["build"] != "dev"
    assert len(один["build"]) == 16, один["build"]
    assert один["build"] != другой["build"], "отпечаток не следует за поставкой"

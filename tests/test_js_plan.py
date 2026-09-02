"""План выкладки -- правилами, а не сверкой с питоном.

Пока сборщик переезжал, здесь стояла двусторонняя сверка: `cli/plan.py` на
питоне против `libs/js/src/build/plan.mjs`, план целиком как текст. Она свою
работу сделала: правило теперь записано один раз, а питоновская дверь
(`cli/plan.py`) за ним только ходит -- сравнивать стало нечего, кроме кода с
самим собой.

Остались правила, которые видно только на плане: что кладётся определением, что
отказывается вслух и откуда берётся ключ издателя.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
ПРИМЕРЫ = sorted(p.parent.name for p in ROOT.glob("examples/*/app.py"))

pytestmark = needs_node

_ПАКЕТ = r"""
import json, sys
from pathlib import Path

корень, пример = sys.argv[1], sys.argv[2]
sys.path.insert(0, корень)
sys.path.insert(0, str(Path(корень) / "examples" / пример))

import app as модуль
try:
    import seed as модуль_посева
    посев = getattr(модуль_посева, "seed", None)
except ImportError:
    посев = None

from oneframework.declaration import declare
print(json.dumps(declare(модуль.app, посев), ensure_ascii=False, default=str))
"""

_ПЛАН_НА_JS = r"""
import { readFileSync } from "node:fs";
import { buildPlan } from "ПУТЬ/js/src/build/plan.mjs";
process.stdout.write(JSON.stringify(
  buildPlan(JSON.parse(readFileSync(process.argv[2], "utf8")))));
"""


def _пакет(пример):
    г = subprocess.run([sys.executable, "-c", _ПАКЕТ, str(ROOT), пример],
                       capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert г.returncode == 0, г.stderr
    return json.loads(г.stdout)


def _план(tmp_path, пакет, окружение=None):
    файл = tmp_path / "пакет.json"
    файл.write_text(json.dumps(пакет, ensure_ascii=False), encoding="utf-8")
    скрипт = tmp_path / "план.mjs"
    скрипт.write_text(_ПЛАН_НА_JS.replace("ПУТЬ", str(ROOT / "libs")), encoding="utf-8")
    return subprocess.run(["node", str(скрипт), str(файл)],
                          capture_output=True, text=True, encoding="utf-8",
                          cwd=str(ROOT), env={**os.environ, **(окружение or {})})


@pytest.mark.parametrize("пример", ПРИМЕРЫ)
def test_every_declared_thing_reaches_the_plan(tmp_path, пример):
    """Всё объявленное обязано стать определением: ничего не теряется по пути."""
    пакет = _пакет(пример)
    г = _план(tmp_path, пакет)
    assert г.returncode == 0, г.stderr
    план = json.loads(г.stdout)

    роды = {}
    for вид, имя, _ in план["defs"]:
        роды.setdefault(вид, []).append(имя)
    assert роды.get("types") == ["_"], "таблица типов кладётся ровно одна"
    # И не пустая: имя записи ничего не говорит о том, что в ней. Без этой
    # строки подменённая на `{}` таблица проходила проверку -- замерено, а
    # на устройстве это значит «ни одного известного типа поля».
    типы = next(д[2] for д in план["defs"] if д[0] == "types")
    assert типы == пакет["types"] and типы, типы
    assert sorted(роды.get("model", [])) == sorted(м["name"] for м in пакет["models"])
    assert sorted(роды.get("view", [])) == sorted(в["name"] for в in пакет["views"])
    объявлено = [д["name"] for з in пакет["logic"] for д in з.get("actions") or []]
    assert sorted(роды.get("action", [])) == sorted(объявлено)
    # Порядок определений -- по нему считается ревизия, и он обязан быть
    # тем же, что в пакете: перестановка сменила бы ревизию на ровном месте.
    assert план["defs"][0][0] == "types"


@pytest.mark.parametrize("пример", ПРИМЕРЫ)
def test_the_schema_is_the_bundle_types_and_models(tmp_path, пример):
    """Схему план не выдумывает: она -- то же описание, что в пакете.

    Третьей записи правила создания таблиц нет: их заводит `db.ensureSchema`
    на устройстве, одна реализация на всех.
    """
    пакет = _пакет(пример)
    г = _план(tmp_path, пакет)
    assert г.returncode == 0, г.stderr
    схема = json.loads(г.stdout)["schema"]
    assert схема["version"] == 1
    assert схема["types"] == пакет["types"]
    assert [м["name"] for м in схема["models"]] == [м["name"] for м in пакет["models"]]


def test_the_publisher_key_is_the_raw_key_in_hex(tmp_path):
    """Ключ издателя -- 64 шестнадцатеричных знака, те же, что видит питон.

    Голыми 32 байтами, а не PEM: на устройстве он попадает в
    `crypto.subtle.importKey("raw", ...)`. Разойдись он с тем, чем подписано, --
    подпись перестала бы проверяться, и увидел бы это пользователь.
    """
    from oneframework import keys

    ключ = tmp_path / "издатель.pem"
    keys.write_private(keys.generate(), ключ)
    окружение = {"PYAPP_SIGNING_KEY": str(ключ)}

    г = _план(tmp_path, _пакет("todo"), окружение)
    assert г.returncode == 0, г.stderr
    свой = keys.public_hex(keys.load_private(ключ))
    assert json.loads(г.stdout)["publisher"] == свой
    assert len(свой) == 64


def test_no_key_named_means_no_publisher(tmp_path):
    """Ключ не назван -- сборка законна и подписи в ней нет."""
    окружение = {к: v for к, v in os.environ.items() if к != "PYAPP_SIGNING_KEY"}
    файл = tmp_path / "пакет.json"
    файл.write_text(json.dumps(_пакет("todo"), ensure_ascii=False), encoding="utf-8")
    скрипт = tmp_path / "план.mjs"
    скрипт.write_text(_ПЛАН_НА_JS.replace("ПУТЬ", str(ROOT / "libs")), encoding="utf-8")
    г = subprocess.run(["node", str(скрипт), str(файл)], capture_output=True,
                       text=True, encoding="utf-8", cwd=str(ROOT), env=окружение)
    assert г.returncode == 0, г.stderr
    assert json.loads(г.stdout)["publisher"] is None


def test_a_named_but_missing_key_is_refused(tmp_path):
    """Ключ назван и негоден -- отказ.

    Собрать неподписанное вместо подписанного значит выдать одно за другое, и
    заметить подмену негде: файл соберётся, подписи в нём просто не окажется.
    """
    г = _план(tmp_path, _пакет("todo"),
              {"PYAPP_SIGNING_KEY": str(tmp_path / "нет-такого.pem")})
    assert г.returncode != 0
    assert "нет-такого" in г.stderr


ПОЛОМКИ = {
    "не пакет":            (lambda п: п.clear() or п.update({"нет": "разделов"}),
                            "пакет объявления"),
    "действие без правила": (lambda п: п.update(
                                logic=[{"actions": [{"name": "Пустышка"}]}]), "Пустышка"),
    "логика модулем":      (lambda п: п.update(
                                logic=[{"module": "старый.wasm", "actions": []}]),
                            "старый.wasm"),
}


@pytest.mark.parametrize("случай", sorted(ПОЛОМКИ))
def test_a_broken_bundle_stops_the_plan(tmp_path, случай):
    правка, слово = ПОЛОМКИ[случай]
    пакет = json.loads(json.dumps(_пакет("todo")))
    правка(пакет)
    г = _план(tmp_path, пакет)
    assert г.returncode != 0, г.stdout
    assert слово in г.stderr, г.stderr

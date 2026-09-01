"""Пакет читают двое, и они обязаны прочесть одно.

Сборщик переезжает на JavaScript, и `Bundle` -- вторая перенесённая часть после
плана. На время переезда правило живёт в двух местах: `oneframework/declaration.py`
и `src/build/bundle.mjs`. Здесь их ответы сверяются целиком.

Сверяется не только `meta`, но и **отказы**: пакет, который питон не принял, а
JavaScript принял, -- это дыра, через которую на устройство уедет приложение,
не прошедшее проверку у соседа. Отказ обязан быть у обоих и об одном.
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

_ПАКЕТ_И_МЕТА = r"""
import json, sys
from pathlib import Path

корень, пример = sys.argv[1], sys.argv[2]
sys.path.insert(0, корень)
sys.path.insert(0, str(Path(корень) / "examples" / пример))

import app as модуль
from oneframework.declaration import Bundle, declare

пакет = declare(модуль.app)
print(json.dumps({"пакет": пакет,
                  "meta": Bundle(json.loads(json.dumps(пакет))).meta()},
                 ensure_ascii=False, default=str))
"""

_МЕТА_НА_JS = r"""
import { readFileSync } from "node:fs";
import { Bundle } from "ПУТЬ/js/src/build/bundle.mjs";
const пакет = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify(new Bundle(пакет).meta()));
"""


def _скрипт(tmp_path):
    ф = tmp_path / "мета.mjs"
    ф.write_text(_МЕТА_НА_JS.replace("ПУТЬ", str(ROOT / "libs")), encoding="utf-8")
    return ф


def _питон(пример):
    г = subprocess.run([sys.executable, "-c", _ПАКЕТ_И_МЕТА, str(ROOT), пример],
                       capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert г.returncode == 0, г.stderr
    return json.loads(г.stdout)


def _джаваскрипт(tmp_path, пакет):
    ф = tmp_path / "пакет.json"
    ф.write_text(json.dumps(пакет, ensure_ascii=False), encoding="utf-8")
    г = subprocess.run(["node", str(_скрипт(tmp_path)), str(ф)],
                       capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    return г


@pytest.mark.parametrize("пример", ПРИМЕРЫ)
def test_both_readers_derive_the_same_meta(tmp_path, пример):
    свод = _питон(пример)
    г = _джаваскрипт(tmp_path, свод["пакет"])
    assert г.returncode == 0, г.stderr
    ровно = lambda x: json.dumps(x, ensure_ascii=False, sort_keys=True, default=str)
    assert ровно(json.loads(г.stdout)) == ровно(свод["meta"])


#: Каждая поломка -- одна, и названа тем, что она ломает. Оба читателя обязаны
#: отказать, и обязаны сказать про одно и то же.
ПОЛОМКИ = {
    "нет раздела": (lambda п: п.pop("views"), "views"),
    "нет посева": (lambda п: п.pop("seeds"), "seeds"),
    "нет логики": (lambda п: п.pop("logic"), "logic"),
    "чужая версия": (lambda п: п.update(oneframework=999), "999"),
    "неизвестный тип поля": (
        lambda п: п["models"][0]["fields"].append(
            {"name": "странное", "ftype": "нетакого"}), "нетакого"),
    "вид без модели": (
        lambda п: п["views"][0].update(model="НетТакойМодели"), "НетТакойМодели"),
    "корня нет": (lambda п: п["app"].update(root="НетТакогоВида"), "НетТакогоВида"),
}


@pytest.mark.parametrize("поломка", sorted(ПОЛОМКИ))
def test_both_readers_refuse_the_same_broken_bundle(tmp_path, поломка):
    правка, слово = ПОЛОМКИ[поломка]
    пакет = json.loads(json.dumps(_питон("todo")["пакет"]))
    правка(пакет)
    ф = tmp_path / "битый.json"
    ф.write_text(json.dumps(пакет, ensure_ascii=False), encoding="utf-8")

    питон = subprocess.run(
        [sys.executable, "-c",
         "import json, sys; from oneframework.declaration import Bundle;"
         " Bundle(json.load(open(sys.argv[1])))", str(ф)],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT),
        env={**os.environ, "PYTHONPATH": str(ROOT)})
    на_js = subprocess.run(["node", str(_скрипт(tmp_path)), str(ф)],
                           capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))

    assert питон.returncode != 0, f"питон принял битый пакет: {поломка}"
    assert на_js.returncode != 0, f"JavaScript принял битый пакет: {поломка}"
    assert слово in питон.stderr, питон.stderr
    assert слово in на_js.stderr, на_js.stderr


def test_both_readers_name_a_record_by_its_name_field(tmp_path):
    """Запись зовут полем ``name``, даже если строка перед ним другая.

    В примерах ``name`` и так стоит первой строкой, поэтому запасное правило
    («первая строка») даёт тот же ответ, и подмена одного другим остаётся
    незаметной -- замерено: снятое правило оставляет сверку зелёной. Здесь
    поля расставлены так, что ответы расходятся.

    Цена ошибки видна на устройстве: запись подписывается не тем полем, и в
    списке вместо имени стоит описание.
    """
    свод = _питон("todo")
    пакет = json.loads(json.dumps(свод["пакет"]))
    модель = пакет["models"][0]
    строка = next(f for f in модель["fields"] if f["ftype"] == "string")
    # «title» встаёт перед «name»: запасное правило выбрало бы его.
    модель["fields"] = (
        [{**строка, "name": "title"}]
        + [{**строка, "name": "name"}]
        + [f for f in модель["fields"] if f is not строка]
    )
    ф = tmp_path / "пакет.json"
    ф.write_text(json.dumps(пакет, ensure_ascii=False), encoding="utf-8")

    на_js = subprocess.run(["node", str(_скрипт(tmp_path)), str(ф)],
                           capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert на_js.returncode == 0, на_js.stderr
    питон = subprocess.run(
        [sys.executable, "-c",
         "import json, sys; from oneframework.declaration import Bundle;"
         " print(json.dumps(Bundle(json.load(open(sys.argv[1]))).meta(),"
         " ensure_ascii=False, default=str))", str(ф)],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT),
        env={**os.environ, "PYTHONPATH": str(ROOT)})
    assert питон.returncode == 0, питон.stderr

    свой = json.loads(питон.stdout)["models"][модель["name"]]["display_field"]
    чужой = json.loads(на_js.stdout)["models"][модель["name"]]["display_field"]
    assert свой == "name", свой
    assert чужой == свой

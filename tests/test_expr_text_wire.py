"""Выражение строкой доезжает от привязки до выложенного документа.

Узел `{"text": "..."}` живёт только на проводе: привязке дешевле передать
строку, чем встраивать в свой язык четырнадцать родов узлов. Разворачивает его
сборка, и в базу едет то же дерево, что и от питоновского приложения.

Проверяется вся дорога, а не разборщик: разборщик сверен с питоновским DSL
отдельно (`test_expr_text.py`). Здесь -- что текст вправду разворачивается по
пути и что неразобранное до устройства не доезжает.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
pytestmark = needs_node

_ПЛАН_НА_JS = r"""
import { readFileSync } from "node:fs";
import { Bundle } from "ПУТЬ/js/src/build/bundle.mjs";
import { buildPlan } from "ПУТЬ/js/src/build/plan.mjs";
const пакет = new Bundle(JSON.parse(readFileSync(process.argv[2], "utf8")));
process.stdout.write(JSON.stringify(buildPlan(пакет.doc)));
"""


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


def _план(tmp_path, пакет, имя="пакет"):
    ф = tmp_path / f"{имя}.json"
    ф.write_text(json.dumps(пакет, ensure_ascii=False), encoding="utf-8")
    с = tmp_path / f"{имя}.mjs"
    с.write_text(_ПЛАН_НА_JS.replace("ПУТЬ", str(ROOT / "libs")), encoding="utf-8")
    return subprocess.run(["node", str(с), str(ф)],
                          capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))


def _вид(план, имя):
    return next(д[2] for д in план["defs"] if д[0] == "view" and д[1] == имя)


def test_a_text_expression_becomes_a_tree_on_the_way(tmp_path):
    """Строка разворачивается ровно в то дерево, что положил бы питон."""
    пакет = _пакет_todo()
    # Первый вид, у которого поле лежит прямо в детях: у иных они внутри строк
    # и групп, и добираться туда проверке не за чем.
    номер, поле = next((i, n) for i, в in enumerate(пакет["views"])
                       for n in в["children"] if n.get("type") == "field")
    вид = пакет["views"][номер]
    место = вид["children"].index(поле)

    деревом = json.loads(json.dumps(пакет))
    деревом["views"][номер]["children"][место]["visible"] = {
        "op": ">", "l": {"r": "sequence"}, "r": 3}
    строкой = json.loads(json.dumps(пакет))
    строкой["views"][номер]["children"][место]["visible"] = {
        "text": "record.sequence > 3"}

    a = _план(tmp_path, деревом, "деревом")
    b = _план(tmp_path, строкой, "строкой")
    assert a.returncode == 0, a.stderr
    assert b.returncode == 0, b.stderr
    ровно = lambda x: json.dumps(x, ensure_ascii=False, sort_keys=True)
    assert ровно(_вид(json.loads(b.stdout), вид["name"])) == \
        ровно(_вид(json.loads(a.stdout), вид["name"]))


def test_no_text_node_survives_into_the_plan(tmp_path):
    """В выложенном документе строк быть не должно -- рантайм их не разбирает.

    Пропусти сборка неразвёрнутый узел, устройство получило бы условие, которое
    не умеет читать: экран нарисовался бы без поля, и связать пустоту со
    строкой было бы нечем.
    """
    пакет = _пакет_todo()
    пакет["views"][0]["children"][0]["visible"] = {"text": "record.completed"}
    г = _план(tmp_path, пакет)
    assert г.returncode == 0, г.stderr
    assert '"text":' not in json.dumps(
        [д for д in json.loads(г.stdout)["defs"] if д[0] == "view"],
        ensure_ascii=False).replace('"text":"', '"ЗНАЧЕНИЕ":"')  # поля с именем text -- не узлы


def test_a_broken_text_stops_the_build(tmp_path):
    """Неразобранное обязано остановить сборку, а не доехать молча."""
    пакет = _пакет_todo()
    пакет["views"][0]["children"][0]["visible"] = {"text": "record.n @@ 3"}
    г = _план(tmp_path, пакет)
    assert г.returncode != 0, г.stdout
    assert "непонятный знак" in г.stderr, г.stderr


def test_a_text_node_is_not_confused_with_a_text_widget(tmp_path):
    """Узел вида «текст» и действие `text` -- не выражения, их трогать нельзя.

    Признак разворачивания -- ровно один ключ `text`. Совпадения по одному
    имени ключа хватило бы, чтобы развернуть не то.
    """
    пакет = _пакет_todo()
    вид = пакет["views"][0]
    вид["children"].append({"type": "text", "id": "V.t1", "value": "просто слова"})
    г = _план(tmp_path, пакет)
    assert г.returncode == 0, г.stderr
    узлы = _вид(json.loads(г.stdout), вид["name"])["children"]
    текст = next(n for n in узлы if n.get("type") == "text")
    assert текст["value"] == "просто слова"


def test_a_node_that_merely_has_a_text_key_is_left_alone(tmp_path):
    """Разворачивается объект, у которого `text` -- **единственный** ключ.

    Сегодня ключа `text` не несёт ни один узел договора, и хватило бы вхождения.
    Строго -- ради завтрашнего: заведут узел вида с подписью в ключе `text`, и
    вхождение развернуло бы подпись в выражение. Проверяется тем же -- узлом с
    подписью рядом с другими ключами.
    """
    пакет = _пакет_todo()
    вид = пакет["views"][0]
    вид["children"].append({"type": "text", "id": "V.t9", "text": "record.done"})
    г = _план(tmp_path, пакет)
    assert г.returncode == 0, г.stderr
    узлы = _вид(json.loads(г.stdout), вид["name"])["children"]
    свой = next(n for n in узлы if n.get("id") == "V.t9")
    assert свой["text"] == "record.done", "подпись развернули в выражение"


def test_a_text_expression_that_is_not_a_string_is_refused(tmp_path):
    """Ключ один, а значение не строка -- отказ, а не молчаливый пропуск.

    Пропущенное доедет до устройства, где его никто не прочтёт: условие не
    сработает, поле не нарисуется, и связать это с записью будет нечем.
    """
    пакет = _пакет_todo()
    пакет["views"][0]["children"][0]["visible"] = {"text": {"r": "done"}}
    г = _план(tmp_path, пакет)
    assert г.returncode != 0, г.stdout
    assert "записывается строкой" in г.stderr, г.stderr


def test_a_text_expression_inside_an_action_is_expanded_too(tmp_path):
    """Правило и правка объявленного действия -- тоже выражения.

    Их разворот отдельной строкой в коде, и без этой проверки снятая строка
    оставляла сюиту зелёной: у примеров объявленных действий нет.
    """
    пакет = _пакет_todo()
    пакет["logic"] = [{"actions": [{
        "name": "TodoLine.поднять",
        "label": "поднять",
        "model": "TodoLine",
        "args": [{"name": "ids", "type": "ids"}],
        "returns": [{"name": "records", "type": "json"}],
        "rule": {"text": "record.sequence > 3"},
        "write": {"sequence": {"text": "record.sequence + 10"}},
    }]}]
    г = _план(tmp_path, пакет)
    assert г.returncode == 0, г.stderr
    действие = next(д[2] for д in json.loads(г.stdout)["defs"] if д[0] == "action")
    assert действие["rule"] == {"op": ">", "l": {"r": "sequence"}, "r": 3}, действие["rule"]
    assert действие["write"]["sequence"] == {
        "op": "+", "args": [{"r": "sequence"}, 10]}, действие["write"]


def test_a_text_expression_inside_a_model_is_expanded_too(tmp_path):
    """Вычисляемое поле модели -- тоже выражение, и тоже строкой.

    Разворот моделей -- отдельная строка в коде, и без этой проверки снятая
    строка оставляла сюиту зелёной: у примеров вычисляемых полей строкой нет.
    """
    пакет = _пакет_todo()
    модель = пакет["models"][0]
    модель["fields"].append({
        "name": "громко", "ftype": "string", "label": "Громко",
        "compute": {"text": "upper(record.name)"},
    })
    г = _план(tmp_path, пакет)
    assert г.returncode == 0, г.stderr
    свой = next(д[2] for д in json.loads(г.stdout)["defs"]
                if д[0] == "model" and д[1] == модель["name"])
    поле = next(f for f in свой["fields"] if f["name"] == "громко")
    assert поле["compute"] == {"op": "upper", "args": [{"r": "name"}]}, поле["compute"]

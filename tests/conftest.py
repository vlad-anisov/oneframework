import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "examples" / "todo"))

@pytest.fixture()
def todo_app():
    """The exact acceptance-criterion app from examples/todo/app.py."""
    import app as todo_module

    return todo_module


#: Фикстура ``db`` жила здесь и отдавала питоновскую базу. Питоновского
#: писателя SQLite больше нет: базу пишет сборщик на JS, читает рантайм оттуда
#: же. Кому нужна база в проверке -- тот поднимает хост (`jsrt.Рантайм`) либо
#: собирает файл (`assets.write_app_db`).




#: Фикстура ``runtime`` жила здесь и поднимала питоновский рантайм. Его больше
#: нет; кому нужен исполненный кадр, тот поднимает хост -- ``jsrt.Рантайм``,
#: и делает это у себя в файле, потому что приложение у каждого своё.


#: Половина рантайма переехала на JS, и проверять её можно только запустив.
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node недоступен")


def run_node(tmp_path, script, payload):
    """Выполнить ES-модуль, отдав ему JSON, и вернуть напечатанное.

    Модуль импортируется по абсолютному пути прямо из ``web/src`` -- сборки в
    проверке быть не должно, иначе сверяется не тот код, который поедет.
    """
    data = tmp_path / "payload.json"
    data.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    runner = tmp_path / "run.mjs"
    runner.write_text(script, encoding="utf-8")

    done = subprocess.run(
        ["node", str(runner), str(data)],
        capture_output=True, text=True, encoding="utf-8",
    )
    assert done.returncode == 0, done.stderr
    return done.stdout


def flat(nodes):
    """Depth-first walk of a render subtree (Row is a layout node)."""
    for node in nodes:
        yield node
        if node.get("children"):
            yield from flat(node["children"])


def the_list(runtime):
    tree = runtime.stack[-1].tree
    return next(c for c in tree["children"] if c["type"] == "list")


def bind_row(node, row):
    """Одна строка списка так, как её собирает рендерер.

    Пара к ``bindRow`` в ``web/src/react/nodes.jsx``: на проводе едет описание
    строки (``list.row``) и вектор значений на запись (``list.rows[i].v``), а
    узлы с живыми значениями существуют только там, где рисуют. Тест, который
    спрашивает про нарисованную строку, обязан спрашивать то же самое.
    """
    doc = node["row"]
    values = row["v"]

    def bind(n):
        out = dict(n)
        slots = out.pop("bind", None)
        if out.get("children") is not None:
            out["children"] = [bind(c) for c in out["children"]]
        if slots:
            for key, index in slots.items():
                out[key] = values[index]
        if out.get("type") == "field":
            if out.get("scope") == "record":
                out["record_id"] = row["id"]
                if out.get("ftype") in ("many2one", "one2one"):
                    out["related"] = next(
                        (c for c in out.get("choices") or () if c["id"] == out.get("value")),
                        None,
                    )
        elif out.get("type") == "button":
            out["context"] = {**out["context"], "record_id": row["id"]}
        return out

    entry = {
        "id": row["id"],
        "openable": doc["openable"],
        "children": [bind(c) for c in doc["children"]],
    }
    if doc.get("cells"):
        entry["cells"] = [bind(c) for c in doc["cells"]]
    return entry


def bound_rows(node):
    return [bind_row(node, row) for row in node.get("rows") or ()]


def titles(runtime):
    node = the_list(runtime)
    return [
        next(c for c in flat(row["children"]) if c.get("name") == "text")["value"]
        for row in bound_rows(node)
    ]


#: Спрашивать про Kotlin надо у **ядра**: там живёт единственная реализация
#: поиска компилятора и кэша TeaVM (`src/build/`). Питоновские
#: Питоновские `cli/kotlin_app.py` и `cli/teavm.py` удалены 21.08.2026: под
#: конец они держались только ради этих двух вопросов -- и были второй копией
#: поиска, которая один раз уже разошлась с настоящей (раскладка Homebrew) и
#: промахивалась молча.
_ЯДРО_KOTLIN = ROOT / "src" / "build" / "kotlin.mjs"
_ЯДРО_TEAVM = ROOT / "src" / "build" / "teavm.mjs"
_ОСНАСТКА = {}


def _спросить_ядро():
    """Что ядро знает про Kotlin на этой машине. Спрашивается один раз.

    Один раз потому, что ответ не меняется в пределах прогона, а запуск node
    стоит десятые доли секунды на каждый файл проверок.
    """
    if "ответ" not in _ОСНАСТКА:
        скрипт = (
            "import { kotlinCompiler, home } from " + json.dumps(str(_ЯДРО_TEAVM)) + ";\n"
            "let есть = null;\n"
            "try { есть = kotlinCompiler(); } catch { есть = null; }\n"
            'process.stdout.write(JSON.stringify({ compiler: есть, home: home() }));'
        )
        готово = subprocess.run(
            [shutil.which("node") or "node", "--input-type=module", "-e", скрипт],
            capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
        _ОСНАСТКА["ответ"] = (json.loads(готово.stdout) if готово.returncode == 0
                              else {"compiler": None, "home": None})
    return _ОСНАСТКА["ответ"]


def kotlin_ready() -> bool:
    """Есть ли на машине компилятор Kotlin.

    Без него котлиновская половина сюиты пропускается. Долгое время его не
    было ни на одной машине, где сюита гонялась, и в этой тишине жила ошибка
    поиска `kotlin-stdlib.jar` -- приложение на Kotlin не собиралось на обычной
    установке Homebrew, и сказать об этом было некому.
    """
    return _спросить_ядро()["compiler"] is not None


def teavm_home() -> str:
    """Где ядро держит артефакты TeaVM."""
    return _спросить_ядро()["home"]


needs_kotlin = pytest.mark.skipif(not kotlin_ready(), reason="компилятора Kotlin нет")


def план(пакет):
    """План выкладки -- у **ядра**, единственного, кто его строит.

    Питоновская копия (`oneframework/cli/plan.py`) удалена 21.08.2026: правило
    жило в двух местах и держалось сверкой, а сверять стало нечего, когда на
    ядро перешла и сборка, и `inspect`. Здесь остался помощник для проверок --
    перевод, а не вторая реализация.

    Принимает пакет объявления: либо `Bundle`, либо его документ.
    """
    доc = getattr(пакет, "doc", пакет)
    скрипт = (
        "import { readFileSync } from 'node:fs';\n"
        "import { buildPlan } from " + json.dumps(str(
            ROOT / "src" / "build" / "plan.mjs")) + ";\n"
        "process.stdout.write(JSON.stringify("
        "buildPlan(JSON.parse(readFileSync(process.argv[1], 'utf8')))));"
    )
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                     encoding="utf-8") as ф:
        json.dump(доc, ф, ensure_ascii=False, default=str)
        путь = ф.name
    готово = subprocess.run(
        [shutil.which("node") or "node", "--input-type=module", "-e", скрипт, путь],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    if готово.returncode != 0:
        raise ОтказЯдра(готово.stderr.strip())
    return json.loads(готово.stdout)


class ОтказЯдра(RuntimeError):
    """Ядро отказалось строить план. Слова его, не наши."""

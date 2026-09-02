"""Одно приложение, три языка, одни отпечатки.

Это главный тест обещания «библиотека на каждом языке». Обещание можно было бы
проверять на глаз -- собрать три приложения и посмотреть, похожи ли экраны, --
но похожесть ничего не доказывает: разойтись они могут в подписи поля,
в порядке колонок, в имени таблицы, и заметить это можно будет только тогда,
когда обмен сочтёт два одинаковых приложения разными.

Поэтому проверяется не похожесть, а **отпечаток**: sha256 канонического JSON
каждого документа. Совпал -- значит документы совпали побайтово, и никакого
«почти» тут нет.

Раздельно проверяется, что тест умеет падать: сломанная копия таблицы типов
обязана его уронить. Тест, который не падает никогда, не проверяет ничего.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import needs_kotlin, needs_node

from oneframework.declaration import declare
from oneframework.protocol import TABLE_PATH

ROOT = Path(__file__).resolve().parents[1]
СБОРЩИК_TEAVM = ROOT / "libs" / "js" / "src" / "build" / "teavm.mjs"
PYTHON_APP = ROOT / "examples" / "notes-python" / "app.py"
JS_APP = ROOT / "examples" / "notes-js" / "app.mjs"
KOTLIN_APP = ROOT / "examples" / "notes-kotlin" / "App.kt"

#: Второе приложение тройки, и оно не пример, а **образец**: тройка `notes-*`
#: задевает четыре рода узлов из семнадцати, и всё остальное у двух привязок из
#: трёх было не сверено ни с чем. Этот задевает каждый.
PARITY_PY = ROOT / "tests" / "fixtures" / "parity_app.py"
PARITY_JS = ROOT / "tests" / "fixtures" / "parity_app.mjs"
PARITY_KT = ROOT / "tests" / "fixtures" / "ParityApp.kt"

#: Копии таблицы типов, разъехавшиеся с образцом, -- первая причина, по которой
#: языки могли бы разойтись молча.
#:
#: У JavaScript это тот же JSON. У Kotlin -- **исходник**: ресурс рядом с
#: классами читает только JVM, а библиотека объявления собирается ещё и под
#: WebAssembly, где никакого classpath нет.
VENDORED = [ROOT / "libs" / "js" / "field-types.json"]


def fingerprints(bundle):
    """Отпечаток каждого документа пакета: типы, модели, виды.

    Раздел `app` намеренно не входит: у трёх приложений разные названия и цвет
    -- этим их и различают на устройстве. Одинаковым обязано быть то, из чего
    приложение состоит, а не то, как оно подписано.
    """
    #: Считает отпечатки та сторона, что считает их на устройстве: питоновская
    #: копия канонической записи удалена 21.08.2026, и сравнивать языки её
    #: отпечатками значило бы сравнивать не тем, чем различают на самом деле.
    import json as _json
    import subprocess as _subprocess

    names = (["types"]
             + [m["name"] for m in bundle["models"]]
             + [v["name"] for v in bundle["views"]])
    docs = [bundle["types"]] + bundle["models"] + bundle["views"]
    готово = _subprocess.run(
        ["node", str(ROOT / "tests" / "parity" / "canon_driver.mjs")],
        input=_json.dumps({"docs": docs, "numbers": [], "probes": {}}, ensure_ascii=False),
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert готово.returncode == 0, готово.stderr
    ответы = _json.loads(готово.stdout)["docs"]
    for о in ответы:
        assert "error" not in о, о["error"]
    return dict(zip(names, [о["ok"]["fp"] for о in ответы]))


def python_bundle():
    """Отдельным процессом, как и остальные два.

    Не из вежливости к симметрии: импорт приложения кладёт его в
    ``sys.modules`` под именем ``app``, и следующий тест, открывающий другое
    ``app.py``, получил бы это. Один раз уже получил -- тридцать одна ошибка
    в тестах, не имеющих к языкам никакого отношения.
    """
    out = subprocess.run(
        [sys.executable, "-m", "oneframework.cli.main", "declare", str(PYTHON_APP)],
        capture_output=True, text=True, cwd=str(ROOT))
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def javascript_bundle():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node на этой машине нет")
    cli = ROOT / "libs" / "js" / "bin" / "oneframework.mjs"
    out = subprocess.run([node, str(cli), "declare", str(JS_APP)],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def kotlin_bundle():
    from conftest import kotlin_ready as спросить

    if not спросить():
        pytest.skip("компилятора Kotlin нет: KOTLIN_HOME не указан")
    # Печатает пакет **ядро** (`libs/js/src/build/kotlin.mjs`): питоновской
    # привязки Kotlin больше нет. Дорога та же, которой ходит сборка.
    from oneframework.cli.sources import from_kotlin

    return from_kotlin(KOTLIN_APP).doc


def test_vendored_type_tables_match_the_protocol():
    """Копия таблицы у языка обязана совпадать с образцом.

    Отдельным тестом, потому что расхождение здесь -- причина, а расхождение
    отпечатков -- следствие. Причину лучше называть по имени.
    """
    образец = TABLE_PATH.read_text(encoding="utf-8")
    for копия in VENDORED:
        assert копия.read_text(encoding="utf-8") == образец, (
            f"{копия.relative_to(ROOT)} разошлась с protocol/field-types.json. "
            "Пересоберите: python3 -m oneframework.protocol, затем скопируйте."
        )


def test_kotlin_type_table_source_matches_the_protocol():
    """Таблица типов у Kotlin едет исходником -- он тоже обязан совпасть."""
    from oneframework.cli import kotlin_table

    assert kotlin_table.OUT.read_text(encoding="utf-8") == kotlin_table.source(), (
        "libs/kotlin/.../FieldTypes.kt отстал от protocol/field-types.json. "
        "Пересоберите: python3 -m oneframework.cli.kotlin_table"
    )


def test_javascript_declares_the_same_documents_as_python():
    assert fingerprints(python_bundle()) == fingerprints(javascript_bundle())


def test_kotlin_declares_the_same_documents_as_python():
    assert fingerprints(python_bundle()) == fingerprints(kotlin_bundle())


def _богатый_питон():
    import sys

    if str(PARITY_PY.parent) not in sys.path:
        sys.path.insert(0, str(PARITY_PY.parent))
    import parity_app

    from oneframework.model import defs

    пакет = declare(parity_app.app)
    assert not getattr(defs, "SKIPPED", {}), defs.SKIPPED
    return пакет


def _богатый(язык, путь):
    from oneframework.cli.sources import from_javascript, from_kotlin

    return (from_javascript if язык == "js" else from_kotlin)(путь).doc


@needs_node
def test_the_rich_app_is_the_same_on_javascript():
    """Богатый образец, а не тройка `notes-*`.

    Тройка задевает четыре рода узлов из семнадцати: модель, строку, карточку,
    кнопку. Всё остальное -- вкладки, повторитель, поиск, счётчики, меню,
    складной блок -- у двух привязок из трёх не сверялось ни с чем и могло
    разойтись молча. Первый прогон этой сверки нашёл четыре расхождения.
    """
    assert fingerprints(_богатый_питон()) == fingerprints(_богатый("js", PARITY_JS))


@needs_kotlin
def test_the_rich_app_is_the_same_on_kotlin():
    """То же для Kotlin -- и это половина, которой у него не было вовсе.

    До 02.09.2026 привязка Kotlin объявляла три рода узлов из семнадцати, и
    сверять её на богатом приложении было нечем: его нельзя было написать.
    """
    assert fingerprints(_богатый_питон()) == fingerprints(_богатый("kt", PARITY_KT))


def test_the_check_can_fail(tmp_path, monkeypatch):
    """Сломать одну сторону -- тест обязан это заметить.

    Без этой проверки предыдущие две доказывают только то, что они не падают.
    Здесь у питоновского пакета меняется одна подпись поля, и совпадение
    обязано пропасть.
    """
    пакет = python_bundle()
    испорчен = json.loads(json.dumps(пакет))
    испорчен["models"][0]["fields"][0]["label"] = "не та подпись"
    assert fingerprints(пакет) != fingerprints(испорчен)


def test_three_languages_declare_the_same_logic_shape():
    """Логика у трёх языков разная по телу, но одинаковая по форме.

    Тело и не может совпасть -- это три разных языка. Совпасть обязано
    объявление вокруг него: имя действия, модель, что ему позволено записать.
    Разойдись оно -- и кнопка в одном приложении звала бы не то, что в другом.
    """
    пакеты = {"python": python_bundle(), "javascript": javascript_bundle(),
              "kotlin": kotlin_bundle()}
    форма = {}
    for язык, пакет in пакеты.items():
        действия = [д for з in пакет["logic"] for д in з["actions"]]
        assert len(действия) == 1, f"{язык}: ожидалось одно действие"
        д = действия[0]
        форма[язык] = json.dumps(
            [д["name"], д["model"], д["args"], д["returns"], sorted(_writes(д))],
            ensure_ascii=False, sort_keys=True)
    assert len(set(форма.values())) == 1, форма


def _writes(действие):
    """Что действию позволено записать -- где бы тело ни лежало."""
    for ключ in ("python", "js", "wasm"):
        if ключ in действие:
            return действие[ключ]["writes"]
    return []


# --------------------------------------------------------------------------
# одинаковость поведения, а не только объявления
# --------------------------------------------------------------------------
#: Кадр, на котором гоняются все три реализации. Один и тот же.
ПРОБА = {"records": [{"id": "1", "title": "Полить  цветами\tсегодня",
                      "details": "", "done": False}]}


def _run_python(bundle):
    """Исполнить питоновское тело так, как это сделает Pyodide."""
    действие = [д for з in bundle["logic"] for д in з["actions"]][0]
    область = {}
    exec(compile(действие["python"]["source"], "<проба>", "exec"), область)  # noqa: S102
    return область[действие["python"]["entry"]](ПРОБА)


def _run_javascript(bundle):
    """Исполнить тело на JS так, как это сделает webview."""
    действие = [д for з in bundle["logic"] for д in з["actions"]][0]
    скрипт = (
        "const fn = new Function('module','exports', "
        + json.dumps(action_source(действие))
        + ");\nconst m = {exports:{}}; fn.call(m, m, m.exports);\n"
        + "console.log(JSON.stringify(m.exports."
        + действие["js"]["entry"] + "(" + json.dumps(ПРОБА) + ")));"
    )
    out = subprocess.run([shutil.which("node"), "-e", скрипт],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def action_source(действие):
    return '"use strict";\n' + действие["js"]["source"]


def _run_kotlin(bundle):
    """Позвать **скомпилированный** модуль -- ровно то, что поедет на устройство.

    Собирает его ядро на JavaScript: питоновской сборки модуля больше нет.
    """
    действие = [д for з in bundle["logic"] for д in з["actions"]][0]
    имя = действие["wasm"]["module"]
    куда = ROOT / "web" / "public" / "wasm" / имя
    # Classpath -- из пакета, как у настоящей сборки: зависимости с Maven
    # приезжают ключом «maven», и брать их надо оттуда же, откуда берёт их
    # сборщик. Без них пример на Kotlin не компилируется вовсе -- он зовёт
    # `WordUtils` у commons-text, -- и тест краснел на всякой машине, где
    # kotlinc есть.
    сборщик = (
        'import { build, resolve } from ' + json.dumps(str(СБОРЩИК_TEAVM)) + ';\n'
        'const [источники, куда, имя, maven] = JSON.parse(process.argv[1]);\n'
        'build(источники, куда, имя, "oneframework.generated.EntryKt", resolve(maven));'
    )
    готово = subprocess.run(
        [shutil.which("node"), "--input-type=module", "-e", сборщик, "--",
         json.dumps([действие["wasm"]["sources"], str(куда), имя,
                     bundle["app"]["maven"]], ensure_ascii=False)],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert готово.returncode == 0, готово.stderr
    # Через ту же обвязку, что и на устройстве: проверять надо то, что едет.
    скрипт = (
        f"const rt = await import({json.dumps(str(куда / 'runtime.mjs'))});\n"
        f"const m = await rt.load({json.dumps(str(куда / (имя + '.wasm')))});\n"
        f"console.log(m.exports.Entry.{действие['wasm']['entry']}"
        f"({json.dumps(json.dumps(ПРОБА))}));"
    )
    out = subprocess.run([shutil.which("node"), "--input-type=module", "-e", скрипт],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_three_languages_answer_the_same_thing():
    """Три реализации на одном входе обязаны дать один ответ.

    Это то, чего не проверяли отпечатки: они сверяют **объявление**, а тело
    действия в объявление не входит -- у каждого языка оно своё. Три
    приложения могли (и однажды могли безнаказанно) считать разное, а README
    при этом обещал «тот же ответ».

    Kotlin проверяется **скомпилированным модулем**, а не исходником: на
    устройство едет он, и проверять надо то, что едет.
    """
    if shutil.which("node") is None:
        pytest.skip("node на этой машине нет")
    ответы = {
        "python": _run_python(python_bundle()),
        "javascript": _run_javascript(javascript_bundle()),
        "kotlin": _run_kotlin(kotlin_bundle()),
    }
    один = json.dumps(ответы["python"], ensure_ascii=False, sort_keys=True)
    for язык, ответ in ответы.items():
        assert json.dumps(ответ, ensure_ascii=False, sort_keys=True) == один, (
            f"{язык} посчитал иначе: {ответ}")
    # И заодно -- что посчитано именно то, что задумано, а не одинаковая пустота.
    assert ответы["python"]["records"][0]["details"] == "3 слов: Полить Цветами Сегодня"


def test_javascript_logic_can_use_an_npm_package():
    """Сторонняя библиотека с npm доезжает до устройства.

    До этого не доезжала никакая: на устройстве тело исполняет `new Function`,
    где нет ни `require`, ни `import`, -- и всё, что файл импортировал,
    оставалось на машине сборки. Теперь файл логики **упаковывается**: его
    зависимости складываются в тот же самодостаточный модуль.

    Проверяется та самая логика, что стоит в приложении: она зовёт `lodash`,
    и доказательством служит значение, которое без него не получилось бы, --
    заглавные по словам, расставленные библиотекой.
    """
    if shutil.which("node") is None:
        pytest.skip("node на этой машине нет")
    файл = ROOT / "examples" / "notes-js" / "logic" / "summary.js"
    скрипт = f"""
      const {{ action }} = await import({json.dumps(str(ROOT / 'libs/js/src/device.mjs'))});
      const a = action(new URL("file://{файл}"));
      a.bind({{ name: "Note", fields: new Map([["title", 1], ["details", 1]]) }}, "summary");
      const src = a.declaration().js.source;
      const f = new Function("module", "exports", '"use strict";\\n' + src);
      const m = {{ exports: {{}} }};
      f.call(m, m, m.exports);
      console.log(JSON.stringify(m.exports.__oneframework_entry(
          {{ records: [{{ id: "1", title: "полить цветами", details: "" }}] }})));
    """
    out = subprocess.run([shutil.which("node"), "--input-type=module", "-e", скрипт],
                         capture_output=True, text=True, cwd=str(ROOT))
    assert out.returncode == 0, out.stderr[-1500:]
    ответ = json.loads(out.stdout)["records"][0]["details"]
    assert ответ == "2 слов: Полить Цветами", ответ

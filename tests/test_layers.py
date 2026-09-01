"""Сборка не знает про питоновский DSL -- и не знает про питон вовсе.

Замысел раскола: ядро -- договор, сборка и рантайм -- отдельно, а привязка
языка только печатает пакет объявления. Пока сборка ввозит `ui.view` или
`model.fields`, «поставить ядро» и «поставить привязку Python» -- один и тот же
``pip install``, и человек, пишущий на Kotlin, всё равно тащит питоновский DSL.

Держать это соглашением нельзя. Один `from ..ui.view import ...`, поставленный
ради удобства, возвращает связь целиком, и заметить это глазами не выйдет:
сборка продолжит работать -- у того, у кого питон стоит.

``inspect`` из счёта исключён намеренно и по имени: он оснастка разработчика,
а не то, что нужно, чтобы собрать или запустить приложение. Дороги сборки он не
касается -- ниже это тоже проверено.
"""

from __future__ import annotations

import ast
import pathlib
from pathlib import Path

import pytest

from conftest import needs_node

КОРЕНЬ = Path(__file__).resolve().parents[1] / "oneframework"

#: Питоновский DSL: то, чем объявляют приложение на питоне.
DSL = {
    "model.expr", "model.fields", "model.meta", "model", "app", "device",
    "ui.nodes", "ui.view", "ui.screen", "ui.components", "modules",
}

#: Оснастка разработчика. Не ядро: чтобы собрать и запустить приложение, она
#: не нужна, и в отдельный репозиторий уедет вместе с привязкой.
ОСНАСТКА = {"cli/inspect.py"}

#: Языковые шаги сборки, которых в питоне больше быть не должно. Их писали
#: здесь, пока сборщик был питоновским; теперь они в ядре
#: (`src/build/`), и вернуться сюда не должны -- иначе «поставить
#: ядро» снова начнёт значить «поставить питон».
УШЛО_В_ЯДРО = {"cli/teavm.py", "cli/kotlin_app.py"}


def _ввозы(файл: Path):
    """Куда этот файл ходит внутри пакета -- относительными ввозами."""
    д = ast.parse(файл.read_text(encoding="utf-8"))
    return {(n.module or "") for n in ast.walk(д)
            if isinstance(n, ast.ImportFrom) and n.level}


def _файлы_сборки():
    for п in sorted((КОРЕНЬ / "cli").rglob("*.py")):
        if str(п.relative_to(КОРЕНЬ)) in ОСНАСТКА:
            continue
        yield п


def test_the_builder_never_imports_the_python_dsl():
    нити = {str(п.relative_to(КОРЕНЬ)): sorted(_ввозы(п) & DSL) for п in _файлы_сборки()}
    нити = {ф: ц for ф, ц in нити.items() if ц}
    assert not нити, (
        "сборка ввозит питоновский DSL: " + str(нити) +
        ". Дорога в сборку одна -- пакет объявления; всё, что нужно, обязано "
        "приезжать им, а не браться у питоновских объектов."
    )


def test_the_builder_does_not_need_the_developer_tooling():
    """Оснастка -- лист. Сборка её не зовёт, иначе она была бы ядром."""
    for п in _файлы_сборки():
        assert "inspect" not in {ц.split(".")[-1] for ц in _ввозы(п)}, п


def test_the_dsl_list_still_matches_the_tree():
    """Перечень DSL не должен молча устареть.

    Переименуют ``ui/view.py`` -- и проверка выше станет зелёной ни на чём:
    искомого имени в дереве просто не будет. Поэтому каждое имя из перечня
    обязано существовать.
    """
    отсутствуют = [и for и in DSL
                   if not (КОРЕНЬ / (и.replace(".", "/") + ".py")).exists()
                   and not (КОРЕНЬ / и.replace(".", "/") / "__init__.py").exists()]
    assert not отсутствуют, отсутствуют


def test_the_tooling_list_still_matches_the_tree():
    for и in ОСНАСТКА:
        assert (КОРЕНЬ / и).exists(), и


# --------------------------------------------------------------------------
# ядро на JavaScript
# --------------------------------------------------------------------------
#: Сборщик переехал на JavaScript 21.08.2026. Смысл переезда в одном: собрать
#: приложение можно, не ставя питон. Стоит одному `spawn("python3", ...)`
#: вернуться -- и смысл пропадёт, а заметить это будет негде: у того, кто это
#: напишет, питон стоит.
СБОРЩИК_JS = Path(__file__).resolve().parents[1] / "libs" / "js"
ДОРОГА_СБОРКИ = [
    "bin/oneframework.mjs",
    "src/build/cli.mjs",
    "src/build/web.mjs",
    "src/build/plan.mjs",
    "src/build/bundle.mjs",
    "src/build/assets.mjs",
    "src/build/teavm.mjs",
    "src/build/kotlin.mjs",
    "src/build-db.mjs",
]


def test_the_javascript_builder_never_runs_python():
    зовут = {}
    for имя in ДОРОГА_СБОРКИ:
        текст = (СБОРЩИК_JS / имя).read_text(encoding="utf-8")
        # Ищем запуск, а не слово: `python_packages` -- это раздел пакета, и
        # он к запуску питона отношения не имеет.
        for кусок in ("python3", "\"python\"", "'python'", "ONEFRAMEWORK_PYTHON"):
            if кусок in текст:
                зовут.setdefault(имя, []).append(кусок)
    assert not зовут, (
        f"сборщик на JavaScript зовёт питон: {зовут}. Тогда «поставить ядро» "
        "снова значит «поставить питон», и человек, пишущий на Kotlin, ставит "
        "его ни за чем."
    )


def test_the_build_path_files_all_exist():
    """Перечень выше не должен молча устареть вместе с переименованием."""
    нет = [и for и in ДОРОГА_СБОРКИ if not (СБОРЩИК_JS / и).exists()]
    assert not нет, нет


def test_the_javascript_core_is_self_contained():
    """Пакет ядра ввозит только своё и node -- ничего из `web/`.

    Это не чистота, а условие издания. `libs/js/package.json` объявляет пакет
    `oneframework` и везёт `index.mjs`, `src` и `bin`. Пока сборщик ввозил из
    `web/src`, изданный пакет был бы **сломан**: внутри репозитория пути
    разрешаются, у поставившего -- нет, и увидел бы это он, а не мы.
    Безголовый рантайм переехал в `src/` 21.08.2026 именно
    поэтому.

    Обход считает и `import()`: три исполнителя логики грузятся динамически, и
    обходчик, видящий только `from`, назвал их лишними -- они чуть не остались
    снаружи.
    """
    import re

    import re

    ВВОЗ = re.compile(r'(?:from|import)\s*\(?\s*["\']([^"\']+)["\']')
    свой = СБОРЩИК_JS.resolve()

    def обойти(старт):
        видели, очередь = set(), [старт]
        чужие = []
        while очередь:
            файл = pathlib.Path(очередь.pop()).resolve()
            if файл in видели or not файл.is_file():
                continue
            видели.add(файл)
            for куда in ВВОЗ.findall(файл.read_text(encoding="utf-8")):
                if куда.startswith("node:") or not куда.startswith("."):
                    continue      # пакет из node_modules -- он объявлен в package.json
                цель = (файл.parent / куда).resolve()
                найдено = next((п for п in (цель, pathlib.Path(f"{цель}.js"),
                                            pathlib.Path(f"{цель}.mjs"))
                                if п.is_file()), None)
                if найдено is None:
                    чужие.append(f"{файл.name}: {куда} -- такого файла нет")
                elif not str(найдено).startswith(str(свой)):
                    чужие.append(f"{файл.name}: {куда}")
                else:
                    очередь.append(найдено)
        return чужие

    чужие = []
    for имя in ДОРОГА_СБОРКИ:
        чужие += обойти(СБОРЩИК_JS / имя)
    assert not чужие, (
        f"пакет ядра ввозит из-за своих пределов: {sorted(set(чужие))}. "
        "Изданным такой пакет не соберётся: за пределы поставки пути не ведут."
    )


def test_the_language_specific_build_steps_did_not_come_back():
    """Сборка Kotlin и TeaVM живут в ядре, а не в питоновском пакете.

    Проверяется отсутствием файлов, потому что вернуть их проще всего целиком:
    кто-то скопирует старую версию из истории, и питон снова понадобится тому,
    кто пишет на Kotlin. Тесты при этом останутся зелёными -- у него-то питон
    стоит.
    """
    вернулись = [и for и in УШЛО_В_ЯДРО if (КОРЕНЬ / и).exists()]
    assert not вернулись, (
        f"эти шаги переехали в src/build/, а здесь снова есть: {вернулись}")


@needs_node
def test_the_package_works_assembled_the_way_npm_ships_it(tmp_path):
    """Собрать поставку по `files` и поднять из неё сборщик.

    Сильнее статической проверки выше: та смотрит на ввозы, эта -- на то, что
    доедет. Забудь `package.json` назвать каталог -- ввозы останутся честными,
    а у поставившего пакет не заведётся, и увидит это он, а не мы.

    Зависимости подсовываются ссылкой на корневые `node_modules`: их npm
    поставит сам по `dependencies`, и проверять надо не их, а свои файлы.
    """
    import json
    import os
    import shutil
    import subprocess

    объявление = json.loads((СБОРЩИК_JS / "package.json").read_text(encoding="utf-8"))
    поставка = tmp_path / "пакет"
    поставка.mkdir()
    for имя in объявление["files"]:
        откуда = СБОРЩИК_JS / имя
        if откуда.is_dir():
            shutil.copytree(откуда, поставка / имя)
        elif откуда.exists():
            shutil.copy2(откуда, поставка / имя)
    os.symlink((Path(__file__).resolve().parents[1] / "node_modules").resolve(),
               поставка / "node_modules")

    готово = subprocess.run(
        ["node", "-e", "import('./src/build/cli.mjs').then(() => process.exit(0))"],
        cwd=поставка, capture_output=True, text=True, encoding="utf-8")
    assert готово.returncode == 0, (
        "пакет ядра не поднимается из собственной поставки:\n" + готово.stderr)


#: Ядро -- договор, сборка и рантайм. Всё остальное в `libs/js` -- привязка на
#: JavaScript, и она уедет отдельным репозиторием.
ЯДРО_ВНУТРИ = ("src/", "src/build/", "src/build-db.mjs")


def test_the_core_imports_nothing_from_the_binding():
    """Ядро не смеет ввозить из привязки -- даже таблицу типов.

    Нашлось при первой же раскладке по репозиториям: `src/build/bundle.mjs`
    читал `../types.mjs` -- копию договора, лежащую рядом с библиотекой на
    JavaScript. Внутри одного дерева это работало; разложи их по
    репозиториям -- и сборщик не поднимется, потому что привязки рядом нет.

    Проверяется ввозами, а не раскладкой: раскладка меняется, правило -- нет.
    Ядро читает договор из `protocol/`, который лежит в нём же.
    """
    import re

    ВВОЗ = re.compile(r'from\s+["\']([^"\']+)["\']')
    свои = [п for п in (СБОРЩИК_JS / "src").rglob("*.mjs")
            if "/build/" in str(п) or п.name == "build-db.mjs"]
    свои += list((СБОРЩИК_JS / "src" / "core").rglob("*.js"))

    чужое = {}
    for п in свои:
        for куда in ВВОЗ.findall(п.read_text(encoding="utf-8")):
            if куда.startswith("node:") or not куда.startswith("."):
                continue
            цель = str((п.parent / куда).resolve())
            if not any(x in цель or цель.endswith("build-db.mjs") for x in ЯДРО_ВНУТРИ):
                чужое.setdefault(str(п.relative_to(СБОРЩИК_JS)), []).append(куда)
    assert not чужое, (
        f"ядро ввозит из привязки: {чужое}. Разложи их по репозиториям -- и "
        "ядро не поднимется: привязки рядом не будет.")

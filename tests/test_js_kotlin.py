"""Привязка Kotlin -- правилами, а не сверкой с питоном.

Пока привязка переезжала, здесь стояла двусторонняя сверка: `kotlin_app.declare`
на питоне против `src/build/kotlin.mjs`. Она свою работу сделала --
питоновской копии больше нет, -- и держалась ровно до тех пор, пока работу
напечатанного не стало проверять что-то другое.

Теперь проверяет `tests/e2e/notes-kotlin.spec.js`: приложение на Kotlin
собирается ядром при физически убранном каталоге `oneframework/`, и кнопка в
браузере считает сводку скомпилированным модулем.

Здесь остались правила, которые сквозной сюитой не увидеть: как читаются
зависимости, куда ложится переходник и что в нём обязано быть.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from conftest import needs_kotlin, needs_node

ROOT = Path(__file__).resolve().parents[1]
ПРИЛОЖЕНИЕ = ROOT / "examples" / "notes-kotlin" / "App.kt"


pytestmark = needs_node

_НА_JS = r"""
import { commonSources, declare, зависимости, пакетФайла, записатьEntry, записатьMain } from "ПУТЬ/js/src/build/kotlin.mjs";
import { readFileSync } from "node:fs";

const что = process.argv[2];
if (что === "declare") {
  process.stdout.write(JSON.stringify(declare(process.argv[3])));
} else if (что === "читать") {
  process.stdout.write(JSON.stringify({
    пакет: пакетФайла(process.argv[3]),
    зависимости: зависимости(process.argv[3]),
  }));
} else if (что === "переходник") {
  const файл = записатьEntry(process.argv[3], JSON.parse(process.argv[4]));
  process.stdout.write(JSON.stringify({ файл, текст: readFileSync(файл, "utf8") }));
} else if (что === "библиотека") {
  process.stdout.write(JSON.stringify(commonSources().length));
} else if (что === "main") {
  const файл = записатьMain(process.argv[3]);
  process.stdout.write(JSON.stringify({ файл, текст: readFileSync(файл, "utf8") }));
}
"""


def _скрипт(tmp_path):
    ф = tmp_path / "kotlin.mjs"
    ф.write_text(_НА_JS.replace("ПУТЬ", str(ROOT / "libs")), encoding="utf-8")
    return ф


def _node(tmp_path, *аргументы):
    return subprocess.run(["node", str(_скрипт(tmp_path)), *map(str, аргументы)],
                          capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))


def test_the_declaration_is_read_from_the_source_text(tmp_path):
    """Имя пакета и зависимости читаются текстом -- и это единственное место.

    Текстом потому, что иначе курица и яйцо: чтобы напечатать объявление, надо
    собрать приложение, а чтобы собрать -- знать зависимости, которые названы в
    объявлении. Не прочитай их сборка -- TeaVM сказал бы «Class ... was not
    found» уже про чужую беду.
    """
    г = _node(tmp_path, "читать", ПРИЛОЖЕНИЕ)
    assert г.returncode == 0, г.stderr
    прочитано = json.loads(г.stdout)
    assert прочитано["пакет"] == "notes"
    assert прочитано["зависимости"] == [
        "org.apache.commons:commons-text:1.12.0",
        "org.apache.commons:commons-lang3:3.14.0",
    ]


МУСОР = {
    "без пакета": ("val application = app()\n", "", []),
    "без зависимостей": ("package a.b\n\nval application = app()\n", "a.b", []),
    "пустой listOf": ("package a.b\n\nval x = app(dependencies = listOf())\n", "a.b", []),
}


@pytest.mark.parametrize("случай", sorted(МУСОР))
def test_a_source_without_them_reads_as_empty_not_as_an_error(tmp_path, случай):
    """Нет пакета или зависимостей -- пустая строка и пустой список.

    Это законные приложения, а не поломка: пакет в Kotlin необязателен, а
    зависимости бывают не нужны.
    """
    текст, пакет, зависимости = МУСОР[случай]
    файл = tmp_path / "App.kt"
    файл.write_text(текст, encoding="utf-8")
    г = _node(tmp_path, "читать", файл)
    assert г.returncode == 0, г.stderr
    прочитано = json.loads(г.stdout)
    assert прочитано["пакет"] == пакет
    assert прочитано["зависимости"] == зависимости


def test_the_generated_main_points_at_the_application(tmp_path):
    """Порождённый `main()` зовёт `emit` на объявленном приложении.

    В самом приложении его нет намеренно: он звал бы `emit`, а тот живёт в
    JVM-части библиотеки, и файл приложения перестал бы компилироваться под
    WebAssembly -- ровно то ограничение, ради снятия которого всё и сделано.
    """
    г = _node(tmp_path, "main", ПРИЛОЖЕНИЕ)
    assert г.returncode == 0, г.stderr
    вышло = json.loads(г.stdout)
    assert Path(вышло["файл"]).name == "GeneratedMain.kt"
    assert "fun main() { emit(notes.application) }" in вышло["текст"]
    assert вышло["текст"].startswith("package oneframework\n")


ДЕЙСТВИЕ = {
    "model": "Note",
    "wasm": {"entry": "summary", "module": "Note", "writes": ["details"]},
}


def test_the_generated_entry_is_named_so_teavm_finds_it(tmp_path):
    """Файл обязан зваться `Entry.kt`: его имя -- это имя класса.

    `Entry.kt` даёт `EntryKt`, которым сборка и зовёт модуль. Назови иначе --
    TeaVM не найдёт класса и уронит себя `NullPointerException`, ни слова не
    сказав о причине.
    """
    г = _node(tmp_path, "переходник", ПРИЛОЖЕНИЕ, json.dumps([ДЕЙСТВИЕ]))
    assert г.returncode == 0, г.stderr
    вышло = json.loads(г.stdout)
    assert Path(вышло["файл"]).name == "Entry.kt"


def test_the_generated_entry_carries_what_the_contract_needs(tmp_path):
    """Через границу ходит UTF-8 JSON: у стековой машины нет ни словарей, ни списков.

    Переходник разбирает кадр в набор записей и складывает обратно то, что
    изменилось; метод модели про это не знает и знать не должен.
    """
    г = _node(tmp_path, "переходник", ПРИЛОЖЕНИЕ, json.dumps([ДЕЙСТВИЕ]))
    assert г.returncode == 0, г.stderr
    текст = json.loads(г.stdout)["текст"]

    # Строкой целиком, а не вхождением: закомментированный `// @JSExport`
    # содержит то же слово, а модуль наружу не отдаёт ничего -- замерено.
    assert "    @JSExport" in текст.split("\n"), (
        "без экспорта модуль ничего не отдаст наружу")
    assert "fun summary(frame: String): String" in текст
    assert 'Records.fromJson(frame, listOf("details"))' in текст, (
        "список правок -- из объявления: он решает, что модулю позволено писать")
    assert "notes.Note.summary(records)" in текст, "зовётся метод модели с её пакетом"
    assert "records.changedJson()" in текст
    # Точка входа для TeaVM: он ищет `main(Array<String>)` и выбрасывает всё, до
    # чего от неё не дойти, -- вместе с `@JSExport`.
    assert "fun main(args: Array<String>)" in текст
    assert "if (args.size > 99)" in текст, (
        "условие держит `Entry` достижимым, но не даёт ему исполниться")


@needs_kotlin
def test_the_bundle_carries_the_sources_the_module_needs(tmp_path):
    """Kotlin знает свои действия, но не знает, где лежит библиотека.

    Вписывает её сборка -- вместе с порождённым переходником. Забудь она это,
    и модуль собрался бы без библиотеки объявления, то есть не собрался бы.
    """
    г = _node(tmp_path, "declare", ПРИЛОЖЕНИЕ)
    assert г.returncode == 0, г.stderr
    пакет = json.loads(г.stdout)
    действия = [д for з in пакет["logic"] for д in з.get("actions") or []]
    assert действия, "у примера есть действие -- иначе проверять нечего"
    источники = действия[0]["wasm"]["sources"]
    assert any(и.endswith("/Entry.kt") for и in источники), "нет переходника"
    assert any(и.endswith("/App.kt") for и in источники), "нет самого приложения"
    assert sum(1 for и in источники if "libs/kotlin" in и) >= 10, (
        f"общая библиотека не вписана целиком: {источники}")


def test_the_kotlin_library_is_found_beside_or_by_name(tmp_path):
    """Библиотека объявления живёт в своём репозитории, а нужна ядру.

    Тот же файл приложения собирается дважды -- под JVM и под WebAssembly, -- и
    оба раза вместе с ней. Пока всё лежало в одном дереве, путь был жёстким;
    разложи по репозиториям -- и сборка Kotlin перестаёт работать.
    """
    г = _node(tmp_path, "библиотека")
    assert г.returncode == 0, г.stderr
    assert json.loads(г.stdout) >= 10, "библиотека нашлась, но пуста"


def test_a_named_but_wrong_kotlin_library_is_refused(tmp_path):
    """Названный и негодный путь -- отказ, а не сборка чужой библиотекой.

    Тот же довод, что у ядра и у ключа подписи: собрать не тем значит выдать
    одно за другое, а заметить это негде -- модуль соберётся.
    """
    г = subprocess.run(
        ["node", str(_скрипт(tmp_path)), "библиотека"],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT),
        env={**os.environ, "ONEFRAMEWORK_KOTLIN": str(tmp_path / "нет-такой")})
    assert г.returncode != 0, г.stdout
    assert "нет-такой" in г.stderr and "main/kotlin" in г.stderr, г.stderr

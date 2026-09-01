"""Сборка модуля WebAssembly -- правилами, а не сверкой с питоном.

Пока сборщик переезжал, здесь стояла двусторонняя сверка: питоновский
`teavm.build` против `src/build/teavm.mjs`, байт в байт по `.wasm`. Она
свою работу сделала -- питоновской сборки модуля больше нет, -- а держалась она
ровно до тех пор, пока работу выданного не стало проверять что-то ещё.

Теперь проверяет: `tests/e2e/notes-kotlin.spec.js` жмёт кнопку в собранном
приложении и смотрит, посчиталась ли сводка. Сверка двух сборщиков без такой
проверки говорила бы лишь, что оба выдали одно; работает ли оно, из неё не
следовало.

Здесь остались правила, которые сквозной сюитой не увидеть: что считается
успехом, что входит в отпечаток кэша и как читается объявленная зависимость.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import needs_kotlin, needs_node, teavm_home

ROOT = Path(__file__).resolve().parents[1]


pytestmark = needs_node

_НА_JS = r"""
import { readdirSync, statSync } from "node:fs";
import {
  build, библиотека, classpath, home, resolve, удалась,
} from "ПУТЬ/js/src/build/teavm.mjs";

const что = process.argv[2];
if (что === "метки") {
  const [, , , источник, куда] = process.argv;
  build([источник], куда, "Проба", "oneframework.generated.EntryKt");
  // Вместе с отметками -- время правки модуля: по нему видно, была ли
  // пересборка. Отметка одна и та же и когда пересобрали, и когда взяли из
  // кэша, поэтому её одной мало.
  process.stdout.write(JSON.stringify({
    метки: readdirSync(куда).filter((и) => и.startsWith(".")).sort(),
    правлен: readdirSync(куда).filter((и) => и.endsWith(".wasm"))
      .map((и) => statSync(куда + "/" + и).mtimeMs),
  }));
} else if (что === "удалась") {
  process.stdout.write(JSON.stringify(
    JSON.parse(process.argv[3]).map(([код, вывод]) => удалась(код, вывод))));
} else if (что === "пути") {
  process.stdout.write(JSON.stringify({
    home: home(),
    stdlib: библиотека("kotlin-stdlib.jar"),
    classpath: classpath(home()),
  }));
} else if (что === "зависимости") {
  process.stdout.write(JSON.stringify(resolve(JSON.parse(process.argv[3]))));
}
"""


def _скрипт(tmp_path):
    ф = tmp_path / "teavm.mjs"
    ф.write_text(_НА_JS.replace("ПУТЬ", str(ROOT / "libs")), encoding="utf-8")
    return ф


def _node(tmp_path, *аргументы):
    return subprocess.run(["node", str(_скрипт(tmp_path)), *map(str, аргументы)],
                          capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))


#: Пары «код возврата, вывод» и то, что обязано получиться.
#: Средняя -- та самая ловушка: TeaVM пишет, что собрал с ошибками, и выходит
#: с нулём. Файл при этом есть и не работает.
ИСХОДЫ = [
    (0, "Output file built successfully", True),
    (0, "Output file built with errors", False),
    (0, "\nbuilt with errors\n", False),
    (1, "Output file built successfully", False),
    (1, "", False),
    (0, "", True),
]


def test_a_build_with_errors_is_a_failure(tmp_path):
    """Ноль на выходе -- ещё не успех, если TeaVM сказал «с ошибками».

    Правилом, а не настоящей сборкой: заставить TeaVM выдать такой вывод по
    заказу не выходит -- отражение и файловую систему он терпит. Один раз он
    уже отдал нерабочий модуль молча.
    """
    г = _node(tmp_path, "удалась",
              json.dumps([[к, в] for к, в, _ in ИСХОДЫ], ensure_ascii=False))
    assert г.returncode == 0, г.stderr
    assert json.loads(г.stdout) == [ждём for _, _, ждём in ИСХОДЫ]


МУСОР = ["commons-lang3", "org.apache.commons:commons-text",
         "org.apache.commons:commons-text:1.12.0:лишнее", ""]


@pytest.mark.parametrize("адрес", МУСОР)
def test_a_malformed_dependency_is_refused_by_name(tmp_path, адрес):
    """«группа:артефакт:версия» -- и никак иначе.

    Приняв огрызок молча, сборка полезла бы на Maven по бессмысленному адресу
    и отказала бы уже сетью, где причины не видно.
    """
    г = _node(tmp_path, "зависимости", json.dumps([адрес]))
    assert г.returncode != 0, г.stdout
    assert "группа:артефакт:версия" in г.stderr


def test_no_dependencies_means_no_network(tmp_path):
    """Пустой список -- пустой ответ, и ни одного обращения наружу."""
    г = _node(tmp_path, "зависимости", "[]")
    assert г.returncode == 0, г.stderr
    assert json.loads(г.stdout) == []


@needs_kotlin
def test_the_toolchain_is_found_where_it_actually_lives(tmp_path):
    """Компилятор и его библиотеки обязаны найтись у обеих раскладок.

    У распаковки с сайта jar'ы лежат в `<kotlinc>/lib`, у Homebrew --
    в `libexec/lib`, а в `bin` стоит обёртка. Считалось, что раскладка одна, и
    приложение на Kotlin не собиралось на обычной установке под macOS:
    компилировалось, а при запуске падало на `NoClassDefFoundError`. Заметить
    было нечем -- вся котлиновская половина сюиты пропускалась.
    """
    г = _node(tmp_path, "пути")
    assert г.returncode == 0, г.stderr
    пути = json.loads(г.stdout)
    assert Path(пути["stdlib"]).exists(), пути["stdlib"]
    assert пути["stdlib"].endswith("kotlin-stdlib.jar")
    # Кэш один на все запуски: скачивать девять артефактов заново на каждой
    # сборке незачем, а лежат они там, где их ищет и сюита.
    assert пути["home"] == teavm_home()
    assert пути["classpath"].count(teavm_home()) >= 9


#: У Kotlin имя файла становится именем класса: файл с функцией верхнего уровня
#: даёт класс по своему имени. Значит один и тот же текст под разными именами --
#: **разные** модули.
ВЕРХНИЙ_УРОВЕНЬ = (
    "package oneframework.generated\n"
    "\n"
    "fun сложить(a: Int, b: Int): Int = a + b\n"
    "\n"
    "object EntryKt {\n"
    "    @JvmStatic\n"
    "    fun main(args: Array<String>) {\n"
    "        println(сложить(2, 3))\n"
    "    }\n"
    "}\n"
)


@needs_kotlin
def test_the_cache_key_counts_the_file_name(tmp_path):
    """Переименование исходника обязано пересобрать модуль.

    Иначе кэш отдаст классы под старым именем, и запуск не найдёт главного --
    ровно это однажды и случилось. Отпечаток берётся с содержимого, и без
    имени два разных модуля выглядят для него одинаково.
    """
    куда = tmp_path / "модуль"
    метки = []
    for имя in ("Один.kt", "Два.kt"):
        источник = tmp_path / имя
        источник.write_text(ВЕРХНИЙ_УРОВЕНЬ, encoding="utf-8")
        г = _node(tmp_path, "метки", источник, куда)
        assert г.returncode == 0, г.stderr
        метки.append(json.loads(г.stdout)["метки"])
    assert метки[0] != метки[1], (
        f"та же отметка кэша под другим именем -- {метки[0]}")


@needs_kotlin
def test_the_same_sources_are_not_rebuilt(tmp_path):
    """Тот же исходник -- модуль не пересобирается.

    Смотрится **время правки** модуля, а не отметка: отметка одинакова и когда
    пересобрали, и когда взяли из кэша, и на ней снятый кэш остаётся
    незамеченным -- замерено. Пересборка Kotlin с TeaVM стоит секунды, и
    платить их на каждой сборке впустую нельзя.
    """
    куда = tmp_path / "модуль"
    источник = tmp_path / "Один.kt"
    источник.write_text(ВЕРХНИЙ_УРОВЕНЬ, encoding="utf-8")
    первый = json.loads(_node(tmp_path, "метки", источник, куда).stdout)
    второй = json.loads(_node(tmp_path, "метки", источник, куда).stdout)
    assert первый["метки"] == второй["метки"] and первый["метки"]
    assert первый["правлен"] and первый["правлен"] == второй["правлен"], (
        "модуль пересобран, хотя исходник тот же: "
        f"{первый['правлен']} -> {второй['правлен']}")

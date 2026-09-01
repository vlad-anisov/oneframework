"""Договор пакета объявления -- шва «язык -- сборка».

Форма пакета записана ``protocol/declaration.json``; там же сказано, чего
стоило её отсутствие, и здесь это второй раз не пересказывается -- разойдутся
два пересказа так же тихо, как разошлись бы два списка ключей.

Здесь форма прикладывается к **настоящим** пакетам всех трёх языков. Не к
образцу и не к питоновскому пакету трижды: пакет каждого языка печатает его
собственная библиотека, и разъехаться они могут только так -- каждая по-своему.

Виды второй раз не описываются: их форма лежит в ``protocol/document.json``, и
берётся оттуда. Словарь типов аргумента -- из ``protocol/logic.json``; оттуда
же закреплено, что второго списка ключей действия там больше не заведётся.

Отдельным тестом проверяется, что проверка **умеет** падать: пятнадцать
испорченных пакетов, каждый испорчен правдоподобно, и каждый обязан быть назван
вслух. По одному хотя бы на раздел -- иначе выпавший из проверки раздел
(так чуть не осталось с видами) не сказал бы о себе ничем.
"""

from __future__ import annotations

import functools
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from oneframework import declaration

ROOT = Path(__file__).resolve().parents[1]


def _protocol(name):
    return json.loads((ROOT / "protocol" / name).read_text(encoding="utf-8"))


SCHEMA = _protocol("declaration.json")
#: Форма документа вида. Здесь не повторяется -- берётся у своего договора.
VIEW_NODE = _protocol("document.json")["nodes"]["view"]
#: Свойства типов полей: раздел «types» пакета обязан совпасть с ними дословно.
FIELD_TYPES = _protocol("field-types.json")["types"]
#: Словарь типов аргумента и возврата -- у объявления логики свой договор.
ARG_TYPES = frozenset(_protocol("logic.json")["manifest"]["types"])

PYTHON_APPS = sorted((ROOT / "examples").glob("*/app.py"))
JS_APP = ROOT / "examples" / "notes-js" / "app.mjs"
KOTLIN_APP = ROOT / "examples" / "notes-kotlin" / "App.kt"


# --------------------------------------------------------------------------
# проверка
# --------------------------------------------------------------------------
def жалобы(пакет) -> list[str]:
    """Всё, чем пакет расходится с договором. Пусто -- значит сошёлся.

    Списком, а не первым отказом: пакет собирает чужая библиотека, и чинить
    его будет тот, кто её написал. Одна жалоба за прогон означала бы девять
    прогонов на девять расхождений.
    """
    out = _ключи("конверт", пакет, SCHEMA["envelope"])
    if пакет.get("oneframework") != SCHEMA["version"]:
        out.append(f"конверт: версия {пакет.get('oneframework')!r}, "
                   f"а договор описывает {SCHEMA['version']!r}")

    # Раздела нет -- об этом уже сказал конверт, второй жалобы о том же не надо.
    # А вот раздел, приехавший не словарём, -- отдельная беда, и её назовёт _ключи.
    сведения = пакет.get("app")
    if сведения is not None:
        out += _ключи("app", сведения, SCHEMA["app"])
    if isinstance(сведения, dict):
        for экран in сведения.get("screens") or ():
            out += _ключи(f"экран {экран.get('key')}", экран, SCHEMA["screen"])

    for имя, запись in (пакет.get("types") or {}).items():
        out += _ключи(f"тип {имя}", запись, SCHEMA["type"])
        out += _тип_как_в_таблице(имя, запись)

    for модель in пакет.get("models") or ():
        out += _ключи(f"модель {модель.get('name')}", модель, SCHEMA["model"])
        for поле in модель.get("fields") or ():
            out += _ключи(f"поле {модель.get('name')}.{поле.get('name')}",
                          поле, SCHEMA["field"])

    for вид in пакет.get("views") or ():
        out += _ключи(f"вид {вид.get('name')}", вид, VIEW_NODE)

    for номер, запись in enumerate(пакет.get("logic") or ()):
        out += _ключи(f"logic[{номер}]", запись, SCHEMA["logic"])
        for действие in запись.get("actions") or ():
            out += _действие(действие)
    return out


def _ключи(где, запись, договор):
    """Чего в записи не хватает и что в ней лишнее."""
    if not isinstance(запись, dict):
        return [f"{где}: ожидался словарь, приехало {type(запись).__name__}"]
    нет = sorted(set(договор["required"]) - set(запись))
    лишние = sorted(set(запись) - set(договор["required"])
                    - set(договор.get("optional") or ()))
    out = []
    if нет:
        out.append(f"{где}: нет ключей {нет}")
    if лишние:
        out.append(f"{где}: ключи вне договора {лишние}")
    return out


def _тип_как_в_таблице(имя, запись):
    """Свойства типа язык не сочиняет -- он их переписывает из общей таблицы.

    Разъехавшаяся копия таблицы у Kotlin или JavaScript означала бы другую
    колонку в SQL на том же приложении -- и заметить это можно было бы только
    тогда, когда обмен счёл бы два одинаковых приложения разными.
    """
    эталон = FIELD_TYPES.get(имя)
    if эталон is None:
        return [f"тип {имя}: нет в protocol/field-types.json"]
    out = []
    for ключ in SCHEMA["type"]["required"]:
        if ключ in запись and запись[ключ] != эталон.get(ключ):
            out.append(f"тип {имя}.{ключ}: {запись[ключ]!r}, "
                       f"а в protocol/field-types.json {эталон.get(ключ)!r}")
    return out


def _действие(действие):
    """Объявление действия: ключи, ровно одно тело, словарь сигнатуры."""
    договор = SCHEMA["action"]
    имя = действие.get("name")
    известные = (set(договор["required"]) | set(договор["optional"])
                 | set(договор["bodies"]))
    out = []
    нет = sorted(set(договор["required"]) - set(действие))
    if нет:
        out.append(f"действие {имя}: нет ключей {нет}")
    лишние = sorted(set(действие) - известные)
    if лишние:
        out.append(f"действие {имя}: ключи вне договора {лишние}")

    тела = [к for к in договор["bodies"] if к in действие]
    if len(тела) != 1:
        out.append(f"действие {имя}: тел {len(тела)} ({тела}), "
                   "а выполнимо ровно с одним")
    if ("rule" in действие) != ("write" in действие):
        out.append(f"действие {имя}: «rule» и «write» едут только парой")
    for тело in тела:
        if тело in SCHEMA["body"]:
            out += _ключи(f"тело «{тело}» действия {имя}",
                          действие[тело], SCHEMA["body"][тело])

    for раздел in ("args", "returns"):
        for запись in действие.get(раздел) or ():
            out += _ключи(f"{имя}.{раздел}", запись, SCHEMA["signature"])
            if isinstance(запись, dict) and запись.get("type") not in ARG_TYPES:
                out.append(f"{имя}.{раздел}: тип {запись.get('type')!r} не из "
                           "словаря protocol/logic.json, manifest.types")
    return out


# --------------------------------------------------------------------------
# настоящие пакеты трёх языков
# --------------------------------------------------------------------------
@functools.lru_cache(maxsize=None)
def python_bundle(app_file: Path):
    """Отдельным процессом на каждый пример.

    Не из осторожности: реестр моделей глобален и ключуется именем класса, а
    ``Task`` есть в трёх примерах. Загрузи их в один процесс -- и связи начнут
    разрешаться в чужой класс, причём молча.
    """
    out = subprocess.run(
        [sys.executable, "-m", "oneframework.cli.main", "declare", str(app_file)],
        capture_output=True, text=True, cwd=str(ROOT))
    assert out.returncode == 0, f"{app_file}: {out.stderr}"
    return json.loads(out.stdout)


@functools.lru_cache(maxsize=None)
def javascript_bundle():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node на этой машине нет")
    cli = ROOT / "libs" / "js" / "bin" / "oneframework.mjs"
    out = subprocess.run([node, str(cli), "declare", str(JS_APP)],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def kotlin_ready():
    from conftest import kotlin_ready as спросить

    return спросить()


@functools.lru_cache(maxsize=None)
def kotlin_bundle():
    if not kotlin_ready():
        pytest.skip("компилятора Kotlin нет: KOTLIN_HOME не указан")
    # Печатает пакет **ядро** (`src/build/kotlin.mjs`): питоновской
    # привязки Kotlin больше нет. Дорога та же, которой ходит сборка.
    from oneframework.cli.sources import from_kotlin

    return from_kotlin(KOTLIN_APP).doc


# --------------------------------------------------------------------------
# договор против настоящих пакетов
# --------------------------------------------------------------------------
def test_examples_are_there_to_check():
    """Пример, пропавший из папки, не должен тихо сократить проверку."""
    assert len(PYTHON_APPS) >= 8, [p.parent.name for p in PYTHON_APPS]


@pytest.mark.parametrize("app_file", PYTHON_APPS, ids=lambda p: p.parent.name)
def test_python_declares_by_the_contract(app_file):
    """Каждым примером -- ради разнообразия того, что в пакет попадает.

    У одного приложения полей четырёх типов и логики нет вовсе; договор же
    описывает и правило запросом, и вычисляемое поле, и связь. Проверять его
    одним примером значило бы проверять четверть.
    """
    assert жалобы(python_bundle(app_file)) == []


def test_javascript_declares_by_the_contract():
    """Пакет печатает библиотека на JavaScript -- своим кодом, а не питоном."""
    assert жалобы(javascript_bundle()) == []


def test_kotlin_declares_by_the_contract():
    """То же для Kotlin: у него и таблица типов своя, исходником."""
    assert жалобы(kotlin_bundle()) == []


def test_three_languages_send_the_same_envelope():
    """Конверт у трёх языков обязан быть одним -- ключ в ключ.

    Не значения: заголовок и цвет у трёх приложений разные, этим их и
    различают. Одинаков обязан быть **набор** ключей: тот, которого у одного
    языка нет, сборка читает умолчанием, и «зависимостей нет» перестаёт
    отличаться от «библиотека забыла ключ». Ровно так и было с ``maven``.
    """
    конверты = {
        "python": python_bundle(ROOT / "examples" / "notes-python" / "app.py"),
        "javascript": javascript_bundle(),
    }
    # Kotlin -- только если есть чем собрать; питон против JavaScript проверяется
    # и без него, иначе отсутствие компилятора уносило бы и эту сверку.
    if kotlin_ready():
        конверты["kotlin"] = kotlin_bundle()
    наборы = {язык: (sorted(п), sorted(п["app"]))
              for язык, п in конверты.items()}
    один = наборы["python"]
    for язык, набор in наборы.items():
        assert набор == один, f"{язык}: конверт другой формы"


def test_the_contract_version_is_the_one_that_works():
    """Не шестой номер версии, а та же самая.

    Из пяти номеров, лежавших в дереве, работал ровно один. Этот файл заводит
    шестой -- и обязан быть привязан к работающему, иначе он врёт с первой же
    правки договора.
    """
    assert SCHEMA["version"] == declaration.VERSION


def test_the_action_form_is_written_once():
    """Форма объявления действия описана в одном месте, а не в двух.

    Второй список верхних ключей стоял в ``protocol/logic.json`` (manifest) и
    описывал время модулей WASM: «abi», «module», «entry», «purpose» не
    печатает ни одна из трёх библиотек. Проверяет ``_действие`` по
    ``declaration.json``, а тот список никто не читал -- и потому он разошёлся
    молча. Здесь закреплено, что он не вернётся и что оставленная вместо него
    ссылка не ведёт в пустоту.
    """
    манифест = _protocol("logic.json")["manifest"]
    свой_список = sorted({"required", "optional"} & set(манифест))
    assert not свой_список, (
        f"protocol/logic.json, manifest: снова свой список ключей {свой_список}. "
        "Форма объявления действия -- в protocol/declaration.json, раздел «action»; "
        "по второму списку никто не проверяет, и разойдётся он молча")
    # Тем же правилом -- запись сигнатуры: её ключи тоже лежали двумя
    # списками, и второй точно так же никто не читал.
    ссылки = {"action": манифест.get("form"),
              "signature": манифест["signature"].get("form")}
    for раздел, ссылка in ссылки.items():
        assert isinstance(ссылка, str) and f"«{раздел}»" in ссылка \
            and ссылка.startswith("protocol/declaration.json"), (
            f"protocol/logic.json, manifest: вместо ссылки на форму -- "
            f"{ссылка!r}. Ключи записи перечислены в "
            f"protocol/declaration.json, раздел «{раздел}»")
        assert SCHEMA[раздел]["required"], (
            f"раздел «{раздел}» договора опустел, а на него ссылаются")


# --------------------------------------------------------------------------
# проверка обязана уметь падать
# --------------------------------------------------------------------------
#: Правдоподобные поломки пакета -- те самые, что раньше проходили молча.
#:
#: Ключ английский, потому что он становится именем прогона, а pytest
#: печатает кириллицу в именах escape-последовательностями: разобрать, что
#: именно упало, стало бы невозможно. Почему поломка правдоподобна -- рядом,
#: и оно же уходит в сообщение об отказе.
ПОЛОМКИ = {
    "python_packages_renamed": (
        "библиотека на JS назвала ключ по-своему -- колёса тихо не поедут",
        lambda п: п["app"].update(pythonPackages=п["app"].pop("python_packages"))),
    "sync_dropped": (
        "обмен молча выключен",
        lambda п: п["app"].pop("sync")),
    "maven_dropped": (
        "зависимости Kotlin молча не поедут",
        lambda п: п["app"].pop("maven")),
    "db_name_dropped": (
        "база заведётся под выведенным именем, а не под объявленным",
        lambda п: п["app"].pop("db_name")),
    "logic_section_dropped": (
        "логики как не бывало",
        lambda п: п.pop("logic")),
    "foreign_version": (
        "пакет от библиотеки другого поколения",
        lambda п: п.update(oneframework=99)),
    "screen_without_master_detail": (
        "экран не сказал, становится ли запись рядом со списком",
        lambda п: п["app"]["screens"][0].pop("master_detail")),
    "type_with_foreign_sql": (
        "копия таблицы типов разъехалась -- в SQL будет другая колонка",
        lambda п: п["types"]["string"].update(sql="BLOB")),
    "view_without_state": (
        "экранных полей как не бывало -- рантайм о них и не узнает",
        lambda п: п["views"][0].pop("state")),
    "field_with_unknown_key": (
        "свойство поля, о котором две другие библиотеки не знают",
        lambda п: п["models"][0]["fields"][0].update(colour="красный")),
    "action_without_body": (
        "действие, которое нечем выполнить",
        lambda п: _действие_пакета(п).pop("python")),
    "action_with_two_bodies": (
        "какое из двух тел выполнят, решил бы рантайм",
        lambda п: _действие_пакета(п).update(js=dict(_действие_пакета(п)["python"]))),
    "write_without_rule": (
        "правка без запроса, который дал бы ей набор",
        lambda п: _действие_пакета(п).update(write={"table": "note"})),
    "body_without_writes": (
        "хост запишет что угодно: закрытый список полей потерян",
        lambda п: _действие_пакета(п)["python"].pop("writes")),
    "argument_of_unknown_type": (
        "тип не из словаря -- хост не поймёт, что подставлять",
        lambda п: _действие_пакета(п)["args"][0].update(type="набор")),
}


def _действие_пакета(пакет):
    return пакет["logic"][0]["actions"][0]


@pytest.mark.parametrize("случай", sorted(ПОЛОМКИ))
def test_a_broken_bundle_is_named_out_loud(случай):
    """Каждая поломка обязана дать **новую** жалобу.

    Без этого теста все предыдущие доказывают только то, что не падают.
    Сравнивается с жалобами на целый пакет, а не с пустотой: иначе разъехавшийся
    образец сделал бы этот тест зелёным, ничего не проверив.
    """
    почему, испортить = ПОЛОМКИ[случай]
    целый = python_bundle(ROOT / "examples" / "notes-python" / "app.py")
    испорчен = json.loads(json.dumps(целый))
    испортить(испорчен)
    новые = set(жалобы(испорчен)) - set(жалобы(целый))
    assert новые, f"{случай}: {почему} -- и ни одной жалобы"


# ==========================================================================
# граница: объявление не поднимает рантайм
# ==========================================================================
_ОБЪЯВИТЬ = r"""
import json, sys, importlib.util
sys.path.insert(0, sys.argv[1])
sys.path.insert(0, sys.argv[2])
sys.path.insert(0, sys.argv[2] + "/modules")
spec = importlib.util.spec_from_file_location("app", sys.argv[2] + "/app.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
from oneframework.declaration import declare
declare(m.app)
print(json.dumps(sorted(n for n in sys.modules if n.startswith("oneframework"))))
"""


def test_declaring_an_app_does_not_raise_the_runtime():
    """Объявление не поднимает того, что нужно только исполнению.

    До 20.08.2026 объявление приложения поднимало весь питоновский рантайм:
    ``App`` ввозил ``Runtime`` на верхнем уровне, а ``Screen.ir()`` спрашивал
    у него, разделён ли экран, -- ради ответа «рантайма нет». Замерено: 30
    модулей на 11 132 строки против 22 на 7 502 после развязки.

    21.08.2026 сам рантайм удалён, и первая половина списка запретов исчезла
    бы вместе с ним: имя удалённого модуля не ввезёт никто, и сторож, стерегущий
    только его, зелен всегда. Поэтому запреты пересобраны из того, что
    **существует** -- слоя выборки (`rel/`) и выкладки логики (`wasm/`): объявлению
    они не нужны, а ввозятся отложенно и потому легко всплывают наверх.
    """
    import subprocess
    import sys as _sys

    вывод = subprocess.run(
        [_sys.executable, "-c", _ОБЪЯВИТЬ, str(ROOT), str(ROOT / "examples" / "gtasks")],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    assert вывод.returncode == 0, вывод.stderr
    поднято = set(json.loads(вывод.stdout.strip().splitlines()[-1]))

    #: Точные имена, а не «всё, чего не ждали»: список запретов, который
    #: перечисляет несуществующее, зелен всегда и не сторожит ничего.
    лишнее = {n for n in поднято
              if n.startswith(("oneframework.rel", "oneframework.wasm",
                               "oneframework.cli"))}
    assert not лишнее, (
        f"объявление подняло исполнение: {sorted(лишнее)}. "
        "Ввоз, которому место внутри функции, снова стоит на верхнем уровне."
    )


def test_a_missing_section_is_refused_by_name():
    """Раздела нет -- отказ вслух, а не «значит пусто».

    Обязательны именно ключом ``logic`` и ``seeds``: пустой список -- законный
    ответ «их нет», отсутствие ключа -- потерянный раздел. Прими Bundle второе
    за первое, и приложение уехало бы без логики или без демо-данных, а
    объяснить это было бы нечем: ни ошибки, ни следа, просто пусто.

    Раздел ``seeds`` появился 21.08.2026, когда посев переехал в пакет. Пока
    его обязательность не была записана здесь, снятая проверка оставляла всю
    сюиту зелёной -- замерено.
    """
    from oneframework.declaration import Bundle, DeclarationError

    целый = _пакет_примера("todo")
    for раздел in SCHEMA["envelope"]["required"]:
        if раздел == "oneframework":
            continue                      # версию стережёт отдельный отказ
        урезанный = {к: v for к, v in целый.items() if к != раздел}
        with pytest.raises(DeclarationError, match=раздел):
            Bundle(урезанный)


def _пакет_примера(имя):
    """Пакет живого примера -- подпроцессом, как у соседей.

    Голый ``import app`` в общем процессе травит ``sys.modules`` и посев
    следующего примера пишет строки в классы соседа. Довод тот же, что в
    ``test_build_db.py``.
    """
    import json as _json
    import subprocess
    import sys as _sys

    скрипт = (
        "import json, sys; sys.path.insert(0, sys.argv[1]);"
        " sys.path.insert(0, sys.argv[1] + '/examples/' + sys.argv[2]);"
        " import app;"
        " from oneframework.declaration import declare;"
        " print(json.dumps(declare(app.app), ensure_ascii=False, default=str))"
    )
    готово = subprocess.run([_sys.executable, "-c", скрипт, str(ROOT), имя],
                            capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert готово.returncode == 0, готово.stderr
    return _json.loads(готово.stdout)

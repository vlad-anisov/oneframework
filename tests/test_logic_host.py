"""Договор хоста с объявленным действием: что оно может и как отказывает.

Правило не формальность. База ведёт учёт правок для обмена, и запись мимо неё
не уехала бы на другие устройства -- разошлись бы молча. Поэтому действие
возвращает записи, а кладёт их хост, сверяясь со списком `writes` из
объявления.

Почему этот файл появился 21.08.2026. Правило было записано дважды: у
питоновского исполнителя (`rel/action.py`) и у того, что стоит на устройстве
(`src/runtime/logic.js`). Сторожила его только первая запись -- та, которая
на устройстве не исполняется ни разу. Проверено мутацией: снятый список
разрешённых полей в `logic.js` оставлял **всю сюиту зелёной**.

Действие здесь на JavaScript, и это не случайность: его исполняет сам движок.
Питоновскому нужен Pyodide, а под node его не поднять -- `import()` принимает
`file:`, `fetch` принимает `http:`, и одного значения, годного обоим, нет.

Объявление написано **руками**, а не собрано из питоновского метода. Так и
надо: собранное всегда согласовано с телом, а проверяется здесь как раз то, что
делает хост с несогласованным -- то есть с ответом, где полей больше, чем
разрешено.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import needs_node
from jsrt import ОтказJs, Рантайм
from oneframework import App, Boolean, Button, Logic, Model, Screen, String, View

ROOT = Path(__file__).resolve().parents[1]

pytestmark = needs_node


class Листок(Model):
    _table = "листок"
    name = String("Имя")
    done = Boolean("Готово")


class Стол(View):
    model = Листок

    def ui(self, record):
        # Кнопка нужна проверке отказа: нажатие возвращается в рантайм номером
        # кнопки, и без неё в кадре дойти до действия нечем. `Logic("имя")`
        # строкой -- потому что объявление здесь рукописное, метода за ним нет.
        return (
            Button("Тронуть", action=Logic("Листок.тронуть")),
            # Второе действие набора **не просит**: без него правило «нужен
            # набор» не отличить от «нужен всегда» -- переусердствовавшая
            # проверка запретила бы законное, и сюита осталась бы зелёной.
            Button("Само", action=Logic("Листок.само")),
        )


#: Тело действия. Возвращает **оба** поля, хотя разрешено ему одно: ровно тот
#: случай, ради которого хост и сверяется со списком.
ИСХОДНИК = """
exports.__oneframework_entry = function (кадр) {
  return { records: (кадр.records || []).map((r) => ({
    id: r.id, name: "переписано", done: true,
  })) };
};
"""

#: Действие без аргумента-набора: оно работает само по себе, и записи ему не
#: нужно. Тело то же -- важно объявление.
САМО = {
    "name": "Листок.само",
    "label": "само",
    "model": "Листок",
    "args": [],
    "returns": [{"name": "records", "type": "json"}],
    "language": "javascript",
    "js": {"entry": "__oneframework_entry", "source": ИСХОДНИК, "writes": ["name"]},
}

ОБЪЯВЛЕНИЕ = {
    "name": "Листок.тронуть",
    "label": "тронуть",
    "model": "Листок",
    "args": [{"name": "ids", "type": "ids"}],
    "returns": [{"name": "records", "type": "json"}],
    "language": "javascript",
    "js": {"entry": "__oneframework_entry", "source": ИСХОДНИК, "writes": ["name"]},
}


@pytest.fixture()
def рт(tmp_path):
    """Приложение с рукописным объявлением действия, собранное как настоящее."""
    from oneframework.cli.assets import write_app_db
    from oneframework.cli.plan import build_plan

    план = build_plan(_пакетом(App(Screen(Стол), title="Листки")))
    план["defs"].append(["action", ОБЪЯВЛЕНИЕ["name"], ОБЪЯВЛЕНИЕ])
    план["defs"].append(["action", САМО["name"], САМО])
    файл = tmp_path / "app.db"
    план["file"] = str(файл)
    готово = subprocess.run(
        ["node", str(ROOT / "src" / "build-db.mjs")],
        input=json.dumps(план, ensure_ascii=False), capture_output=True,
        text=True, encoding="utf-8", cwd=str(ROOT),
    )
    assert готово.returncode == 0, готово.stderr
    assert "error" not in json.loads(готово.stdout), готово.stdout

    r = Рантайм(App(Screen(Стол), title="Листки"), db_file=файл)
    yield r
    r.close()


def test_the_action_is_reachable_at_all(рт):
    """Сначала -- что действие вообще доехало: иначе проверка ниже пуста."""
    assert рт.call("logic_actions") == ["Листок.само", "Листок.тронуть"]


def test_the_host_writes_the_allowed_field(рт):
    """Разрешённое поле обязано записаться -- иначе действие бесполезно."""
    ключ = рт.db.create("Листок", {"name": "было", "done": False})
    рт.call("run_logic", "Листок.тронуть", [ключ])
    assert рт.db.read("Листок", ключ)["name"] == "переписано"


def test_the_host_refuses_the_field_that_was_not_declared(рт):
    """А незаявленное -- **не** обязано, и это главное правило файла.

    Действие вернуло `done`, хотя объявило `writes: ["name"]`. Хост обязан его
    отбросить. Без этой проверки список разрешённых полей можно было снять
    целиком, и ни один прогон бы не заметил.
    """
    ключ = рт.db.create("Листок", {"name": "было", "done": False})
    рт.call("run_logic", "Листок.тронуть", [ключ])
    стало = рт.db.read("Листок", ключ)
    assert стало["done"] in (0, False), f"записалось незаявленное: {стало}"


#: Объявление, у которого названной функции нет вовсе.
БЕЗ_ТОЧКИ = {
    "name": "Листок.нет", "label": "нет", "model": "Листок",
    "args": [{"name": "ids", "type": "ids"}],
    "returns": [{"name": "records", "type": "json"}],
    "language": "javascript",
    "js": {"entry": "отсутствует", "source": "exports.другая = () => ({});\n",
           "writes": ["name"]},
}

#: Объявление, чей текст падает при исполнении, но разбирается при загрузке.
ПАДАЮЩЕЕ = {
    "name": "Листок.падает", "label": "падает", "model": "Листок",
    "args": [{"name": "ids", "type": "ids"}],
    "returns": [{"name": "records", "type": "json"}],
    "language": "javascript",
    "js": {"entry": "__oneframework_entry",
           "source": ('exports.__oneframework_entry = function () {\n'
                      '  throw new Error("ошибка внутри действия");\n};\n'),
           "writes": ["name"]},
}


@pytest.fixture()
def рт_с(tmp_path):
    """Тот же подъём, но объявления задаёт сама проверка."""
    def сделать(*объявления):
        from oneframework.cli.plan import build_plan

        план = build_plan(_пакетом(App(Screen(Стол), title="Листки")))
        for д in объявления:
            план["defs"].append(["action", д["name"], д])
        файл = tmp_path / f"{len(объявления)}.db"
        план["file"] = str(файл)
        готово = subprocess.run(
            ["node", str(ROOT / "src" / "build-db.mjs")],
            input=json.dumps(план, ensure_ascii=False), capture_output=True,
            text=True, encoding="utf-8", cwd=str(ROOT),
        )
        assert готово.returncode == 0, готово.stderr
        r = Рантайм(App(Screen(Стол), title="Листки"), db_file=файл)
        сделать.открытые.append(r)
        return r

    сделать.открытые = []
    yield сделать
    for r in сделать.открытые:
        r.close()


def test_a_missing_entry_point_is_named(рт_с):
    """Названной функции нет -- отказ обязан назвать и её, и что есть.

    Иначе человек видит «действие не сработало» и идёт искать причину в базе,
    в правах, в чём угодно, кроме опечатки в имени.
    """
    рт = рт_с(БЕЗ_ТОЧКИ)
    with pytest.raises(ОтказJs) as отказ:
        рт.call("run_logic", "Листок.нет", [])
    assert "отсутствует" in отказ.value.message, отказ.value.message
    assert "другая" in отказ.value.message, "отказ не сказал, что в объявлении есть"


def test_a_broken_action_does_not_break_the_boot(рт_с):
    """Текст исполняется при вызове, а не при загрузке.

    Приложение с падающим действием обязано подниматься: иначе одна опечатка в
    одном действии не даёт открыть приложение вовсе, и починить её негде.
    """
    рт = рт_с(ПАДАЮЩЕЕ)
    assert рт.call("logic_actions") == ["Листок.падает"], "приложение не поднялось"
    with pytest.raises(ОтказJs, match="ошибка внутри действия"):
        рт.call("run_logic", "Листок.падает", [])


def _пакетом(app, seed=None):
    """Приложение -> пакет объявления: дорога в план теперь одна.

    Своей проверки здесь нет -- что пакет несёт всё, стережёт
    `test_plan_one_road.py`. Здесь только перевод.
    """
    from oneframework.declaration import Bundle, declare

    return Bundle(declare(app, seed))


def test_the_host_refuses_an_action_with_no_record_in_context(рт):
    """Действию нужен набор, а записи нет -- отказ вслух, а не работа впустую.

    До 21.08.2026 такое действие исправно исполнялось над **пустым** набором:
    проходило успешно и не меняло ничего. На экране это выглядело как кнопка,
    которая молчит, -- ни ответа, ни отказа, ни следа. Замерено на всех трёх
    примерах тройки, то есть поведение было каркасное, а не языковое.

    Кнопку на черновике теперь гасит сам рантайм
    (`tests/e2e/notes-kotlin.spec.js`), но сюда можно прийти и мимо неё --
    адресом, действием строки, чужим вызовом. Поэтому рубежа два.
    """
    кадр = рт.call("current")
    кнопка = _кнопка(кадр)
    with pytest.raises(ОтказJs, match="ещё не создана"):
        рт.call("dispatch", {
            "type": "action", "button_id": кнопка["id"],
            "context": {"screen_id": кадр["id"], "model": "Листок",
                        "record_id": None, "in_row": False},
        })


def test_the_same_action_runs_once_the_record_exists(рт):
    """С записью в руках то же нажатие обязано **сработать**.

    Иначе отказ выше запретил бы законное: правило звучит «набор пуст», а не
    «действия нельзя».
    """
    ключ = рт.db.create("Листок", {"name": "было", "done": False})
    кадр = рт.call("current")
    кнопка = _кнопка(кадр)
    рт.call("dispatch", {
        "type": "action", "button_id": кнопка["id"],
        "context": {"screen_id": кадр["id"], "model": "Листок",
                    "record_id": ключ, "in_row": False},
    })
    assert рт.db.read("Листок", ключ)["name"] == "переписано"


def _кнопка(кадр):
    """Первая кнопка кадра. Нажатие возвращается номером -- он и нужен."""
    return _кнопки(кадр)[0]


def _кнопки(кадр):
    """Все кнопки кадра, в порядке обхода."""
    найдено = []

    def обойти(узел):
        if isinstance(узел, dict):
            if узел.get("type") == "button":
                найдено.append(узел)
            for значение in узел.values():
                обойти(значение)
        elif isinstance(узел, list):
            for э in узел:
                обойти(э)

    обойти(кадр.get("tree", кадр))
    assert найдено, f"в кадре нет кнопки: {sorted(кадр)}"
    return найдено


def test_an_action_that_wants_no_records_runs_without_one(рт):
    """Кто набора не просил, тому запись и не нужна.

    Иначе правило «нужен набор» выродилось бы в «нужен всегда», и отказ
    запретил бы законное. Замерено: без этой проверки переусердствовавшее
    правило оставляло сюиту зелёной.
    """
    кадр = рт.call("current")
    кнопки = _кнопки(кадр)
    само = next(к for к in кнопки if к["label"] == "Само")
    # Без записи и без отказа: тело ничего не найдёт в пустом кадре и вернёт
    # пустой ответ -- это законный исход, а не молчание вместо работы.
    рт.call("dispatch", {
        "type": "action", "button_id": само["id"],
        "context": {"screen_id": кадр["id"], "model": "Листок",
                    "record_id": None, "in_row": False},
    })

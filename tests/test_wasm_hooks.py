"""Слой логики, привязанный к интерфейсу: кнопка, поле и сохранение.

До этого модуля WASM был построен, доставлен и проверен -- и ни разу не позван
приложением. Здесь проверяются три места, где он наконец зовётся, и все три на
**живом примере** ``examples/gtasks``, а не на модели, сочинённой для теста:
пример -- это и есть доказательство, что слой рабочий, а не только покрытый.

* **действие на кнопке.** «Выполнено» на карточке задачи -- не ``Set(done)``:
  завершить надо и подзадачи, на любую глубину, и проставить дату выполнения,
  которую строка списка уже показывает. Ни то, ни другое декларацией не
  выражается, потому что глубина заранее неизвестна;
* **вычисляемое поле.** ``Board.progress`` -- колонки у него нет: готовность
  списка меняется от правки *другой* записи, и число, положенное в колонку,
  устарело бы молча. Считает его тот же модуль, и заодно другим объявлением,
  которое зовёт первое через хост;
* **проверка при сохранении.** Врезка в ``create``/``write``, пакетная: набор
  -- одна граница «всё или ничего», и годная запись рядом с негодной не ложится
  тоже.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

from jsrt import ОтказJs, Рантайм, needs_node
from oneframework.errors import ValidationError

pytestmark = needs_node

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "gtasks"


@pytest.fixture(scope="module")
def gtasks():
    if str(EXAMPLE) not in sys.path:
        sys.path.insert(0, str(EXAMPLE))
    spec = importlib.util.spec_from_file_location("gtasks_app", EXAMPLE / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def app(gtasks):
    return gtasks.app


#: Рантайм -- тот, что стоит на устройстве, вместе с подключённой логикой:
#: этот файл про слой логики и есть, и мерить его без логики значило бы мерить
#: молчание -- кнопка просто ничего бы не делала.
@pytest.fixture()
def runtime(app):
    # Без seed: демо-данные тут только мешали бы считать проценты.
    r = Рантайм(app, seed=None)
    yield r
    r.close()


@pytest.fixture()
def tree(runtime):
    """Дерево с задачей, двумя подзадачами и одной уже завершённой."""
    board = runtime.db.create("Board", {"name": "Дом"})
    top = runtime.db.create("Task", {"title": "Ремонт", "board": board})
    kid = runtime.db.create("Task", {"title": "Купить краску", "board": board, "parent": top})
    deep = runtime.db.create("Task", {"title": "Выбрать цвет", "board": board, "parent": kid})
    runtime.db.create("Task", {"title": "Готово", "board": board, "done": True,
                               "finished": "2026-08-01"})
    runtime.call("commit")
    for имя in runtime.call("models"):
        runtime.touch(имя)
    return {"board": board, "top": top, "kid": kid, "deep": deep}


def fields_of(frame):
    return {c["name"]: c for c in frame.tree["children"] if c.get("type") == "field"}


def button(frame, label):
    nodes = frame.tree["children"] + frame.tree.get("navbar_buttons", [])
    return next(n for n in nodes if n.get("type") == "button" and n.get("label") == label)


# ==========================================================================
# объявление
# ==========================================================================
def test_the_example_declares_logic_and_it_reaches_the_database(app, runtime):
    """Объявление лежит в базе, а не рядом с исходниками.

    Проверяется именно база: на устройстве исходников нет, и объявление,
    оставшееся в питоне, туда не доедет никаким способом.

    С 16.08.2026 модуля у примера **нет вовсе**. Оба действия, ради которых он
    существовал, выразились данными: готовность -- объявлением вычисляемого
    поля, «завершить с подзадачами» -- правилом плюс правкой. Шапка
    `examples/logic/src/lib.rs` называла оба «тем, что декларацией не
    выражается»; сверка показала обратное.
    """
    import importlib

    from oneframework.rel.action import is_declarative, is_python

    # Самого понятия «модуль» больше нет: пакет `oneframework.wasm` держал
    # выкладку модулей в базу и удалён 21.08.2026 -- к тому дню он состоял из
    # постоянных, которых не читал никто, и трёх исключений, которых никто не
    # ловил. Проверяется отсутствием: вернётся -- вернётся и то, ради чего он
    # был, а объявление действия обходится без байтов.
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("oneframework.wasm")
    #: Спрашивается **план выкладки**: он и отвечает, что поедет в базу. Что
    #: оно доехало и до рантайма, говорит `logic_actions` ниже.
    from oneframework.cli.plan import build_plan

    docs = [д for в, _и, д in build_plan(_пакетом(app))["defs"] if в == "action"]
    # Два объявления и два разных способа их посчитать: «Task.complete» --
    # правило плюс правка, то есть запрос; «Board.normalize» -- исходник
    # питона, потому что словарной морфологии в SQL нет и не будет. Оба при
    # этом **объявления**: ни байтов, ни точки входа в модуль.
    assert sorted(d["name"] for d in docs) == ["Board.normalize", "Task.complete"]
    assert all(is_declarative(d) for d in docs), "объявление, а не точка входа"
    assert runtime.call("logic_actions") == ["Board.normalize", "Task.complete"]

    по_имени = {d["name"]: d for d in docs}
    assert not is_python(по_имени["Task.complete"]), "запрос остался запросом"
    assert is_python(по_имени["Board.normalize"])
    # Три языка и три способа их запуска показывает тройка examples/notes-*,
    # а не этот пример: смешивать «как устроено приложение» и «чем считается
    # логика» в одном месте значит объяснять сразу два разных предмета.
    # Исходник едет **текстом**, а не байтами: его читают глазами, и приезжает
    # он той же дорогой, что модели и виды.
    assert "pymorphy3" in по_имени["Board.normalize"]["python"]["source"]


def test_a_computed_field_has_no_column(app):
    """У вычисляемого поля колонки нет, и это главное в нём.

    Будь она -- число пережило бы правку соседней записи и осталось вчерашним,
    без ошибки и без следа.
    """
    board = app.model_by_name("Board")
    progress = board._fields["progress"]
    assert not progress.stored and progress.readonly
    assert "progress" not in [f.column for f in board.stored_fields()]

    # С 16.08.2026 поле объявлено **объявлением**, а не именем действия: раньше
    # рантайм звал модуль по одной записи (194,8 мс на список из трёхсот), а
    # теперь значение приезжает колонкой той же выборки. Обе формы остаются
    # рабочими, и различает их тип: строка -- действие, словарь -- объявление.
    #: Колонку собирает тот компилятор, что на устройстве: объявление в поле
    #: питоновское, а переводит его в SQL он.
    import types as _types

    from jsrel import call
    from oneframework.model.schema import app_schema

    call("load_models", app_schema(_types.SimpleNamespace(models=list(app.models))))
    ответ = call("computed_columns_of", "Board", "t")
    assert dict(ответ["columns"]).keys() == {"progress"}
    assert not ответ["refused"]
    # Компилятор **требует** путь доступа данными и не создаёт его сам.
    assert [a["prefix"] for a in ответ["access"]] == [["board_id"]]


# ==========================================================================
# кнопка
# ==========================================================================
def test_the_button_runs_the_module_and_the_module_walks_the_tree(runtime, tree):
    """Нажатие завершает задачу вместе с подзадачами на любую глубину.

    Именно вместе: ``Set(done, True)`` завершил бы одну строку, и на экране
    осталась бы завершённая задача с незавершёнными потомками.
    """
    runtime.push("TaskCard", recordId=tree["top"])
    done = button(runtime.current(), "Выполнено")
    assert done["action"] == {"type": "logic"}, "объявление протекло на провод"

    runtime.dispatch({"type": "action", "button_id": done["id"],
                      "context": done["context"]})

    rows = {key: runtime.db.read("Task", tree[key]) for key in ("top", "kid", "deep")}
    assert all(r["done"] for r in rows.values()), "подзадачи остались незавершёнными"
    # Дату выполнения ставит модуль: строка списка её уже показывала, а ставить
    # её было некому.
    assert all(r["finished"] for r in rows.values())


def test_an_unknown_action_names_what_is_declared(runtime):
    """Опечатка в виде -- отказ, называющий известные имена, а не пустой экран."""
    with pytest.raises(ОтказJs, match="Task.complete"):
        runtime.call("logic_action", "Task.compelte")


# ==========================================================================
# вычисляемое поле
# ==========================================================================
def test_the_computed_field_is_answered_by_the_module_when_it_is_drawn(runtime, tree):
    """Готовность считается при отрисовке и меняется от правки чужой записи.

    Из четырёх задач списка завершена одна -- 25 %. Завершив дерево из трёх,
    получаем четыре из четырёх, и число обязано измениться само: экран не
    перерисовывают руками.
    """
    runtime.push("BoardCard", recordId=tree["board"])
    assert fields_of(runtime.current())["progress"]["value"] == 25
    runtime.pop()

    runtime.push("TaskCard", recordId=tree["top"])
    done = button(runtime.current(), "Выполнено")
    runtime.dispatch({"type": "action", "button_id": done["id"],
                      "context": done["context"]})
    runtime.pop()

    runtime.push("BoardCard", recordId=tree["board"])
    assert fields_of(runtime.current())["progress"]["value"] == 100


def test_a_list_that_does_not_exist_yet_is_not_asked_about(runtime):
    """У черновика ключа нет, и спрашивать модуль не о чем.

    Без этого «создать список» падало бы на отрисовке -- то есть до того, как
    человек успел что-нибудь напечатать.
    """
    runtime.push("BoardCard", recordId=None)
    assert fields_of(runtime.current())["progress"]["value"] is None


# ==========================================================================
# проверка при сохранении -- удалена вместе с WASM
# ==========================================================================
#
# Здесь стояли две проверки врезки в `create`/`write`: набор -- одна граница
# «всё или ничего», и годная запись рядом с негодной не ложилась тоже. Правило
# бралось настоящее и невыразимое доменом -- «подзадача обязана лежать в том же
# списке, что и родитель», то есть вопрос к **другой** записи.
#
# Держались они на модуле WASM, который получал набор **до** записи и сам
# спрашивал у хоста родителей. Декларативной формы у этого нет и придумать её
# сходу нельзя: проверяемых записей в базе ещё нет, а SQL видит только то, что
# в ней лежит.
#
# Поэтому вместе с WASM ушла и врезка проверки. Это потеря, а не уборка, и она
# записана в `docs/plan-logic.md` как ближайшая работа: без неё «сохранить
# набор целиком или не сохранять вовсе» держать нечем.


def test_the_number_follows_a_change_in_another_model(runtime, tree):
    """Готовность обновляется от правки **задачи**, а не только списка.

    Экран карточки подписан на изменения списков, а формула читает задачи.
    Без подписки на прочитанное число осталось бы вчерашним: ни ошибки, ни
    следа, просто неверная цифра -- ровно то, ради чего у вычисляемого поля и
    нет колонки.

    Поймано не тестом, а вопросом «в какой момент запускается компут»: при
    проверке оказалось, что экран не перерисовывается.
    """
    runtime.push("BoardCard", recordId=tree["board"])
    before = fields_of(runtime.current())["progress"]["value"]

    # Правка чужой записи -- без единого прикосновения к самому списку.
    runtime.db.write("Task", tree["kid"], {"done": True})
    runtime.touch("Task")

    after = fields_of(runtime.current())["progress"]["value"]
    assert after > before, "число не обновилось при правке задачи"


def _пакетом(app, seed=None):
    """Приложение -> пакет объявления: дорога в план теперь одна.

    Своей проверки здесь нет -- что пакет несёт всё, стережёт
    `test_plan_one_road.py`. Здесь только перевод.
    """
    from oneframework.declaration import Bundle, declare

    return Bundle(declare(app, seed))

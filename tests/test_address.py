"""Адресная строка: форма адреса, запись в историю и дорога обратно.

Проверяется тот же файл, который поедет в браузер (``web/src/address.js``), --
импортом из ``web/src``, а не сборкой. Окно и склад подделаны драйвером
(``tests/parity/address_driver.mjs``), рантайм не участвует вовсе: здесь спор не
о том, что делает ``goto``, а о том, когда он рождается и что в это время
происходит с историей браузера.

Пять обещаний, и каждое ловит свой род поломки:

* адрес описывает **весь стек**, а не его вершину, -- иначе по ссылке
  восстанавливается место, но не путь возврата;
* возврат **укорачивает** историю, а не удлиняет её, и ровно на столько
  записей, сколько уровней снято: иначе «назад» в приложении и «назад» в
  браузере начинают спорить, и вторая ведёт вперёд;
* ``popstate`` разворачивается в событие рантайма, а не в движение
  маршрутизатора, -- стек остаётся единственным входом в навигацию;
* адрес, которого приложение не понимает, не двигает ничего и правится по
  стеку -- ссылка живёт в закладке дольше, чем раздел с таким именем;
* в нативной сборке строки нет вовсе: ссылка входит событием -- обеими
  дверями плагина, -- а история не двигается ни разу.

Про ``goto`` как таковой -- ``tests/test_screens.py``: там он спрашивается у
того рантайма, что стоит на устройстве.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "address_driver.mjs"

pytestmark = needs_node


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    """Драйвер читает вход файлом -- один каталог на модуль."""
    where = tmp_path_factory.mktemp("address")

    def go(case, hash_=""):
        path = where / f"{case}.json"
        path.write_text(json.dumps({"case": case, "hash": hash_}), encoding="utf-8")
        done = subprocess.run(
            ["node", str(DRIVER), str(path)],
            capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
        )
        assert done.returncode == 0, done.stderr
        return json.loads(done.stdout)

    return go


def test_the_address_carries_the_whole_stack(run):
    out = run("form")
    assert out["root"] == "#!/Tasks/"
    assert out["record"] == "#!/Tasks/TaskCard/t1/"
    assert out["deep"] == "#!/Tasks/TaskCard/t1/Sub/t4/"
    # Кадр без записи -- вид-раздел в глубине стека. Прочерк, чтобы пары не съехали.
    assert out["bare"] == "#!/Tasks/Settings/-/"


def test_a_card_and_a_draft_are_not_places(run):
    """Карточка -- состояние поверх места, черновик -- запись, которой ещё нет."""
    out = run("form")
    assert out["sheet"] == "#!/Tasks/"
    assert out["draft"] == "#!/Tasks/"
    # И хвост за ними не приклеивается к корню: склеенный через пропуск путь
    # описывал бы стек, которого не было.
    assert out["afterSheet"] == "#!/Tasks/"


def test_an_address_read_back_is_the_address_written(run):
    out = run("form")
    # Прочерк читается отсутствием записи, а не записью с ключом «-»: такую
    # `goto` пошёл бы искать в базе, не нашёл бы и молча оборвал путь -- ссылка
    # на вид-раздел приводила бы на корень.
    assert out["dash"] == {"screen": "Tasks",
                           "path": [{"view": "Settings", "record_id": None}]}
    assert out["odd"] == {"screen": "Tasks",
                          "path": [{"view": "Card", "record_id": "a/b?c d"}]}
    # Набранный руками -- без завершающей косой черты.
    assert out["typed"] == {"screen": "Tasks", "path": []}
    # В нативе приезжает целая ссылка со схемой, разбирается та же часть.
    assert out["full"] == {"screen": "Tasks",
                           "path": [{"view": "TaskCard", "record_id": "t1"}]}


def test_what_is_not_an_address_is_nothing(run):
    """Адрес -- ввод снаружи: набран руками, обрезан почтой, сохранён до переименования."""
    out = run("form")
    assert out["noHash"] is None      # `capacitor://localhost` -- не раздел `capacitor:`
    assert out["empty"] is None
    assert out["broken"] is None      # процент без пары цифр -- исключение в decodeURI


def test_forward_adds_a_place_and_back_takes_one_away(run):
    """История обязана вести себя как история, иначе «назад» браузера ведёт вперёд."""
    out = run("write")
    assert out["log"] == [
        # Первое место -- то, на которое человек пришёл: замена, а не запись.
        "replace #!/Tasks/",
        "push #!/Tasks/TaskCard/t1/",
        # Возврат снимает свою же запись, а не кладёт ещё одну.
        "go -1",
        "push #!/Tasks/TaskCard/t4/",
    ]
    assert out["entries"] == ["#!/Tasks/", "#!/Tasks/TaskCard/t4/"]
    assert out["hash"] == "#!/Tasks/TaskCard/t4/"


def test_a_crumb_unwinds_as_many_entries_as_levels(run):
    """Возврат через уровень -- столько же записей истории, сколько снятых кадров.

    Крошки шлют `back_to`, и стек укорачивается не на кадр, а на сколько
    придётся. Пока история отходила ровно на одну запись, браузер оставался на
    промежуточном адресе -- и тот немедленно разворачивался обратно в стек:
    нажатие на крошку читалось как «вернулся и снова провалился». Событие в
    ответе тому и свидетель: его быть не должно.
    """
    out = run("crumb")
    assert out["log"] == [
        "replace #!/Tasks/",
        "push #!/Tasks/TaskCard/t1/",
        "push #!/Tasks/TaskCard/t1/TaskCard/t4/",
        "go -2",
    ]
    assert out["events"] == []
    assert out["hash"] == "#!/Tasks/"


def test_the_browser_button_becomes_an_event(run):
    """Стек -- единственный вход в навигацию: кнопка браузера входит событием."""
    out = run("back")
    assert out["events"] == [
        {"type": "goto", "screen": "Tasks", "path": []},
        {"type": "goto", "screen": "Tasks",
         "path": [{"view": "TaskCard", "record_id": "t1"}]},
    ]
    # Ответный стек адрес уже описывает -- значит история от него не двигается.
    assert out["log"] == ["replace #!/Tasks/", "push #!/Tasks/TaskCard/t1/",
                          "go -1", "forward"]
    assert out["hash"] == "#!/Tasks/TaskCard/t1/"


def test_a_link_opens_the_record_it_names(run):
    """Ссылка -- одна запись истории, и корнем раздела она по дороге не мигает.

    Ответ рантайма приходит не в тот же такт, а склад за это время меняется по
    своему поводу -- в приложении этим тактом приходит состояние обмена. Пока
    подписка заводилась раньше ответа, тот посторонний такт читался как «стек
    стал корнем», и адрес правился по нему: строка мигала корнем, а под ссылкой
    заводилась вторая запись истории. Драйвер этот такт подаёт, поэтому проверка
    его и видит.
    """
    out = run("link", "#!/Tasks/TaskCard/t1")
    assert out["events"] == [
        {"type": "goto", "screen": "Tasks",
         "path": [{"view": "TaskCard", "record_id": "t1"}]},
    ]
    # Канон сразу: дальше адрес сравнивается строкой.
    assert out["log"] == ["replace #!/Tasks/TaskCard/t1/"]
    assert out["entries"] == ["#!/Tasks/TaskCard/t1/"]
    assert out["hash"] == "#!/Tasks/TaskCard/t1/"


def test_in_a_native_build_a_link_comes_through_both_doors(run):
    """Натив: адресной строки нет, и ссылка входит событием -- в обе двери.

    `getLaunchUrl()` -- не роскошь рядом с подпиской: при холодном старте
    `appUrlOpen` выстреливает раньше, чем рантайм готов его принять, и одной
    подпиской ссылка запуска теряется молча. Подделка плагина
    (``tests/parity/capacitor_app.mjs``) это и изображает: ссылку запуска она
    в подписку не отдаёт вовсе.

    Второе обещание -- история не двигается ни разу. `pushState` в Capacitor
    идёт на путь, которого нет (приложение загружено файлом `index.html`), и
    ломает перезапуск webview.
    """
    out = run("native")
    assert out["events"] == [
        # Первой -- та, которой приложение запустили.
        {"type": "goto", "screen": "Tasks",
         "path": [{"view": "TaskCard", "record_id": "t1"}]},
        # Второй -- открытая при живом приложении.
        {"type": "goto", "screen": "Tasks",
         "path": [{"view": "TaskCard", "record_id": "t4"}]},
    ]
    # `capacitor://localhost` -- обычный запуск, а не ссылка; чужой раздел --
    # чужая ссылка. Ни то, ни другое событием не становится.
    assert out["log"] == []
    # Отвязка закрывает дверь, а не только перестаёт слушать: ссылка после неё
    # ничего не прибавила.
    assert out["removed"] == 1
    assert out["left"] == 0


def test_a_link_into_a_section_that_is_gone_moves_nothing(run):
    out = run("stranger", "#!/Nope/TaskCard/t1/")
    assert out["events"] == []
    # Рантайм об этом адресе не слышал, а строка поправлена по стеку.
    assert out["log"] == ["replace #!/Tasks/"]
    assert out["hash"] == "#!/Tasks/"


def test_a_link_the_runtime_could_not_honour_is_corrected(run):
    """Записи по ссылке уже нет: рантайм оборвал путь, строка обязана сказать правду."""
    out = run("stale", "#!/Tasks/TaskCard/gone/")
    assert out["events"][0]["type"] == "goto"
    assert out["log"] == ["replace #!/Tasks/"]
    assert out["hash"] == "#!/Tasks/"

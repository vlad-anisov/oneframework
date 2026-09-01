"""Захват хранилища: вторая вкладка против протёкшего держателя.

`opfs-sahpool` отказывает одним и тем же `NoModificationAllowedError` в двух
совершенно разных положениях, и лечатся они противоположно:

* каталог держит **живая вторая вкладка** -- обходить нельзя. Обход здесь
  значит: не нашлась база, скачалась заново, ветка `fresh` выдала новый номер
  узла -- и у пользователя молча завелось второе устройство со своей базой и
  своей очередью неотправленного;
* держатель **протёк** -- обходить обязательно. Воркер, убитый браузером не
  по-хорошему, запирает каталог наглухо, отпустить его некому, и без обхода
  приложение не запускается совсем.

Различает их замок `navigator.locks`: браузер снимает его сам, когда владелец
умирает. Здесь проверяется, что решение принимается именно по нему.

Настоящего OPFS в node нет, и он не нужен: подменяются ровно две вещи, от
которых решение зависит, -- отдаётся ли каталог и жив ли держатель замка.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "pool_driver.mjs"

pytestmark = needs_node


def run(**case):
    done = subprocess.run(
        ["node", str(DRIVER), json.dumps(case)],
        capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def test_a_free_storage_is_taken_as_is():
    out = run(locked=[], alive=[])
    assert out["name"] == "oneframework"
    assert out["fellBack"] is False
    assert out["claimed"] == ["oneframework-storage:oneframework"], "замок обязан быть взят"


def test_a_live_second_tab_is_told_the_truth_instead_of_getting_its_own_device():
    """Главное: запасного имени нет вовсе, а значит нет и второго устройства.

    До починки здесь бралось `oneframework-2`, база скачивалась заново, узел получал
    новый номер -- и пользователю об этом не сообщалось ни словом.
    """
    out = run(locked=["oneframework"], alive=["oneframework"])
    assert out["busy"] is True
    assert "другой вкладке" in out["message"]
    assert out["tried"] == [], "занятое живой вкладкой даже не пробуется"
    assert "name" not in out, "второе хранилище не заводится"


def test_a_leaked_holder_is_still_walked_around():
    """Замок свободен, а файлы не отдаются -- держателя нет в живых.

    Это ровно тот случай, ради которого обход и появился: на живом стенде
    приложение переставало запускаться совсем, и перезагрузка не помогала.
    """
    out = run(locked=["oneframework"], alive=[])
    assert out["name"] == "oneframework-2"
    assert out["fellBack"] is True
    assert out["tried"].count("oneframework") == 6, "прежде чем обходить, надо подождать"


def test_the_name_from_the_last_run_is_tried_first():
    """Иначе следующий запуск заводил бы третий каталог поверх второго."""
    out = run(locked=[], alive=[], preferred="oneframework-2")
    assert out["name"] == "oneframework-2"
    assert out["tried"] == ["oneframework-2"]


def test_a_second_tab_on_the_fallback_storage_is_also_refused():
    """Занятость проверяется у того имени, которое берут, а не только у первого."""
    out = run(locked=["oneframework", "oneframework-2"], alive=["oneframework-2"])
    assert out["busy"] is True
    assert out["tried"] == ["oneframework"] * 6, "до занятого имени дошли, дальше не полезли"


def test_without_the_locks_api_the_old_behaviour_stays():
    """Выдумывать занятость там, где её нечем проверить, нельзя.

    Старая среда без `navigator.locks` теряет честный ответ, но не теряет
    работоспособности: остаётся прежний обход.
    """
    out = run(locked=["oneframework"], alive=["oneframework"], noLocks=True)
    assert out["name"] == "oneframework-2"
    assert out.get("busy") is None


def test_webkit_says_unknownerror_for_the_same_refusal():
    """Safari называет тот же отказ иначе -- и обход обязан начаться всё равно.

    `createSyncAccessHandle` в WebKit бросает `UnknownError` с припиской «for
    an unknown transient reason (e.g. out of memory)» там, где Chromium
    бросает `NoModificationAllowedError`. Пока разбиралось только второе имя,
    в Safari отказ пролетал наружу сырым: человек видел `UnknownError` вместо
    ответа, а обход не начинался. Поймано на живом стенде.
    """
    out = run(locked=["oneframework"], alive=[], errorName="UnknownError")
    assert out["name"] == "oneframework-2", "обход обязан сработать и на этом имени"
    assert out["fellBack"] is True


def test_a_live_second_tab_is_refused_on_webkit_too():
    """Замок решает раньше имени отказа, поэтому ответ тот же самый."""
    out = run(locked=["oneframework"], alive=["oneframework"], errorName="UnknownError")
    assert out["busy"] is True
    assert "другой вкладке" in out["message"]


def test_a_browser_without_usable_storage_is_told_so():
    """Отказало само хранилище -- обходить нечего, и молчать нельзя.

    Замерено 20.08.2026 на WebKit: `navigator.storage.getDirectory()` отвечает,
    а `getFileHandle(..., {create: true})` внутри воркера сразу отказывает
    `UnknownError`. До синхронного доступа дело не доходит, и обход по именам не
    помогает -- все пять отказывают одинаково.

    Раньше наружу летел сырой отказ SQLite: «The operation failed for an unknown
    transient reason (e.g. out of memory)». Именно с этой строкой к нам и пришли
    со стенда. Теперь -- имя отказа и объяснение.
    """
    #: Заперты все пять имён, и отказ у всех один -- то есть отказало само
    #: хранилище, а не чужая вкладка его держит.
    все = ["oneframework", "oneframework-2", "oneframework-3",
           "oneframework-4", "oneframework-5"]
    out = run(locked=все, alive=[], errorName="UnknownError")
    assert out["error"] == "StorageUnavailableError", out
    assert "хранилище" in out["message"]
    #: И это **не** «занято»: занято -- живая вкладка, а тут её нет.
    assert out["busy"] is False

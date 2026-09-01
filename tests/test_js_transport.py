"""Транспорт обмена на клиенте: круг, расписание, обрыв, отсутствие сети.

Механизм обмена проверяется отдельно (`test_sync.py`, `test_js_sync_parity.py`)
и здесь не повторяется -- ни один из этих случаев не про changeset'ы. Здесь
проверяется то, чего у механизма нет и не должно быть: **когда** заводится круг
и **что видно**, когда он не удался.

Пять обещаний, и каждое ловит свой род поломки:

* круг неделим -- два повода разом дают один запрос, а не два, иначе одни и те
  же changeset'ы уезжают парой;
* очередь не теряется при отказе -- неотправленное остаётся неотправленным, и
  это видно;
* «нет сети» и «сервер отказал» -- разные состояния: первое ждёт события, а не
  срока, второе отступает с нарастающей паузой;
* отказ по существу (схемы разошлись) не приближает следующую попытку;
* запись подталкивает обмен, но не мгновенно.

Проверяется тот же файл, который поедет в браузер, -- импортом из ``web/src``,
а не сборкой.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "transport_driver.mjs"

pytestmark = needs_node


def run(case):
    done = subprocess.run(
        ["node", str(DRIVER), "-"],
        input=json.dumps({"case": case}),
        capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


@pytest.fixture(scope="module")
def payload(tmp_path_factory):
    """Драйвер читает вход файлом -- один на модуль."""
    def make(case):
        path = tmp_path_factory.mktemp("transport") / f"{case}.json"
        path.write_text(json.dumps({"case": case}), encoding="utf-8")
        done = subprocess.run(
            ["node", str(DRIVER), str(path)],
            capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
        )
        assert done.returncode == 0, done.stderr
        return json.loads(done.stdout)

    return make


def test_where_to_call(payload):
    """Адрес: явный, свой собственный и никакой -- три разных ответа."""
    got = payload("endpoint")
    assert got["explicit"] == "https://terminal.anisov.by/sync"
    assert got["trailing"] == "https://terminal.anisov.by/sync"
    assert got["subpath"] == "https://host/app/sync"
    # Веб-клиент, отданный самим сервером обмена: настройки нет и не нужно.
    assert got["sameOrigin"] == "https://terminal.anisov.by/sync"
    assert got["nested"] == "https://host/app/sync"
    # Внутри Capacitor origin принадлежит вебвью -- своего сервера там нет.
    assert got["native"] is None
    assert got["nativeExplicit"] == "https://terminal.anisov.by/sync"
    assert got["off"] is None and got["offWord"] is None
    assert got["override"] == "https://b/sync"
    assert got["file"] is None


def test_one_round(payload):
    got = payload("round")
    assert got["requests"] == 1
    assert got["url"] == "https://host/sync"
    assert got["sentChanges"] == 2
    # Состояние проходит через «идёт обмен» -- иначе показывать было бы нечего.
    assert "syncing" in got["phases"]
    assert got["phase"] == "idle"
    assert got["pending"] == 0, "подтверждённое больше не висит в очереди"
    assert got["lastAt"] == 1000
    assert got["applied"] == 3
    assert got["rendered"] == 1, "принятые строки обязаны попасть в кадр"
    assert got["scheduledAfter"] == [15000], "следующий круг назначен"


def test_two_reasons_one_request(payload):
    got = payload("coalesce")
    assert got["requests"] == 1
    assert got["envelopes"] == 1, "конверт снимается один раз, а не дважды"
    assert got["same"] is True


def test_no_network(payload):
    got = payload("offline")
    assert got["offline"]["phase"] == "offline"
    assert got["offline"]["requests"] == 0, "без сети в сеть не ходим"
    assert got["offline"]["pending"] == 4, "неотправленное видно и офлайн"
    # Срока не назначаем: возвращение сети -- событие.
    assert got["offline"]["scheduled"] == 0
    # Сеть вернулась -- накопленное догоняет.
    assert got["after"]["phase"] == "idle"
    assert got["after"]["pending"] == 0


def test_broken_connection(payload):
    got = payload("failure")
    assert got["phase"] == "error"
    assert got["pending"] == 1, "очередь при обрыве цела"
    assert "ECONNREFUSED" in got["error"]
    assert got["waits"] == [10, 20, 40, 40], "пауза растёт и упирается в потолок"
    assert got["applied"] == 0


def test_refusal_is_not_a_broken_connection(payload):
    got = payload("refused")
    assert got["phase"] == "error"
    assert "Схемы разошлись" in got["error"]
    assert got["applied"] == 0, "отказ не накладывается"
    assert got["wait"] == 40, "быстрое повторение ничего не изменит"


def test_a_write_nudges_the_exchange(payload):
    got = payload("nudge")
    assert got["idle"] == 15000
    assert got["nudged"] == 700, "после записи -- скоро, но не мгновенно"
    assert got["requests"] == 2


def test_without_an_address_there_is_no_exchange(payload):
    got = payload("off")
    assert got["phase"] == "off"
    assert got["requests"] == 0
    assert got["text"] == "Обмен не настроен"


def test_what_the_owner_reads(payload):
    got = payload("words")
    assert got["idle"] == "Всё отправлено"
    assert got["unsent"] == "Не отправлено: 3"
    assert got["offline"] == "Нет сети, не отправлено: 2"
    assert got["never"] == "обмена ещё не было"
    assert got["justNow"] == "только что"
    assert got["minutes"] == "5 мин назад"

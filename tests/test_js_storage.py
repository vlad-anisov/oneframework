"""Схема и связи -- у той базы, что стоит на устройстве.

Файл назывался ``test_js_storage_parity.py`` и сверял две реализации доступа к
SQLite: питоновскую (`model/storage.py`) и ту, что на устройстве
(`src/runtime/db.js`). Сверка была настоящей, пока писали обе. С 21.08.2026
пишет одна -- базу приложения собирает `src/build-db.mjs`, -- и сверять
стало не с чем.

Правила остались, и они не про совпадение, а про поведение:

* имена таблиц связей собираются **из схемы**, а не объявляются: там две
  реализации однажды и разошлись бы молча;
* удаление записи обнуляет входящие ссылки, а не оставляет висящие.

Ожидания записаны числами, а не «как у соседа»: сосед мог бы ошибаться так же.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "storage_driver.mjs"

pytestmark = needs_node

#: Что делаем с базой. Порядок важен: удаление идёт последним, и проверяется
#: именно то, что оно оставило после себя.
ОПЕРАЦИИ = [
    {"op": "set_many2many", "model": "Task", "field": "labels", "id": "k-t1",
     "ids": ["k-l1", "k-l2"]},
    {"op": "set_many2many", "model": "Task", "field": "labels", "id": "k-t2",
     "ids": ["k-l2"]},
    # Удаление обязано обнулить входящие ссылки, а не оставить висящие.
    {"op": "unlink", "model": "Label", "id": "k-l1"},
]

ЗАПРОСЫ = [
    {"model": "Task", "field": "labels", "id": "k-t1"},
    {"model": "Task", "field": "labels", "id": "k-t2"},
    # Один-ко-многим -- другой дорогой: он читается не таблицей связи, а
    # обратной колонкой у потомка. Дорога своя, и до 21.08.2026 её не сторожил
    # никто: сломанный `readOne2many` оставлял всю сюиту зелёной.
    {"model": "Contact", "field": "notes", "id": "k-c1"},
    {"model": "Contact", "field": "notes", "id": "k-c2"},
]

#: Описание приложения собирает питон -- он язык объявления. Дальше всё делает
#: та сторона, которая делает это и на устройстве.
_ОПИСАНИЕ = r"""
import json, sys
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2])
from oneframework.model.schema import app_schema

app = __import__("app").app
print(json.dumps({"schema": app_schema(app),
                  "models": [m.__name__ for m in app.models]}, ensure_ascii=False))
"""


@pytest.fixture(scope="module")
def кухня():
    пример = str(ROOT / "examples" / "kitchen")
    описание = subprocess.run([sys.executable, "-c", _ОПИСАНИЕ, str(ROOT), пример],
                              capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert описание.returncode == 0, описание.stderr
    описано = json.loads(описание.stdout)

    ввод = {
        "rows": {
            "Label": [{"id": "k-l1", "name": "Срочно"}, {"id": "k-l2", "name": "Дом"}],
            "Task": [{"id": "k-t1", "title": "Первая"}, {"id": "k-t2", "title": "Вторая"}],
            # У первого контакта две заметки, у второго ни одной: без пустого
            # случая проверка прошла бы и на реализации, которая всегда
            # возвращает всё подряд.
            "Contact": [{"id": "k-c1", "name": "Первый"}, {"id": "k-c2", "name": "Второй"}],
            "Note": [{"id": "k-n1", "text": "раз", "contact": "k-c1"},
                     {"id": "k-n2", "text": "два", "contact": "k-c1"}],
        },
        "ops": ОПЕРАЦИИ, "probes": ЗАПРОСЫ, "queries": [],
        "schema": описано["schema"], "models": описано["models"],
    }
    готово = subprocess.run(["node", str(DRIVER)], input=json.dumps(ввод, ensure_ascii=False),
                            capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert готово.returncode == 0, готово.stderr
    assert готово.stderr.strip() == "", готово.stderr
    return json.loads(готово.stdout)


def test_a_link_table_is_named_from_the_schema(кухня):
    """Имя таблицы связи выводится, а не объявляется -- значит его надо видеть."""
    связи = [имя for имя, _sql in кухня["schema"] if имя.endswith("_rel")]
    assert связи, f"ни одной таблицы связи: {[и for и, _ in кухня['schema']]}"


def test_links_are_written_as_asked(кухня):
    """Обе записи связаны с той меткой, которую никто не удалял."""
    по_записи = {з["id"]: з["ids"] for з in кухня["relations"]}
    assert по_записи["k-t2"] == ["k-l2"]


def test_deleting_a_record_clears_the_links_that_pointed_at_it(кухня):
    """`k-l1` удалена -- её не должно остаться ни в одной связи.

    Вторая половина не менее важна: `k-l2` никто не удалял, и без неё проверка
    проходила бы и на реализации, которая чистит вообще всё.
    """
    по_записи = {з["id"]: з["ids"] for з in кухня["relations"]}
    assert all("k-l1" not in ids for ids in по_записи.values()), по_записи
    assert по_записи["k-t1"] == ["k-l2"], "уцелевшая связь пропала вместе с удалённой"


def test_one2many_reads_children_through_the_inverse_column(кухня):
    """Один-ко-многим читается обратной колонкой потомка, а не таблицей связи.

    Дорога своя, и сторожить её надо отдельно: сломанный `readOne2many` до
    21.08.2026 оставлял всю сюиту зелёной -- ни одна проверка не заметила бы,
    что список потомков стал пустым.
    """
    по_записи = {з["id"]: з["ids"] for з in кухня["relations"] if з["field"] == "notes"}
    assert sorted(по_записи["k-c1"]) == ["k-n1", "k-n2"], по_записи
    assert по_записи["k-c2"] == [], "у второго контакта заметок нет -- откуда взялись"


def test_one2one_is_a_column_with_a_unique_index(кухня):
    """Один-к-одному -- колонка у владельца плюс уникальный индекс.

    Без индекса один паспорт достаётся двоим, и заметно это становится не
    сразу. До 21.08.2026 индекс на устройстве не сторожил никто: снятый --
    и вся сюита зелёная.
    """
    #: Именно **уникальный**: на той же колонке живёт обычный индекс связи, и
    #: судить по одному имени нельзя -- первая редакция так и делала и мутацию
    #: не поймала.
    индексы = кухня["indexes"]["Contact"]
    assert any("passport_id" in и and признак for и, признак in индексы), индексы


def test_one2one_allows_exactly_one_owner(кухня):
    """И сама уникальность -- попыткой: схема схемой, а держит её база."""
    assert "UNIQUE" in (кухня["secondOwner"] or ""), кухня["secondOwner"]


def test_deleting_a_record_nulls_the_references_to_it(кухня):
    """Ссылка на удалённую запись обнуляется, а не остаётся висеть.

    Висячая ссылка показывает связь с записью, которой нет: экран рисует пустоту
    вместо имени, а причину видно только в базе. До 21.08.2026 правило на
    устройстве не сторожил никто -- снятое обнуление оставляло 690 зелёных
    проверок.
    """
    assert кухня["dangling"]["company"] is None, кухня["dangling"]


def test_running_ensure_schema_again_touches_no_ddl(кухня):
    """Второй заход обязан не тронуть схему -- и это дороже, чем «не упасть».

    `ensureSchema` приводит таблицу к объявлению пересозданием, а решает, надо
    ли, сверкой своего `CREATE TABLE` с тем, что запомнила SQLite -- слово в
    слово. Разойдись эти строки хоть пробелом -- и ошибки не будет: будет тихая
    переливка **всех** таблиц на каждом запуске, на каждом устройстве.

    Считает сама SQLite: `PRAGMA schema_version` растёт на любом DDL.
    """
    с = кухня["schemaVersion"]
    assert с["after"] == с["before"], f"второй заход тронул схему: {с}"

"""Журнал базы на устройстве: он обязан быть на диске.

Про `journal_mode = MEMORY` документация SQLite говорит без обиняков: если
приложение упало посреди транзакции, база «very likely go corrupt». На
устройстве в этой базе лежит единственная копия неотправленной работы --
цена падения несоизмерима с экономией на записи журнала.

Режим выбран замером, а не по документации. Проба на настоящем `opfs-sahpool`
в Chrome (300 транзакций на режим):

    delete    работает,  684 мс
    truncate  работает,  511 мс
    persist   работает,  525 мс
    memory    работает,  139 мс  -- журнала на диске нет
    wal       ОТКАЗ: PRAGMA возвращает `delete`, режим не меняется
    off       работает,  136 мс  -- журнала нет вовсе

WAL на этом VFS невозможен: разделяемой памяти у него нет. Взят `delete` --
умолчание SQLite и то, к чему VFS откатывается сам.

Здесь проверяется не проба, а её вывод: что `Database` ставит режим с журналом
на диске и что откат работает. База берётся файловая: у баз в памяти журнал
всегда `memory` и другим быть не может.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "journal_driver.mjs"

pytestmark = needs_node

#: Режимы, которые переживают падение посреди транзакции. `memory` и `off` --
#: не переживают, и это ровно то, что здесь нельзя пропустить.
DURABLE = {"delete", "truncate", "persist", "wal"}


def _run():
    done = subprocess.run(["node", str(DRIVER)], capture_output=True,
                          text=True, encoding="utf-8", cwd=ROOT)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def test_the_device_journal_is_on_disk():
    """Раньше здесь стоял `MEMORY`, и падение стоило бы всей базы целиком."""
    out = _run()
    assert out["mode"] in DURABLE, f"журнал без диска: {out['mode']}"


def test_a_transaction_that_fails_halfway_leaves_nothing_behind():
    """То, ради чего журнал и заводят: половина пакета не значит ничего."""
    assert _run()["rows"] == 1

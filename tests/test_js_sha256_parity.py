"""Отпечаток обязан совпадать с питоновским байт в байт.

По нему changeset узнают на другой стороне и по нему же решают, слать ли
определение. Разойдись стороны -- обмен не сломался бы с ошибкой, он молча
перестал бы узнавать своё.

Проверка заведена 20.08.2026, когда рукописный SHA-256 заменили на
``@noble/hashes``. До этого прямого сторожа у него не было: совпадение
доказывалось косвенно, отпечатками документов в ``test_three_languages.py``, --
то есть только на тех данных, что попадались. Здесь взяты пустая строка,
кириллица, нулевой байт и граница блока в 64 байта, вокруг которой видны
ошибки набивки.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

from conftest import needs_node

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "parity" / "sha256_driver.mjs"


@needs_node
def test_javascript_hashes_the_same_bytes_as_python():
    вывод = subprocess.run(
        ["node", str(DRIVER)], capture_output=True, text=True, check=True, cwd=ROOT,
    ).stdout
    их = json.loads(вывод)
    assert их, "драйвер не отдал ни одного отпечатка"
    for ключ, отпечаток in их.items():
        if ключ.startswith("байт:"):
            n = int(ключ.split(":")[1])
            байты = bytes((i * 7) % 256 for i in range(n))
        else:
            байты = ключ.encode("utf-8")
        assert отпечаток == hashlib.sha256(байты).hexdigest(), ключ

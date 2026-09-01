"""Разговор с компилятором на JS -- один процесс на всю сюиту.

Зачем это есть. Компилятор выражений и домена существовал в двух копиях:
питоновской (эталон) и той, что стоит на устройстве. Правила проверялись на
питоновской -- она была под рукой. Копия, которую правда исполняет
пользователь, при этом проверялась только сверкой «обе дали одно и то же»,
а это доказывает совпадение, а не верность.

Теперь правила спрашиваются у той копии, что едет на устройство. Питоновская
остаётся до своего удаления, но держателем правил быть перестала.

Почему процесс долгоживущий: запуск node -- около 80 мс, сама работа --
доли миллисекунды. На трёхстах утверждениях разница между «полминуты» и
«мгновенно», и это разница между сюитой, которую гоняют, и той, которую
перестают гонять.
"""

from __future__ import annotations

import atexit
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ХОСТ = ROOT / "tests" / "parity" / "rel_host.mjs"

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="нет node")

_процесс = None


class ОтказJs(Exception):
    """Отказ компилятора -- ответ, а не поломка: половина правил -- отказы."""

    def __init__(self, name, message):
        super().__init__(f"{name}: {message}")
        self.name = name
        self.message = message


def _хост():
    global _процесс
    if _процесс is None or _процесс.poll() is not None:
        _процесс = subprocess.Popen(
            ["node", str(ХОСТ)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", cwd=str(ROOT),
            bufsize=1,
        )
        atexit.register(_закрыть)
    return _процесс


def _закрыть():
    global _процесс
    if _процесс is not None and _процесс.poll() is None:
        _процесс.stdin.close()
        _процесс.wait(timeout=5)
    _процесс = None


def call(op, *args):
    """Спросить компилятор. Отказ приезжает исключением, а не значением.

    Смерть хоста тоже обязана быть слышной: пустая строка на чтении -- это
    закрытый канал, и молча вернуть ``None`` значило бы превратить «node упал»
    в «правило выполняется».
    """
    п = _хост()
    п.stdin.write(json.dumps({"op": op, "args": list(args)}, ensure_ascii=False) + "\n")
    п.stdin.flush()
    строка = п.stdout.readline()
    if not строка:
        оставшееся = п.stderr.read() if п.stderr else ""
        raise RuntimeError(f"Хост компилятора умер на {op}:\n{оставшееся}")
    ответ = json.loads(строка)
    if "error" in ответ:
        raise ОтказJs(ответ["error"]["name"], ответ["error"]["message"])
    return ответ["ok"]


def refusal(op, *args):
    """Слова отказа. Если компилятор не отказал -- это провал проверки."""
    try:
        got = call(op, *args)
    except ОтказJs as отказ:
        return отказ.message
    raise AssertionError(f"{op} не отказал, а ответил {got!r}")


#: Исходы и формы перевода -- строки, одинаковые с обеих сторон. Держатся
#: здесь, а не ввозятся из каркаса: сюита не должна зависеть от той половины,
#: которую этот переезд как раз и освобождает.
EXACT_NATIVE = "EXACT_NATIVE"
EXACT_ADAPTED = "EXACT_ADAPTED"
UNSUPPORTED = "UNSUPPORTED"
ROW_SCALAR = "ROW_SCALAR"
GROUPED = "GROUPED"
RECURSIVE = "RECURSIVE"


class Кусок:
    """Ответ компилятора полями, а не объектом с методами.

    По проводу едет словарь, но читается он как ``piece.sql`` -- так же, как
    читался объект. Иначе перенос свёлся бы к переписыванию каждого утверждения
    ради синтаксиса, и настоящие правки утонули бы в шуме.
    """

    def __init__(self, данные):
        self.__dict__.update(данные)
        # Списки в JSON, кортежи в питоне: сверять `("a",) == ["a"]` нельзя, а
        # различие здесь ничего не значит -- это одна и та же непустая пометка.
        for имя in ("missing", "reads"):
            if isinstance(getattr(self, имя, None), list):
                setattr(self, имя, tuple(getattr(self, имя)))
        # То же и внутри: отказы экрана -- словарь «поле -> чего не хватило».
        if isinstance(getattr(self, "unsupported", None), dict):
            self.unsupported = {к: tuple(з) if isinstance(з, list) else з
                                for к, з in self.unsupported.items()}

    def __repr__(self):
        return f"Кусок({self.__dict__})"


class AccessPath:
    """Требование пути доступа -- то же, что у компилятора, для сравнения.

    Сравнивается со словарём, который присылает JS: питоновский двойник нужен
    только чтобы утверждение читалось именем, а не россыпью ключей.
    """

    def __init__(self, table, prefix, reason, consumer):
        self.данные = {"table": table, "prefix": list(prefix),
                       "reason": reason, "consumer": consumer}

    def __eq__(self, другое):
        return self.данные == (другое.данные if isinstance(другое, AccessPath) else другое)

    def __repr__(self):
        return f"AccessPath({self.данные})"

    @property
    def prefix(self):
        return tuple(self.данные["prefix"])

    @property
    def table(self):
        return self.данные["table"]

    def satisfied_by(self, indexes):
        return call("access_satisfied", self.данные["table"],
                    self.данные["prefix"], [list(i) for i in indexes])

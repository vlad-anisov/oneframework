"""Обычный питон в теле формулы: считает верно либо отказывает словами.

Этот файл вырос из пробника, а не из головы. Пробник задавал один вопрос --
«что будет, если написать то, что питонист пишет не задумываясь» -- и на
53 записях ответил: восемь считались **молча неверно**, двадцать две
срывались питоновским `TypeError` с нашими внутренностями в тексте.

Третий разряд и есть причина файла. Молчание нельзя увидеть глазами: формула
считается, экран рисуется, неверным оказывается только число. Поэтому здесь у
каждой записи есть **ожидание, посчитанное питоном**, а не «лишь бы не упало».

Что нельзя перевести -- отказывает, и отказ проверяется по тексту: сообщение
обязано называть, чем это пишут вместо непереводимого.
"""

import copy as _copy
import sqlite3

import pytest

from oneframework import Boolean, Date, Integer, Many2one, Model, One2many, String
from oneframework.errors import DslError
from oneframework.model.expr import trace_formula
from oneframework.model.exprjson import to_json
from jsrel import call, needs_node

pytestmark = needs_node


class PyBoard(Model):
    _table = "board"
    name = String("Название")
    quota = Integer("Норма")
    tasks = One2many("PyTask", "board", "Задачи")

    def _норма_с_запасом(self):
        """Обычный метод модели: формула зовёт его, как звала бы в питоне."""
        return self.quota + 1


class PyTask(Model):
    _table = "task"
    board = Many2one(PyBoard, "Список")
    title = String("Название")
    done = Boolean("Выполнена")
    price = Integer("Цена")
    deadline = Date("Срок")


@pytest.fixture()
def db():
    """Настоящая SQLite с теми же функциями хоста, что стоят в приложении."""
    con = sqlite3.connect(":memory:")
    con.create_function("oneframework_zero_division", 0, _zero)
    con.create_function("oneframework_round", 1, lambda x: None if x is None else round(x))
    con.create_function("pylower", 1, lambda x: x if x is None else x.lower())
    con.create_function("pyupper", 1, lambda x: x if x is None else x.upper())
    con.create_function("pycasefold", 1, lambda x: x if x is None else x.casefold())
    con.executescript("""
        CREATE TABLE board(id TEXT PRIMARY KEY, name TEXT, quota INT);
        CREATE TABLE task(id TEXT PRIMARY KEY, board_id TEXT, title TEXT,
                          done INT, price INT, deadline TEXT);
        INSERT INTO board VALUES ('дом','Дом',2);
        INSERT INTO task VALUES ('t1','дом','Крыша',1,100,'2026-01-01'),
                                ('t2','дом','Забор',0,250,'2026-05-05'),
                                ('t3','дом','Гвозди',0,40,NULL);
    """)
    return con


def _zero():
    raise ZeroDivisionError("division by zero")


#: Описание моделей для стороны JS -- один раз: `makeModels` связывает модели
#: друг с другом, и пересборка на каждый вызов давала бы каждый раз новую связь.
СХЕМА = None


def значение(con, fn):
    """Значение формулы так, как его получит экран.

    SQL печатает компилятор с устройства, считает настоящая SQLite. Формула
    въезжает объявлением вычисляемого поля -- той самой дорогой, которой
    приложение и ходит: подзапрос по связи собирается только ею.
    """
    global СХЕМА
    if СХЕМА is None:
        import types as _types

        from oneframework.model.schema import app_schema

        СХЕМА = app_schema(_types.SimpleNamespace(models=[PyBoard, PyTask]))

    узел = to_json(trace_formula(fn, model=PyBoard))
    док = _copy.deepcopy(СХЕМА)
    доска = next(m for m in док["models"] if m["name"] == "PyBoard")
    доска["fields"].append({"name": "проба", "ftype": "integer",
                            "label": "Проба", "stored": False, "compute": узел})
    call("load_models", док)
    ответ = call("computed_columns_of", "PyBoard", "b")
    assert "проба" not in ответ["refused"], ответ["refused"]["проба"]
    sql = dict(ответ["columns"])["проба"]
    return con.execute(
        f'SELECT {sql} FROM board "b" WHERE "b".id = ?', ("дом",)).fetchone()[0]


# ==========================================================================
# считает -- и считает то же, что питон
# ==========================================================================
def числа_деление(self):
    return len(self.tasks) // 2


def числа_остаток(self):
    return len(self.tasks) % 2


def числа_остаток_отрицательного(self):
    """Знак остатка -- делителя, как в питоне, а не делимого, как в C.

    На положительных числах обе договорённости совпадают, и правило проходит
    непроверенным: замена перевода на голый `%` SQLite оставляла сюиту зелёной
    (проверено мутацией). Разошлись бы они только на отрицательном делимом --
    и разошлись бы молча, неверным числом на экране.
    """
    return -len(self.tasks) % 2


def числа_деление_отрицательного(self):
    """`//` в питоне округляет вниз, а не к нулю -- та же ловушка."""
    return -len(self.tasks) // 2


def числа_степень(self):
    return len(self.tasks) ** 2


def числа_минус(self):
    return -len(self.tasks)


def числа_модуль(self):
    return abs(-len(self.tasks))


def числа_округление(self):
    return round(sum(self.tasks.price) / 3, 2)


def числа_цел(self):
    return int(sum(self.tasks.price) / 3)


def сравнить_счёт(self):
    if len(self.tasks) > 2:
        return 1
    return 0


def сравнить_сумму(self):
    if sum(self.tasks.price) > 100:
        return 1
    return 0


def сравнить_арифметику(self):
    if len(self.tasks) * 100 / 3 > 50:
        return 1
    return 0


def сравнить_со_своим_полем(self):
    if len(self.tasks) > self.quota:
        return 1
    return 0


def цепочка(self):
    if 1 < len(self.tasks) < 5:
        return 1
    return 0


def пусто_ли(self):
    if self.name is None:
        return 0
    return 1


def входит_ли(self):
    if self.name in ("Дом", "Дача"):
        return 1
    return 0


def не_входит(self):
    if self.name not in ("Дача",):
        return 1
    return 0


def или_значением(self):
    return self.name or "без названия"


def и_значением(self):
    return len(self.tasks) and sum(self.tasks.price)


def регистр(self):
    return self.name.upper()


def склейка(self):
    return self.name + "!"


def f_строка(self):
    return f"{self.name}: {len(self.tasks)}"


def длина_строки(self):
    return len(self.name)


def начинается(self):
    if self.name.startswith("До"):
        return 1
    return 0


def замена(self):
    return self.name.replace("о", "а")


def генератор(self):
    return sum(task.price for task in self.tasks)


def генератор_с_условием(self):
    return sum(task.price for task in self.tasks if not task.done)


def есть_ли_такая(self):
    if any(task.done for task in self.tasks):
        return 1
    return 0


def все_ли(self):
    if all(task.price > 10 for task in self.tasks):
        return 1
    return 0


def все_ли_с_отбором(self):
    """Отбор и проверка -- разные вещи, и `all` отрицает **проверку**.

    Слей их в одно -- и вопрос стал бы «нет ли записи, которая не выполнена
    или дешевле десяти», то есть не про то.
    """
    if all(task.price > 10 for task in self.tasks if task.done):
        return 1
    return 0


def все_ли_нарушается(self):
    if all(task.price > 50 for task in self.tasks):
        return 1
    return 0


def сумма_проверок(self):
    return sum(task.done for task in self.tasks)


def точка_через_связь(self):
    return len(self.tasks.filtered(lambda task: task.board.name == "Дом"))


def свой_метод(self):
    return self._норма_с_запасом()


def через_elif(self):
    if len(self.tasks) == 0:
        return 0
    elif len(self.tasks) < 5:
        return 2
    else:
        return 3


def отбор_сравнением(self):
    return len(self.tasks.filtered(lambda task: task.price > 100))


def отбор_датой(self):
    return len(self.tasks.filtered(lambda task: task.deadline < "2026-03-01"))


def отбор_пустотой(self):
    return len(self.tasks.filtered(lambda task: task.deadline is None))


#: (формула, что дал бы питон на этих данных). Ожидание считается **питоном**,
#: а не списывается с того, что вернула база: иначе тест закреплял бы ошибку.
СЧИТАЕТ = [
    (числа_деление, 3 // 2),
    (числа_остаток, 3 % 2),
    (числа_остаток_отрицательного, -3 % 2),
    (числа_деление_отрицательного, -3 // 2),
    (числа_степень, 3 ** 2),
    (числа_минус, -3),
    (числа_модуль, abs(-3)),
    (числа_округление, round(390 / 3, 2)),
    (числа_цел, int(390 / 3)),
    (сравнить_счёт, 1),
    (сравнить_сумму, 1),
    (сравнить_арифметику, 1),
    (сравнить_со_своим_полем, 1),
    (цепочка, 1),
    (пусто_ли, 1),
    (входит_ли, 1),
    (не_входит, 1),
    (или_значением, "Дом"),
    (и_значением, 390),
    (регистр, "Дом".upper()),
    (склейка, "Дом" + "!"),
    (f_строка, f"{'Дом'}: {3}"),
    (длина_строки, len("Дом")),
    (начинается, 1),
    (замена, "Дом".replace("о", "а")),
    (генератор, 100 + 250 + 40),
    (генератор_с_условием, 250 + 40),
    (есть_ли_такая, 1),
    (все_ли, 1),
    (все_ли_с_отбором, 1),      # выполнена одна, её цена 100 -- больше десяти
    (все_ли_нарушается, 0),     # сорок меньше пятидесяти
    (сумма_проверок, 1),        # истина в питоне единица, сумма их -- счёт
    (точка_через_связь, 3),
    (свой_метод, 2 + 1),
    (через_elif, 2),
    (отбор_сравнением, 1),
    (отбор_датой, 1),
    (отбор_пустотой, 1),
]


@pytest.mark.parametrize("fn,ожидание", СЧИТАЕТ, ids=lambda v: getattr(v, "__name__", ""))
def test_plain_python_in_a_formula_answers_what_python_answers(db, fn, ожидание):
    """Написано питоном -- посчитано как питоном. Без «почти»."""
    assert значение(db, fn) == ожидание


def test_the_probe_covers_more_than_a_handful():
    """Тридцать с лишним записей -- не три.

    Все три поломки этого дня жили при зелёных тестах ровно потому, что корпус
    проверял написанное мной, а не написанное человеком.
    """
    assert len(СЧИТАЕТ) >= 30


# ==========================================================================
# отказывает -- и отказ называет, чем это пишут вместо непереводимого
# ==========================================================================
def перебор(self):
    итог = 0
    for task in self.tasks:
        итог = итог + task.price
    return итог


def первая(self):
    return self.tasks[0].price


def срез(self):
    return len(self.tasks[:2])


def упорядочить(self):
    return sorted(self.tasks.price)[0]


def сложить_записи(self):
    return sum(self.tasks)


def отказ_по_условию(self):
    if len(self.tasks) < 0:
        raise ValueError("не бывает")
    return 1


def перехват(self):
    try:
        return len(self.tasks) // 0
    except ZeroDivisionError:
        return 1


def опечатка_в_колонке(self):
    return sum(self.tasks.prcie)


def опечатка_через_связь(self):
    return len(self.tasks.filtered(lambda task: task.board.nmae == "Дом"))


def выражение_в_генераторе(self):
    return sum(task.price * 2 for task in self.tasks)


ОТКАЗЫВАЕТ = [
    (перебор, "не перебирается"),
    (первая, "ни первой, ни срезов"),
    (срез, "ни первой, ни срезов"),
    (упорядочить, "не перебирается"),
    (сложить_записи, "назовите колонку точкой"),
    (отказ_по_условию, "не умеет отказывать"),
    (перехват, "внутри `try`"),
    (опечатка_в_колонке, "нет поля «prcie»"),
    (опечатка_через_связь, "нет поля «nmae»"),
    (выражение_в_генераторе, "берут одно поле"),
]


@pytest.mark.parametrize("fn,кусок", ОТКАЗЫВАЕТ, ids=lambda v: getattr(v, "__name__", ""))
def test_what_cannot_be_translated_says_so_and_says_what_to_write(fn, кусок):
    """Отказ -- словами и с заменой, а не питоновским `TypeError`."""
    with pytest.raises(DslError, match=кусок):
        trace_formula(fn, model=PyBoard)


def test_python_words_outside_a_record_still_mean_python_things(db):
    """`len`, `sum`, `min`, `max`, `str` не про запись -- обычный питон."""
    def обычные(self):
        return len("абв") + sum([1, 2]) + min(5, 1) + max(2, 3) + int("4")

    assert trace_formula(обычные, model=PyBoard) == 3 + 3 + 1 + 3 + 4


# ==========================================================================
# сторонние библиотеки: над постоянными -- да, над записью -- нет
# ==========================================================================
def постоянная_из_библиотеки(self):
    """`math` над числом считается на сборке и уезжает числом."""
    import math

    return len(self.tasks) * math.sqrt(16)


def библиотека_над_записью(self):
    import math

    return math.sqrt(len(self.tasks))


def морфология_в_формуле(self):
    """Словарная морфология прямо в вычисляемом поле -- частое желание."""
    import pymorphy3

    morph = pymorphy3.MorphAnalyzer()
    return morph.parse(self.name)[0].normal_form


def test_a_dictionary_library_in_a_compute_says_where_it_belongs():
    """`pymorphy3` в формуле не заработает, и отказ обязан сказать почему.

    Формула читается **один раз, на сборке**: названия в этот момент ещё нет,
    есть вопрос к базе. Замерено на настоящей pymorphy3: до этой правки наружу
    выходило «object of type 'Arith' has no len()» -- имя нашего класса вместо
    объяснения.
    """
    pytest.importorskip("pymorphy3")
    with pytest.raises(DslError, match="настоящая строка|настоящее значение"):
        trace_formula(морфология_в_формуле, model=PyBoard)


def сегодняшняя_дата(self):
    import datetime

    сегодня = datetime.date.today().isoformat()
    return len(self.tasks.filtered(lambda task: task.deadline < сегодня))


def test_a_library_over_a_constant_is_computed_at_build_and_travels_as_a_number(db):
    """Тело читается один раз, и всё, что не про запись, там обычный питон."""
    assert значение(db, постоянная_из_библиотеки) == 3 * 4.0


def test_a_library_over_a_record_says_why_it_cannot(db):
    """Питон отвечал своим `TypeError: must be real number, not Count`.

    Имя внутреннего класса пользователю не говорит ничего; отказ обязан
    называть причину -- значения ещё нет, его посчитает база.
    """
    with pytest.raises(DslError, match="нужно настоящее значение"):
        trace_formula(библиотека_над_записью, model=PyBoard)


def test_todays_date_in_a_formula_is_refused_because_it_would_be_baked():
    """`date.today()` внутри формулы -- дата **сборки**, а не показа.

    Считается один раз, значит запеклась бы навсегда: ни ошибки, ни следа,
    неверным было бы только число. Худший разряд, и потому отказ.
    """
    with pytest.raises(DslError, match="время \\*\\*сборки\\*\\*"):
        trace_formula(сегодняшняя_дата, model=PyBoard)


def цепочка_строковых(self):
    """`слово.lower().endswith(...)` -- с этого начинается любой разбор слова.

    Обрывалось на втором звене: у выражения методов строки не было, и наружу
    выходило `'Arith' object has no attribute 'endswith'` -- имя нашего класса
    вместо объяснения.
    """
    if self.name.lower().endswith("м"):
        return 1
    return 0


def срез_строки(self):
    return self.name[:2]


def test_string_methods_chain_on_an_expression_too(db):
    assert значение(db, цепочка_строковых) == int("Дом".lower().endswith("м"))


def test_a_slice_is_refused_because_the_two_sides_count_differently():
    """У питона и у SQL срез с конца считается по-разному -- лучше отказ."""
    with pytest.raises(DslError, match="срез и обращение по номеру"):
        trace_formula(срез_строки, model=PyBoard)


def плоская_функция(слово):
    """Обычная функция питона -- **не** метод модели."""
    if слово.lower().endswith("а"):
        return 1
    return 0


def через_плоскую_функцию(self):
    return плоская_функция(self.name)


def test_a_plain_function_called_from_a_formula_says_why_its_if_ran_too_early():
    """Разбирается тело формулы и методы модели, а не всё подряд.

    Функция снаружи выполняется как обычный питон, и её `if` требует ответа
    сразу. Отказ обязан назвать и причину, и замену -- метод модели.
    """
    with pytest.raises(DslError, match="не разбирается"):
        trace_formula(через_плоскую_функцию, model=PyBoard)

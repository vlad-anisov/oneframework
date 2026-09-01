"""Тело формулы -- обычный питон, и читается один раз, на сборке.

Проверяется здесь не «получился ли JSON», а то, что **написанное питоном
и выполненное питоном дают один ответ**. Поэтому каждая форма прогоняется
дважды: через настоящую SQLite и через тот же метод, вызванный обычным
питоном на обычных числах. Расхождение значило бы, что язык только выглядит
питоном -- худший вид расхождения, потому что заметить его на глаз нельзя.

Отдельный повод для этого файла -- `if` отдельной строкой. Ветвление
записывается, а не выполняется, и цена ошибки тут молчаливая: формула
`if self.total:` при неверной трассировке не падает, а **всегда** берёт
первую ветку. Именно это здесь и ловится, ветка за веткой.
"""

import copy
import sqlite3

import pytest

from oneframework import Boolean, Integer, Many2one, Model, One2many, String
from oneframework.errors import DslError
from oneframework.model.expr import RelatedSet, trace_formula
from oneframework.model.exprjson import to_json
from jsrel import call, needs_node

pytestmark = needs_node


def _boom(*_args):
    raise ZeroDivisionError("division by zero")


@pytest.fixture()
def db():
    con = sqlite3.connect(":memory:")
    con.create_function("oneframework_zero_division", 0, _boom)
    con.create_function("oneframework_round", 1, lambda x: None if x is None else round(x))
    con.executescript("""
        CREATE TABLE t(id TEXT PRIMARY KEY, done INT, total INT, sequence INT);
        INSERT INTO t VALUES ('полный', 3, 4, 2), ('пустой', 0, 0, 5);
    """)
    return con


@pytest.fixture()
def boards():
    """Две модели со связью -- на них проверяется набор.

    Считает здесь настоящая SQLite тем же подзапросом, что уедет в приложение:
    проверять запись формулы, не исполнив её, значило бы проверять текст.
    """
    con = sqlite3.connect(":memory:")
    con.create_function("oneframework_zero_division", 0, _boom)
    con.create_function("oneframework_round", 1, lambda x: None if x is None else round(x))
    con.executescript("""
        CREATE TABLE board(id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE task(id TEXT PRIMARY KEY, board_id TEXT, done INT, price INT);
        INSERT INTO board VALUES ('дом','Дом'),('пусто','Пусто');
        INSERT INTO task VALUES ('t1','дом',1,100),('t2','дом',0,250),
                                ('t3','дом',0,40);
    """)
    return con


def value_of(con, fn, row):
    """Значение формулы так, как его получит экран.

    Печатает SQL тот компилятор, что стоит на устройстве; считает настоящая
    SQLite. Разделение намеренное: перевод формулы и её смысл -- разные вопросы,
    и второй решается только исполнением.
    """
    piece = call("compile_expr", to_json(trace_formula(fn)))
    got = con.execute(f'SELECT {piece["sql"]} FROM t "t" WHERE "t".id = ?', (row,))
    return got.fetchone()[0]


class Строка:
    """Обычная запись обычным питоном -- вторая половина сверки."""

    def __init__(self, done, total, sequence):
        self.done, self.total, self.sequence = done, total, sequence


ПОЛНЫЙ = Строка(3, 4, 2)
ПУСТОЙ = Строка(0, 0, 5)


# ==========================================================================
# `if` отдельной строкой
# ==========================================================================
def охрана(self):
    """Ранний выход -- та форма, которой написан модуль."""
    total = self.total
    if not total:
        return 0
    done = self.done
    return round(done * 100 / total)


def с_else(self):
    if self.total:
        return 1
    else:
        return 0


def вложенный(self):
    if self.total:
        if self.done:
            return 1
        return 2
    return 3


def с_циклом(self):
    итог = 0
    for вес in (1, 10):
        итог = итог + self.sequence * вес
    if self.total:
        return итог
    return 0


def с_and(self):
    if self.total and self.done:
        return 1
    return 0


def с_or(self):
    if self.total or self.done:
        return 1
    return 0


ФОРМЫ = [охрана, с_else, вложенный, с_циклом, с_and, с_or]


@pytest.mark.parametrize("fn", ФОРМЫ, ids=lambda f: f.__name__)
def test_the_formula_answers_what_plain_python_answers(db, fn):
    """Тот же метод, вызванный питоном на числах, даёт тот же ответ."""
    assert value_of(db, fn, "полный") == fn(ПОЛНЫЙ)
    assert value_of(db, fn, "пустой") == fn(ПУСТОЙ)


def test_both_branches_are_actually_reachable(db):
    """Ветвление записалось, а не выполнилось на сборке.

    Без этого `if self.total:` тихо брало бы первую ветку всегда -- формула
    считалась бы, экран рисовался бы, и неверным было бы только число.
    """
    for fn in ФОРМЫ:
        ответы = {value_of(db, fn, "полный"), value_of(db, fn, "пустой")}
        assert len(ответы) == 2, f"{fn.__name__}: обе строки дали {ответы}"


def test_the_guard_saves_from_division_by_zero(db):
    """Пустой список: до деления дело не доходит, как и в питоне."""
    assert value_of(db, охрана, "пустой") == 0
    assert охрана(ПУСТОЙ) == 0


def test_an_assignment_after_the_branch_is_kept(db):
    """`done = ...` стоит **после** `if` -- и не теряется.

    Именно эта строка и терялась: всё после первого ветвления уходило в
    выражение, а предложению там места нет.
    """
    assert value_of(db, охрана, "полный") == 75


def test_a_loop_before_the_branch_runs_at_build_time(db):
    """Обычный питон до ветвления выполняется как обычный питон."""
    assert value_of(db, с_циклом, "полный") == 2 * 1 + 2 * 10


# ==========================================================================
# отказы: с именем и с подсказкой, что дописать
# ==========================================================================
def без_второй_ветки(self):
    if self.total:
        return 1


def без_возврата(self):
    total = self.total


def пустой_возврат(self):
    if self.total:
        return


def хвост_без_возврата(self):
    if self.total:
        return 1
    итог = 2


def цикл_после_ветки(self):
    if self.total:
        return 1
    for вес in (1, 2):
        pass
    return 0


def test_a_missing_second_branch_is_refused_by_name():
    with pytest.raises(DslError, match="второй ветки"):
        trace_formula(без_второй_ветки)


def test_a_formula_that_returns_nothing_is_refused():
    with pytest.raises(DslError, match="ничего не возвращает"):
        trace_formula(без_возврата)


def test_a_bare_return_is_refused():
    with pytest.raises(DslError, match="без значения"):
        trace_formula(пустой_возврат)


def test_a_tail_without_return_says_which_path_has_no_value():
    with pytest.raises(DslError, match="при любом условии"):
        trace_formula(хвост_без_возврата)


def test_a_statement_that_cannot_be_written_names_itself():
    """Цикл после ветвления: отказ называет предложение и куда его перенести."""
    with pytest.raises(DslError, match="`for` после ветвления"):
        trace_formula(цикл_после_ветки)


# ==========================================================================
# набор связанных записей: питон, а не свой словарь
# ==========================================================================
#: Имена **свои**: реестр моделей общий на прогон, и «Board» уже занят
#: соседними файлами. Таблицы при этом обычные -- их создаёт сюда фикстура.
class FormulaBoard(Model):
    _table = "board"
    name = String("Название")
    quota = Integer("Норма")
    tasks = One2many("FormulaTask", "board", "Задачи")


class FormulaTask(Model):
    _table = "task"
    board = Many2one(FormulaBoard, "Список")
    done = Boolean("Выполнена")
    price = Integer("Цена")


#: Описание моделей для стороны JS. Собирается один раз: связь между моделями
#: устанавливает `makeModels`, и пересборка на каждый вызов давала бы каждый
#: раз новую связь -- то есть проверяла бы не то, что живёт на устройстве.
СХЕМА = None


def _column_sql(node, alias="b"):
    """Формула -> текст колонки, напечатанный компилятором с устройства.

    Формула въезжает **объявлением вычисляемого поля**, а не отдельным вызовом:
    подзапрос по связи собирается именно этой дорогой, и звать его половину
    в обход значило бы проверять путь, которым приложение не ходит.
    """
    global СХЕМА
    if СХЕМА is None:
        import types as _types

        from oneframework.model.schema import app_schema

        СХЕМА = app_schema(_types.SimpleNamespace(models=[FormulaBoard, FormulaTask]))

    док = copy.deepcopy(СХЕМА)
    доска = next(m for m in док["models"] if m["name"] == "FormulaBoard")
    доска["fields"].append({"name": "проба", "ftype": "integer",
                            "label": "Проба", "stored": False, "compute": node})
    call("load_models", док)
    ответ = call("computed_columns_of", "FormulaBoard", alias)
    assert "проба" not in ответ["refused"], ответ["refused"]["проба"]
    return dict(ответ["columns"])["проба"]


def board_value(con, fn, row):
    """Значение формулы так, как его получит экран: колонкой той же выборки."""
    node = to_json(trace_formula(fn, model=FormulaBoard))
    sql = _column_sql(node)
    got = con.execute(f'SELECT {sql} FROM board "b" WHERE "b".id = ?', (row,))
    return got.fetchone()[0]


def сколько(self):
    return len(self.tasks)


def сколько_выполненных(self):
    return len(self.tasks.filtered(lambda task: task.done))


def сумма(self):
    return sum(self.tasks.price)


def сумма_невыполненных(self):
    return sum(self.tasks.filtered(lambda task: not task.done).price)


def дешевле_всего(self):
    return min(self.tasks.price)


def дороже_всего(self):
    return max(self.tasks.price)


def дешевле_всего_или_ноль(self):
    return min(self.tasks.price, default=0)


def есть_ли(self):
    if self.tasks:
        return 1
    return 0


def нет_ни_одной(self):
    if not self.tasks:
        return 1
    return 0


@pytest.mark.parametrize("fn,дом,пусто", [
    (сколько, 3, 0),
    (сколько_выполненных, 1, 0),
    # `sum([])` в питоне -- ноль, а не «неизвестно»; SQL отдал бы NULL, и на
    # экране это было бы пустой клеткой, похожей на ответ.
    (сумма, 390, 0),
    (сумма_невыполненных, 290, 0),
    # У `min`/`max` умолчания нет и в питоне -- пока не написали `default=`.
    (дешевле_всего, 40, None),
    (дороже_всего, 250, None),
    (дешевле_всего_или_ноль, 40, 0),
    (есть_ли, 1, 0),
    (нет_ни_одной, 0, 1),
], ids=lambda v: getattr(v, "__name__", str(v)))
def test_a_set_speaks_plain_python(boards, fn, дом, пусто):
    """`len`, `sum`, `min`, `max` и `if` -- те самые, из питона.

    Своих `count()`, `exists()` и `mapped()` нет намеренно: каждое такое слово
    пришлось бы выучить отдельно, а выучено уже всё.
    """
    assert board_value(boards, fn, "дом") == дом
    assert board_value(boards, fn, "пусто") == пусто


def test_a_column_is_taken_with_a_dot_not_a_word(boards):
    """`self.tasks.price` -- то же, что `mapped('price')`, но без нового слова."""
    node = to_json(trace_formula(сумма, model=FormulaBoard))
    assert node == {"agg": "sum", "model": "FormulaTask", "via": "board",
                    "of": {"r": "price"}}


def test_a_filter_and_a_column_compose(boards):
    """Отбор и колонка складываются, и порядок записи -- питоновский."""
    node = to_json(trace_formula(сумма_невыполненных, model=FormulaBoard))
    assert node["agg"] == "sum" and node["of"] == {"r": "price"}
    assert node["domain"] == {"op": "!", "e": {"r": "done"}}


def test_the_default_of_min_is_the_python_one(boards):
    """`default=` -- слово питона, и значит здесь ровно то же, что там."""
    node = to_json(trace_formula(дешевле_всего_или_ноль, model=FormulaBoard))
    # Число едет числом: и запись выражения, и компилятор принимают его как есть.
    assert node["on_empty"] == 0
    assert board_value(boards, дешевле_всего_или_ноль, "пусто") == 0


def минимум_с_ключом(self):
    return min(self.tasks.price, key=lambda x: x)


def test_a_sort_key_is_refused_by_name():
    """`key=` базе передать нечем -- отказ называет, почему."""
    with pytest.raises(DslError, match="ключа для сортировки"):
        trace_formula(минимум_с_ключом, model=FormulaBoard)


def суммировать_записи(self):
    return sum(self.tasks)


def test_summing_records_says_what_is_missing():
    """Складывать записи нечего -- отказ называет, чего не хватает."""
    with pytest.raises(DslError, match="назовите колонку точкой"):
        trace_formula(суммировать_записи, model=FormulaBoard)


def test_a_set_refuses_to_pretend_it_is_true_outside_a_formula():
    """`if <набор>:` вне формулы -- отказ, а не молчаливое `True`.

    Молчаливое `True` означало бы «всегда первая ветка»: формула считается,
    экран рисуется, и неверно только число.
    """
    with pytest.raises(DslError, match="только внутри формулы"):
        bool(RelatedSet("Task", "board"))
    with pytest.raises(DslError, match="только внутри формулы"):
        len(RelatedSet("Task", "board"))


def test_python_words_still_mean_python_things():
    """`len`, `sum`, `min`, `max` не про набор -- обычный питон."""
    def обычные(self):
        return len("абв") + sum([1, 2]) + min(5, 1) + max(2, 3)

    assert trace_formula(обычные, model=FormulaBoard) == 3 + 3 + 1 + 3


def опечатка_в_колонке(self):
    return sum(self.tasks.prcie)


def test_a_mistyped_column_is_refused_with_a_suggestion():
    """Опечатка -- отказ на сборке, а не сломанный запрос у пользователя."""
    with pytest.raises(DslError, match="нет поля «prcie»") as e:
        trace_formula(опечатка_в_колонке, model=FormulaBoard)
    assert "price" in str(e.value)


# ==========================================================================
# три поломки, найденные пробой обычного питона 17.08.2026
# ==========================================================================
def дороже_сотни(self):
    return len(self.tasks.filtered(lambda task: task.price > 100))


def test_a_comparison_inside_filtered_compiles(boards):
    """Сравнение пишется по-домённому (`l`/`r`), и выборка обязана это читать.

    До правки любое `>` внутри `filtered` валилось голым `IndexError`: три
    записи из четырёх компилятор выучил утром (`!`, `&`, `|`), а сравнение --
    самое частое из них -- осталось невыученным, потому что ни одна формула в
    корпусе его не содержала.
    """
    assert board_value(boards, дороже_сотни, "дом") == 1


def имя_как_условие(self):
    if self.name:
        return 1
    return 0


def test_a_text_field_is_true_when_it_is_not_empty(boards):
    """`if self.name:` -- питон говорит «да» у непустой строки.

    SQLite в `CASE WHEN 'Дом'` приводит текст к числу и говорит «нет». До
    правки формула всегда уходила во вторую ветку: ни ошибки, ни следа --
    неверным было только число на экране.
    """
    boards.execute("UPDATE board SET name = 'Дом' WHERE id = 'дом'")
    boards.execute("UPDATE board SET name = '' WHERE id = 'пусто'")
    assert board_value(boards, имя_как_условие, "дом") == 1
    assert board_value(boards, имя_как_условие, "пусто") == 0


def test_truthiness_matches_python_value_by_value(boards):
    """Построчно: ноль, пустая строка и пустота -- ложь, остальное -- истина."""
    for литерал, питон in [("'Дом'", True), ("''", False), ("0", False), ("5", True),
                           ("0.0", False), ("NULL", False), ("'0'", True), ("-1", True)]:
        piece = call("compile_expr", {"op": "if", "args": [{"const": None}, 1, 0]})
        sql = piece["sql"].replace("NULL", литерал, 1)
        assert bool(boards.execute(f"SELECT {sql}").fetchone()[0]) is питон, литерал


def сколько_плюс_своё(self):
    return len(self.tasks) + self.quota


def test_an_own_field_next_to_an_aggregate_reads_its_own_table(boards):
    """Поле самой записи рядом с агрегатом -- из **своей** таблицы.

    Худшая из трёх: подзапрос идёт по связанной модели, и без пометки поле
    читалось оттуда же. Совпади имя у обеих моделей -- и на экране молча
    оказывалось чужое число (замерено: 9 вместо 1002).
    """
    boards.execute("ALTER TABLE board ADD COLUMN quota INT")
    boards.execute("ALTER TABLE task ADD COLUMN quota INT")
    boards.execute("UPDATE board SET quota = 1000")
    boards.execute("UPDATE task SET quota = 7")
    assert board_value(boards, сколько_плюс_своё, "дом") == 1003

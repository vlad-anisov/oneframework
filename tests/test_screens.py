"""Top-level destinations: one navigation stack each."""

import pytest

from oneframework import (
    App, Boolean, Button, Create, Date, List, Model, Row, Screen, String, Tab,
    Tabs, View,
)
from jsrt import ОтказJs, Рантайм, needs_node
from oneframework.model.exprjson import to_json
from oneframework.errors import DslError

pytestmark = needs_node


def _stack(snap):
    """Стек активного раздела. Отдельного ключа ``stack`` в снимке нет."""
    return snap["stacks"][snap["active"]]



class Note(Model):
    title = String("Title", required=True)
    done = Boolean("Done")


class Person(Model):
    name = String("Name", required=True)


class NoteItem(View):
    model = Note

    def ui(self, record):
        return Row(record.title(widget="title"))


class NoteDetail(View):
    model = Note

    def ui(self, record):
        return (record.title(), record.done())


class Notes(View):
    def ui(self, record):
        return (List(Note, item=NoteItem, open=NoteDetail),)


class PersonItem(View):
    model = Person

    def ui(self, record):
        return Row(record.name(widget="title"))


class People(View):
    def ui(self, record):
        return (List(Person, item=PersonItem),)


class Board(View):
    def ui(self, record):
        return (
            Button("Быстро", action=Note.create(open=NoteDetail, target="sheet")),
            Button("Медленно", action=Note.create(open=NoteDetail)),
        )


class NoteRow(View):
    model = Note

    def ui(self, record):
        return Row(record.title(widget="title"),
                   record.done(widget="checkbox", visible=record.done))


class Ledger(View):
    def ui(self, record):
        return (List(Note, item=NoteRow),)


class Sections(View):
    def ui(self, record):
        return (Tabs(
            Tab("Свои",
                Button(place="fab",
                       action=Note.create(values={"title": "Из вкладки"})),
                List(Note, item=NoteItem)),
            Tab("Чужие", List(Person, item=PersonItem)),
        ),)


#: Рантайм -- тот, что стоит на устройстве. Подъёмник, а не готовый рантайм:
#: почти каждая проверка здесь объявляет **своё** приложение, и общего нет.
@pytest.fixture()
def поднять():
    открытые = []

    def сделать(прил, seed=None):
        r = Рантайм(прил, seed=seed)
        открытые.append(r)
        return r

    yield сделать
    for r in открытые:
        r.close()


@pytest.fixture
def app():
    return App(
        Screen(Notes, label="Заметки", icon="doc"),
        Screen(People, label="Люди", icon="people"),
        title="Two",
    )


def test_screens_keep_declaration_order(app):
    assert [s.key for s in app.screens] == ["Notes", "People"]
    assert [s.label for s in app.screens] == ["Заметки", "Люди"]
    assert [s.icon for s in app.screens] == ["doc", "people"]


def test_meta_exposes_screens(app, поднять):
    поднять(app)
    assert app.meta()["screens"][1] == {
        "key": "People", "label": "Люди", "icon": "people", "view": "People",
        "master_detail": True,
    }


#: Объявлен на уровне модуля, а не в теле проверки: выкладка ищет виды в
#: пространстве имён модуля (`_defined_in`), и класс из функции не поедет.
class Grid(View):
    def ui(self, record):
        return (List(Note, item=NoteItem, open=NoteDetail, display="table"),)


def test_a_table_screen_opts_out_of_the_split(поднять):
    """Список-таблица просит всю ширину, и запись открывается страницей.

    Спрашивается **снимок**, а не объявление. Раскладку решает нарисованное
    дерево -- «единственное место, где дерево вообще существует», -- а дерево
    есть только у того, кто рисует. Питоновский `Screen.master_detail()` знал
    это и спрашивал живой рантайм; с уходом эталона спрашивать ему стало
    некого, и до 21.08.2026 проверка молча получала бы умолчание `True`.
    """
    rt = поднять(App(Screen(Grid), title="Grid"))
    assert rt.snapshot()["screens"][0]["master_detail"] is False


def test_sequence_overrides_declaration_order():
    a = App(Screen(People, sequence=20), Screen(Notes, sequence=10), title="Ordered")
    assert [s.key for s in a.screens] == ["Notes", "People"]


def test_every_screen_boots_with_its_own_stack(app, поднять):
    rt = поднять(app)
    assert rt.active == "Notes"
    assert set(rt.stacks) == {"Notes", "People"}
    assert all(len(stack) == 1 for stack in rt.stacks.values())
    snap = rt.snapshot()
    assert snap["active"] == "Notes"
    assert snap["stacks"][snap["active"]][0]["view"] == "Notes"
    assert snap["stacks"]["People"][0]["view"] == "People"


def _open_first_note(rt):
    record = rt.db.create(Note, {"title": "N"})
    rt.touch(Note)
    list_id = _stack(rt.snapshot())[0]["children"][0]["id"]
    rt.dispatch({"type": "open", "list_id": list_id, "record_id": record})


def test_switching_keeps_each_stack_where_it_was(app, поднять):
    rt = поднять(app)
    _open_first_note(rt)
    assert len(rt.stacks["Notes"]) == 2

    snap = rt.dispatch({"type": "switch_screen", "key": "People"})
    assert snap["active"] == "People"
    assert snap["depth"] == 1
    assert len(rt.stacks["Notes"]) == 2      # the other section is untouched

    snap = rt.dispatch({"type": "switch_screen", "key": "Notes"})
    assert snap["depth"] == 2                # ...and comes back where it was


def test_back_applies_to_the_active_section(app, поднять):
    rt = поднять(app)
    _open_first_note(rt)

    rt.dispatch({"type": "switch_screen", "key": "People"})
    rt.dispatch({"type": "back"})            # People is already at its root
    assert len(rt.stacks["People"]) == 1
    assert len(rt.stacks["Notes"]) == 2

    rt.dispatch({"type": "switch_screen", "key": "Notes"})
    rt.dispatch({"type": "back"})
    assert len(rt.stacks["Notes"]) == 1


def test_a_list_in_a_hidden_section_still_resolves(app, поднять):
    """Events name a list, not a section; the runtime finds it either way."""
    rt = поднять(app)
    people_list = rt.snapshot()["stacks"]["People"][0]["children"][0]["id"]
    rt.dispatch({"type": "switch_screen", "key": "People"})
    найдено = rt.find_list(people_list)
    assert найдено["view"] == "People", найдено


def test_unknown_screen_is_rejected(app, поднять):
    rt = поднять(app)
    with pytest.raises(Exception) as excinfo:
        rt.dispatch({"type": "switch_screen", "key": "Nope"})
    assert "Nope" in str(excinfo.value)


def test_back_to_snaps_the_stack_to_the_level_it_names(app, поднять):
    """Крошка называет уровень -- снимается всё, что лежит поверх него.

    Разом, а не по кадру: десять раз посланное `back` -- это десять снимков и
    десять переходов маршрутизатора там, где человек нажал один раз.
    """
    rt = поднять(app)
    record = rt.db.create(Note, {"title": "N"})
    rt.touch(Note)
    list_id = _stack(rt.snapshot())[0]["children"][0]["id"]
    for _ in range(3):
        rt.dispatch({"type": "open", "list_id": list_id, "record_id": record})
    root, second = (f.id for f in rt.stacks["Notes"][:2])
    assert len(rt.stacks["Notes"]) == 4

    snap = rt.dispatch({"type": "back_to", "screen_id": second})
    assert [f.id for f in rt.stacks["Notes"]] == [root, second]
    assert snap["depth"] == 2

    # Тот же уровень второй раз -- ничто. Ссылки у звена «здесь» нет, но
    # безобидным событие обязано быть и так: между снимком и нажатием лежит
    # круг через воркер.
    rt.dispatch({"type": "back_to", "screen_id": second})
    assert [f.id for f in rt.stacks["Notes"]] == [root, second]

    rt.dispatch({"type": "back_to", "screen_id": root})
    assert [f.id for f in rt.stacks["Notes"]] == [root]


def test_back_to_refuses_a_frame_that_is_not_in_the_stack(app, поднять):
    """Ключ кадра рендерер берёт из того же снимка, что и всё остальное.

    Значит чужой ключ -- не устаревшая ссылка (тем занят ``goto``, туда адрес
    приходит снаружи), а ошибка отправителя. Молчание о ней читалось бы как
    «нажал, и ничего не произошло», и объяснить это было бы нечем.
    """
    rt = поднять(app)
    _open_first_note(rt)
    elsewhere = rt.stacks["People"][0].id

    with pytest.raises(Exception) as excinfo:
        rt.dispatch({"type": "back_to", "screen_id": elsewhere})
    assert elsewhere in str(excinfo.value)
    assert len(rt.stacks["Notes"]) == 2       # и ничего не снялось


def test_goto_walks_straight_to_the_record(app, поднять):
    """Глубокая ссылка: адрес называет место, рантайм его открывает."""
    rt = поднять(app)
    note = rt.db.create(Note, {"title": "N"})
    rt.touch(Note)

    snap = rt.dispatch({"type": "goto", "screen": "Notes",
                        "path": [{"view": "NoteDetail", "record_id": note}]})
    assert snap["active"] == "Notes"
    assert [f["view"] for f in _stack(snap)] == ["Notes", "NoteDetail"]
    assert _stack(snap)[1]["record_id"] == note


def test_goto_brings_its_own_section_forward(app, поднять):
    rt = поднять(app)
    snap = rt.dispatch({"type": "goto", "screen": "People", "path": []})
    assert snap["active"] == "People"
    assert len(rt.stacks["Notes"]) == 1


def test_goto_keeps_the_frames_the_address_already_describes(app, поднять):
    """Совпавшее начало остаётся тем же кадром, а не таким же.

    Кадр помнит, что человек в нём делал: фильтр, сортировку, окно списка.
    Пересобранный заново он показал бы ту же запись с начала, и «назад»
    браузера читалось бы как «сбросить». Ключ кадра -- то, чем это видно.
    """
    rt = поднять(app)
    _open_first_note(rt)
    opened = rt.stacks["Notes"][1]
    here = {"type": "goto", "screen": "Notes",
            "path": [{"view": "NoteDetail", "record_id": opened.record_id}]}

    rt.dispatch(here)
    assert [f.id for f in rt.stacks["Notes"]] == ["s1", opened.id]

    # ...и тот же адрес во второй раз -- по-прежнему ничто.
    rt.dispatch(here)
    assert [f.id for f in rt.stacks["Notes"]] == ["s1", opened.id]

    # Адрес короче -- снялось только лишнее.
    rt.dispatch({"type": "goto", "screen": "Notes", "path": []})
    assert [f.id for f in rt.stacks["Notes"]] == ["s1"]


def test_goto_stops_at_a_step_it_cannot_honour(app, поднять):
    """Ссылка живёт в закладке дольше, чем вид с таким именем и запись с таким ключом."""
    rt = поднять(app)
    note = rt.db.create(Note, {"title": "N"})
    rt.touch(Note)

    # Записи нет: путь обрывается на ней, и хвост за ней не достраивается.
    snap = rt.dispatch({"type": "goto", "screen": "Notes", "path": [
        {"view": "NoteDetail", "record_id": "нет такой"},
        {"view": "NoteDetail", "record_id": note},
    ]})
    assert [f["view"] for f in _stack(snap)] == ["Notes"]

    # Вида нет -- то же самое. Исполнимый шаг после него нарочно: обрыв тем и
    # отличается от пропуска, что хвост за неисполнимым шагом не достраивается,
    # -- склеенный через пропуск стек описывал бы путь, которого не было.
    snap = rt.dispatch({"type": "goto", "screen": "Notes", "path": [
        {"view": "NoteDetail", "record_id": note},
        {"view": "Переименованный", "record_id": note},
        {"view": "NoteDetail", "record_id": note},
    ]})
    assert [f["view"] for f in _stack(snap)] == ["Notes", "NoteDetail"]


def test_goto_rejects_an_unknown_screen(app, поднять):
    rt = поднять(app)
    with pytest.raises(Exception) as excinfo:
        rt.dispatch({"type": "goto", "screen": "Nope", "path": []})
    assert "Nope" in str(excinfo.value)

    # И раздела нет вовсе -- тот же отказ, а не подстановка текущего: адрес без
    # раздела не адрес, а «куда-нибудь», и открыть его гаданием значило бы
    # увести человека не туда молча.
    with pytest.raises(Exception):
        rt.dispatch({"type": "goto", "path": []})


#: Вынесены из тела проверки на уровень модуля: выкладка ищет виды в
#: пространстве имён модуля, и класс из функции туда не попадает.
class Card(View):
    model = Note
    _title = ""

    def ui(self, record):
        return (record.title(),)


class Desk(View):
    _title = "Стол"

    def ui(self, record):
        return (List(Note, item=NoteItem, open=Card),
                Button("Новая", action=Note.create(open=Card, draft=True)))


def test_a_frame_names_its_level_even_when_the_bar_asks_for_no_title(поднять):
    """`name` -- имя уровня, и пустой заголовок его не отменяет.

    Заголовка нет у карточки записи (`_title = ""`): запись и есть страница,
    второй раз её имя над ней не пишут. Спрашивает кадр не только бар -- крошка
    называет уровень, и звено без слова было бы дырой в цепочке. Порядок здесь
    и проверяется целиком: заголовок, пока он есть; иначе имя записи; и лишь в
    последнюю очередь имя вида.

    Черновик -- третий случай, и он не тот же самый: записи у него ещё нет.
    `display_name` на строке без ключа отдаёт не имя, а заглушку с решёткой
    (`#None` в питоне, `#null` в JS), то есть разом и дыру в цепочке, и
    расхождение двух рантаймов на ровном месте.
    """
    rt = поднять(App(Screen(Desk), title="Desk"))
    record = rt.db.create(Note, {"title": "Купить хлеб"})
    rt.touch(Note)

    root = _stack(rt.snapshot())[0]
    assert (root["title"], root["name"]) == ("Стол", "Стол")

    snap = rt.dispatch({"type": "open", "list_id": root["children"][0]["id"],
                        "record_id": record})
    card = _stack(snap)[1]
    assert card["title"] == ""
    assert card["name"] == "Купить хлеб"

    rt.dispatch({"type": "back"})
    button = _stack(rt.snapshot())[0]["children"][1]["id"]
    snap = rt.dispatch({"type": "action", "button_id": button,
                        "context": {"screen_id": "s1"}})
    draft = _stack(snap)[-1]
    assert draft["draft"] is True
    assert draft["title"] == ""
    assert draft["name"] == "Card"


def test_the_same_view_arrives_the_way_the_action_asked(поднять):
    """One view, two arrivals: the point of putting the choice on the action."""
    rt = поднять(App(Screen(Board), title="Board"))
    buttons = {
        c["label"]: c for c in _stack(rt.snapshot())[0]["children"]
        if c["type"] == "button"
    }
    for label, expected in (("Быстро", "sheet"), ("Медленно", "page")):
        rt.dispatch({"type": "action", "button_id": buttons[label]["id"],
                     "context": {}})
        assert rt.stack[-1].tree["view"] == "NoteDetail"
        assert rt.stack[-1].tree["target"] == expected
        rt.dispatch({"type": "back"})


def test_one_item_view_draws_rows_that_differ(поднять):
    """`visible=` per record: what a finished note shows, an open one does not."""
    rt = поднять(App(Screen(Ledger), title="Ledger"))
    for title, done in (("Сделано", True), ("В работе", False)):
        rt.db.create(Note, {"title": title, "done": done})
    rt.touch(Note)
    from conftest import bound_rows

    rows = bound_rows(_stack(rt.snapshot())[0]["children"][0])
    drawn = {
        row["children"][0]["children"][0]["value"]: [
            c["name"] for c in row["children"][0]["children"] if c["visible"]
        ]
        for row in rows
    }
    assert drawn == {"Сделано": ["title", "done"], "В работе": ["title"]}


def test_a_tab_names_its_own_floating_action(поднять):
    """It hangs over the screen, so it is not content of the tab's page."""
    rt = поднять(App(Screen(Sections), title="Sections"))
    tabs = _stack(rt.snapshot())[0]["children"][0]
    first, second = [c for c in tabs["children"] if c["type"] == "tab"]
    assert first["fab"] is not None and second["fab"] is None
    assert not [c for c in first["children"] if c["type"] == "button"]

    rt.dispatch({"type": "action", "button_id": first["fab"]["id"],
                 "context": first["fab"]["context"]})
    assert [r["title"] for r in rt.db.all(Note)] == ["Из вкладки"]


# --------------------------------------------------------------------------
# строка списка: описание один раз, значения вектором
# --------------------------------------------------------------------------
class Memo(Model):
    title = String("Заголовок", required=True)
    done = Boolean("Выполнено")
    due = Date("Срок")


class SolidRow(View):
    """Условие о колонке, которая есть у записи всегда."""

    model = Memo

    def ui(self, record):
        return Row(record.title(widget="title"),
                   record.done(widget="checkbox", visible=~record.done))


class NullableRow(View):
    """Пустая колонка под ``is_null()``: неизвестности не возникает."""

    model = Memo

    def ui(self, record):
        return Row(record.title(widget="title"),
                   record.done(widget="checkbox", visible=record.due.is_null()),
                   record.due(visible=~record.due.is_null()))


class CompareRow(View):
    """Пустая колонка в сравнении: SQL ответил бы неизвестностью."""

    model = Memo

    def ui(self, record):
        return Row(record.title(widget="title"),
                   record.done(widget="checkbox", visible=record.due != "2026-02-01"))


#: Вид на уровне модуля -- иначе он не попадёт в выкладку (`_defined_in`
#: читает пространство имён модуля). Строка списка выбирается объявлением
#: экрана, поэтому видов три, по одному на строку.
class WallSolid(View):
    def ui(self, record):
        return (List(Memo, item=SolidRow),)


class WallNullable(View):
    def ui(self, record):
        return (List(Memo, item=NullableRow),)


class WallCompare(View):
    def ui(self, record):
        return (List(Memo, item=CompareRow),)


СТЕНЫ = {"SolidRow": WallSolid, "NullableRow": WallNullable, "CompareRow": WallCompare}


def _memo_app(item):
    return App(Screen(СТЕНЫ[item.__name__]), title="Memos")


def _считая_пути(rt):
    """Одна перерисовка со счётом обращений к базе -> {select, query}.

    Считает **хост**: база теперь у него, и подменять питоновскую значило бы
    мерить не ту, из которой список правда читает.
    """
    rt.call("paths_start")
    rt.call("rerender")
    return rt.call("paths_stop")


def _seed_memos(db):
    for title, done, due in (("Раз", False, "2026-02-01"), ("Два", True, None),
                             ("Три", False, None)):
        db.create(Memo, {"title": title, "done": done, "due": due})


def test_a_condition_about_own_never_empty_columns_is_answered_by_the_query(поднять):
    """Правило, ради которого весь путь: переспросить условие можно у той же
    таблицы, и только когда оно говорит о её колонках, которые есть всегда."""
    rt = поднять(_memo_app(SolidRow), seed=_seed_memos)
    rt.touch(Memo)
    used = _считая_пути(rt)
    assert (used["select"], used["query"]) == (1, 0), "условие не уехало в SQL"


def test_is_null_about_an_empty_column_is_answered_by_the_query(поднять):
    """``IS NULL`` -- та форма, где пустота и есть предмет вопроса.

    Отказ поимённо («колонка бывает пустой») уводил такой список на построчный
    путь без всякой причины: SQLite отвечает на ``IS NULL`` нулём или единицей
    при любом содержимом колонки, и ровно это же считает ``evaluate``.
    """
    rt = поднять(_memo_app(NullableRow), seed=_seed_memos)
    rt.touch(Memo)
    used = _считая_пути(rt)
    assert (used["select"], used["query"]) == (1, 0), "is_null() не уехал в SQL"


def test_a_comparison_with_an_empty_column_stays_per_record(поднять):
    """NULL в SQL -- ни истина, ни ложь, а ``evaluate`` отвечает булевым.

    Пока эти двое расходятся, сравнение с пустой колонкой в запрос не уходит: он
    ответил бы иначе, и разошлись бы два рантайма молча, показав разные ячейки.
    """
    rt = поднять(_memo_app(CompareRow), seed=_seed_memos)
    rt.touch(Memo)
    used = _считая_пути(rt)
    assert (used["select"], used["query"]) == (0, 1), "сравнение с NULL ушло в SQL"


def test_the_refusal_it_keeps_is_a_real_divergence_and_not_caution(поднять):
    """Почему сравнение остаётся построчным -- замером, а не на слово.

    Условие ``due != <дата>`` считается двумя способами на одних и тех же
    записях: колонкой ``CASE WHEN`` в SQL и построчным счётом. У записи без
    срока ответы обязаны разойтись -- иначе общий отказ нечем было бы
    оправдать, и сужать его было бы не от чего.

    Обе половины спрашиваются у той стороны, которая и **решает**: правило
    живёт в рантайме устройства, и оправдывать его питоновским замером значило
    бы оправдывать одно другим.
    """
    rt = поднять(_memo_app(CompareRow), seed=_seed_memos)
    узел = to_json(Memo._fields["due"] != "2026-02-01")

    assert rt.call("condition_column", "Memo", узел) is None, "правило пустило его в SQL"

    # ...и вот что было бы, пусти оно: та же колонка, собранная руками
    обе = rt.call("both_ways", "Memo", узел)
    assert обе["sql"] != обе["построчно"], "ответы сошлись -- отказ больше не нужен"
    пустые = [r["id"] for r in rt.db.all(Memo) if r["due"] is None]
    assert пустые, "в наборе нет записи с пустым сроком"
    assert all(обе["sql"][i] is False and обе["построчно"][i] is True for i in пустые)


@pytest.mark.parametrize("item", [SolidRow, NullableRow, CompareRow])
def test_both_paths_give_the_same_vectors(поднять, item):
    """Запросом и построчно -- один и тот же вектор, иначе выбор пути видно.

    Проекция снимается **у хоста**: путь выбирает рантайм устройства, и
    сверять два его пути питоновской подменой значило бы сверять чужие.
    """
    from conftest import bound_rows

    rt = поднять(_memo_app(item), seed=_seed_memos)
    rt.touch(Memo)
    node = rt.stack[-1].tree["children"][0]
    fast = [dict(r) for r in node["rows"]]

    rt.call("projection_off")
    try:
        rt.call("rerender")
        slow = rt.stack[-1].tree["children"][0]["rows"]
        assert fast == slow
    finally:
        rt.call("projection_on")
    # ...и вектор действительно отвечает на условие, а не повторяет один ответ
    drawn = {r["children"][0]["children"][0]["value"]:
             [c["name"] for c in r["children"][0]["children"] if c["visible"]]
             for r in bound_rows(node)}
    assert len({tuple(v) for v in drawn.values()}) > 1, "все строки вышли одинаковыми"


def test_the_row_description_travels_once(поднять):
    rt = поднять(_memo_app(SolidRow), seed=_seed_memos)
    rt.touch(Memo)
    node = rt.stack[-1].tree["children"][0]
    assert node["row"]["children"], "описание строки не приехало"
    assert node["row"]["cells"] is None
    assert [r["id"] for r in node["rows"]] == [r["id"] for r in rt.db.all(Memo)]
    for row in node["rows"]:
        # только значения: ни одного узла, ни одного номера узла
        assert all(not isinstance(v, dict) for v in row["v"])


def test_a_bare_view_is_one_screen():
    a = App(Notes, title="Solo")
    assert [s.key for s in a.screens] == ["Notes"]
    assert a.root_view is Notes


def test_screen_needs_a_view():
    with pytest.raises(DslError):
        Screen(object())


def test_app_rejects_a_non_view():
    with pytest.raises(DslError):
        App(42)

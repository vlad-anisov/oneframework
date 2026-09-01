"""Conformance: the wire between the app language and the renderer.

The renderer knows nothing about Python -- it consumes a snapshot and emits
actions. That boundary is the only thing another language would have to
reimplement, so it is pinned here rather than left implicit in the code that
happens to produce it.

Three rules hold every test in this file together:

* every node the renderer can receive is listed, with the keys it must carry;
* every action the renderer can send is listed, with the keys it must carry;
* действие без обязательного ключа обязано отказать, а не догадаться.

Adding a node type or an action without updating `protocol/wire.json` fails
here, which is the point: the schema is the contract, not the documentation.

Третье правило -- то, чего разделу `actions` не хватало дольше всего. Ключи он
перечислял, но перечисление никто не сверял ни с отправителем, ни с
обработчиком, ни с документом, и разошлось оно ровно так, как расходится
непроверяемая запись: `set_search` был объявлен с ключом `text`, а ехал с
`value`. Поэтому каждое действие спрашивается теперь с четырёх сторон -- схема,
рендерер, оба рантайма, `docs/protocol.md` -- и вдобавок изъятием ключа: кадр
собирается законным и у него отнимают один ключ.

Файл называется `test_wire.py` по имени схемы, которую он сторожит. Имя
`test_protocol.py` занято договором о **полях**, и это разные записи: там
таблица типов, здесь провод.

Как этого файла не стало. Он был написан под именем `test_protocol.py`, а
коммит `3776323` записал поверх него другой файл -- 708 строк и 21 теста
исчезли, не сказав ни слова ни в сообщении коммита, ни в прогоне: имя занял
новый файл, и `pytest` остался зелёным. `protocol/wire.json` после этого не
читал никто, хотя шесть мест утверждали обратное. Мораль записана здесь
потому, что стеречь себя файл не умеет: сторож, потерянный вместе с именем, --
единственная поломка, которую не покажет ни один прогон.
"""

import json
import re
from pathlib import Path

import pytest

from jsrt import Рантайм, needs_node

pytestmark = needs_node

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "protocol" / "wire.json").read_text())
VERSION = SCHEMA["version"]

#: Сторона, принимающая действия. До 21.08.2026 их было две, и третья проверка
#: ниже сверяла их между собой. Питоновский эталон удалён, и осталась та, что
#: стоит на устройстве -- она и сверяется **со схемой**, а не с двойником:
#: двойник мог сойтись с ней в одной и той же ошибке, схема не может.
RUNTIME = ROOT / "src" / "core" / "runtime" / "session.js"


def _renderer_sources():
    """Весь рендерер одной строкой -- перечислением, а не списком имён.

    Рендерер -- это `web/src`, кроме `runtime/`: рантайм события принимает, а не
    отправляет, и попади он сюда, проверка перестала бы отличать отправленное
    действие от принятого. Каталог перечисляется целиком именно потому, что
    файлы в нём переименовываются и появляются: список имён устаревает молча.
    """
    root = ROOT / "web" / "src"
    files = [
        p
        for p in sorted(root.rglob("*.js*"))
        if p.suffix in {".js", ".jsx"} and "runtime" not in p.relative_to(root).parts
    ]
    assert files, "рендерер не найден"
    return "\n".join(p.read_text() for p in files)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def walk(node):
    """Every typed node in a render tree, the containers included.

    A list's `rows` are not nodes -- they carry no `type`, only a record's key
    and its values -- so they are reached through :func:`list_rows` instead. The
    nodes those values belong to stand once, in `list.row`, and are followed
    here. Everything else that hangs off a node rather than standing among its
    children is followed too: a list's menu, a tab's title parts and its
    floating action are all nodes the renderer draws, and a contract that
    skipped them would be a contract with holes in the places most likely to
    differ between two implementations.
    """
    yield node
    for key in ("children", "title"):
        for child in node.get(key) or ():
            yield from walk(child)
    for key in ("menu", "fab"):
        if node.get(key):
            yield from walk(node[key])
    template = node.get("row")
    if template:
        for key in ("children", "cells"):
            for child in template.get(key) or ():
                yield from walk(child)


def list_rows(snapshot):
    for node in nodes_of(snapshot):
        if node["type"] == "list":
            yield from node.get("rows") or ()


def row_templates(snapshot):
    for node in nodes_of(snapshot):
        if node["type"] == "list" and node.get("row"):
            yield node["row"]


def nodes_of(snapshot):
    for stack in snapshot["stacks"].values():
        for frame in stack:
            for child in frame.get("children") or ():
                yield from walk(child)


def missing(node, required):
    return [key for key in required if key not in node]


def declared(name):
    """Все ключи действия -- обязательные и необязательные вместе."""
    spec = SCHEMA["actions"][name]
    return set(spec["required"]) | set(spec.get("optional") or ())


# --------------------------------------------------------------------------
# чтение кода: что кладут в кадр и что из него достают
# --------------------------------------------------------------------------
def _literal(text, brace):
    """Тело объектного литерала, открытого скобкой в позиции `brace`.

    Разбор посимвольный, а не выражением: в отправке бывают вложенные объекты
    (`values: {...}`, `context: {...}`) и строки, и всякий разбор, считающий
    первую же `}` концом, прочитал бы меньше ключей, чем едет. Меньше -- значит
    молча пропустил бы ровно тот ключ, ради которого всё это.
    """
    depth, quote, i = 0, None, brace
    while i < len(text):
        char = text[i]
        if quote:
            if char == "\\":
                i += 2
                continue
            if char == quote:
                quote = None
        elif char in "\"'`":
            quote = char
        elif char in "{[(":
            depth += 1
        elif char in "}])":
            depth -= 1
            if depth == 0:
                return text[brace + 1:i]
        i += 1
    raise AssertionError("незакрытый литерал в рендерере")


def _keys(body):
    """Имена ключей верхнего уровня -- короткая запись в том числе.

    `{ type: "set_search", list_id: listId, value }` -- три ключа, и у третьего
    имя со значением записаны одним словом. Пропусти короткую запись -- и самый
    интересный ключ провода (`value`) в проверку бы не попал.
    """
    keys, depth, quote, part = [], 0, None, []
    for char in body:
        if quote:
            part.append(char)
            if char == quote:
                quote = None
            continue
        if char in "\"'`":
            quote = char
        elif char in "{[(":
            depth += 1
        elif char in "}])":
            depth -= 1
        elif char == "," and depth == 0:
            keys.append("".join(part))
            part = []
            continue
        part.append(char)
    keys.append("".join(part))
    return [k.split(":", 1)[0].strip() for k in keys if k.strip()]


def _sent_frames():
    """Каждая отправка действия рендерером -- именем и списком ключей.

    Отправка узнаётся по `type: "имя"`: так же, как в проверке ниже, только
    читается весь литерал, а не одно имя. Имена, не объявленные действиями,
    пропускаются нарочно -- `type:` в рендерере называет ещё и вид поля ввода
    (`<input type="text">`) и вид листа Framework7, а это не провод.
    """
    text = _renderer_sources()
    frames = []
    for match in re.finditer(r'type:\s*"([a-z_]+)"', text):
        name = match.group(1)
        if name not in SCHEMA["actions"]:
            continue
        start = match.start() - 1
        while start >= 0 and text[start] in " \t\r\n":
            start -= 1
        assert text[start] == "{", f"{name}: отправка не литералом"
        frames.append((name, set(_keys(_literal(text, start))) - {"type"}))
    assert frames, "в рендерере не нашлось ни одной отправки"
    return frames


def _read_keys(path):
    """Ключи, которые обработчики одного рантайма достают из события.

    Читается тело каждого `on_*`, и только верхний уровень: `ctx["screen_id"]`
    внутри `action` -- ключ *контекста*, а не кадра, и договор о нём не говорит.
    """
    text = path.read_text()
    if path.suffix == ".py":
        starts = [(m.start(), m.group(1)) for m in re.finditer(r"\n    def (\w+)\(", text)]
        patterns = (r'ev\[\s*"([a-z_]+)"', r'ev\.get\(\s*"([a-z_]+)"')
    else:
        # Ключевые слова стоят в тексте на том же отступе, что и методы класса,
        # и приняв `if (` за начало следующего метода, разбор оборвал бы тело
        # предыдущего на середине -- то есть недосчитал бы прочитанных ключей.
        words = {"if", "for", "while", "switch", "catch", "return", "function"}
        starts = [
            (m.start(), m.group(1))
            for m in re.finditer(r"\n  ([A-Za-z_$][\w$]*)\(", text)
            if m.group(1) not in words
        ]
        patterns = (r"\bev\.([a-z_]+)",)
    out = {}
    for position, (offset, name) in enumerate(starts):
        if not name.startswith("on_"):
            continue
        end = starts[position + 1][0] if position + 1 < len(starts) else len(text)
        body = text[offset:end]
        out[name[3:]] = {key for pattern in patterns for key in re.findall(pattern, body)}
    assert out, f"в {path.name} не нашлось обработчиков"
    return out


def _documented_actions():
    """Таблица действий из `docs/protocol.md`, разобранная как схема.

    Ключ со знаком `?` -- необязательный. Разбирается затем, что именно в этой
    таблице `set_search` годами звался `text`: документ, который никто не
    сверяет, расходится с кодом ровно так же, как схема, -- и так же молча.
    """
    text = (ROOT / "docs" / "protocol.md").read_text()
    section = text.split("## Вверх: действия", 1)[1].split("\n## ", 1)[0]
    table = {}
    for line in section.splitlines():
        row = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(row) != 3 or not row[0].startswith("`"):
            continue
        keys = [] if row[1] == "—" else [k.replace("`", "").strip() for k in row[1].split(",")]
        table[row[0].strip("`")] = (
            [k for k in keys if not k.endswith("?")],
            [k.rstrip("?") for k in keys if k.endswith("?")],
        )
    assert table, "таблица действий в документе не найдена"
    return table


def _documented_frame_keys():
    """Ключи кадра из таблицы в `docs/protocol.md`. `?` -- необязательный.

    Описаний у кадра два -- схема и эта таблица, -- и то из них, которое никто
    не читал, разошлось: `dismiss` решает в рендерере «закрыть» против
    «назад», `target` -- лист против страницы, `draft` -- вид карточки, и ни
    одного из трёх в таблице не стояло. Читающий её и писавший бы третий
    рантайм без них.
    """
    text = (ROOT / "docs" / "protocol.md").read_text()
    section = text.split("### Кадр", 1)[1].split("\n### ", 1)[0]
    keys = set()
    for line in section.splitlines():
        row = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(row) != 2 or not row[0].startswith("`"):
            continue
        keys.update(key.replace("`", "").strip() for key in row[0].split(","))
    assert keys, "таблица кадра в документе не найдена"
    return keys


# --------------------------------------------------------------------------
# the snapshot
# --------------------------------------------------------------------------
def test_snapshot_carries_the_documented_top_level_keys(runtime):
    snap = runtime.snapshot()
    assert missing(snap, SCHEMA["snapshot"]["required"]) == []


def test_every_rendered_node_is_a_declared_type(runtime):
    declared = set(SCHEMA["nodes"])
    seen = {n["type"] for n in nodes_of(runtime.snapshot())}
    assert seen <= declared, f"node types not in the schema: {sorted(seen - declared)}"


def test_every_rendered_node_carries_its_required_keys(runtime):
    for node in nodes_of(runtime.snapshot()):
        spec = SCHEMA["nodes"][node["type"]]
        assert missing(node, spec["required"]) == [], (
            f"{node['type']} is missing {missing(node, spec['required'])}"
        )


def test_no_rendered_node_carries_a_key_the_schema_does_not_name(runtime):
    """Обратная сторона: ключ на проводе, о котором договор молчит.

    У действий эта сторона спрашивалась с самого начала, у узлов -- нет, и
    разошлось ровно там: `list.handle_hidden` ехал в каждом списке, рендерер им
    прятал ручку перетаскивания, а схема о нём не знала. Чужая библиотека,
    написанная строго по схеме, ручку показывала бы всегда -- и узнать об этом
    было бы неоткуда, потому что снимок при этом законный.
    """
    for node in nodes_of(runtime.snapshot()):
        spec = SCHEMA["nodes"][node["type"]]
        allowed = set(spec["required"]) | set(spec.get("optional") or ())
        assert set(node) <= allowed, (
            f"{node['type']} везёт незваное: {sorted(set(node) - allowed)}"
        )


def test_every_frame_agrees_with_the_schema(runtime):
    """Кадр стека -- тоже запись договора, и у неё до сих пор не было читателя.

    Раздел `frame` в схеме описан, а спрашивал его один только рендерер, молча:
    недостающий ключ обернулся бы `undefined` где-нибудь в заголовке. Договор,
    который никто не сверяет, расходится -- об этом весь этот файл.
    """
    required = SCHEMA["frame"]["required"]
    allowed = set(required) | set(SCHEMA["frame"].get("optional") or ())
    seen = 0
    for stack in runtime.snapshot()["stacks"].values():
        for frame in stack:
            assert missing(frame, required) == [], (
                f"кадр {frame.get('view')} без {missing(frame, required)}"
            )
            assert set(frame) <= allowed, (
                f"кадр {frame.get('view')} везёт незваное: "
                f"{sorted(set(frame) - allowed)}"
            )
            seen += 1
    assert seen, "ни одного кадра -- проверять нечего"


def test_the_document_names_the_frame_keys_the_schema_names():
    """Третья сторона кадра -- `docs/protocol.md`, и спрашивается она так же.

    По кадру пишут рантайм на новом языке, а пишут по документу, а не по
    схеме: таблица короче схемы -- это ключ, которого у нового рантайма не
    будет, и узнается это на глаз в рендерере.
    """
    schema = set(SCHEMA["frame"]["required"]) | {
        f"{key}?" for key in SCHEMA["frame"].get("optional") or ()
    }
    documented = _documented_frame_keys()
    assert documented == schema, (
        f"только в документе: {sorted(documented - schema)}; "
        f"только в схеме: {sorted(schema - documented)}"
    )


def test_list_rows_carry_the_keys_the_renderer_reads(runtime):
    """`rows` are entries, not nodes: the schema states them separately."""
    seen = list(list_rows(runtime.snapshot()))
    assert seen, "the fixture app has no rows to check"
    for row in seen:
        assert missing(row, SCHEMA["listRow"]["required"]) == []
        assert "type" not in row
        assert isinstance(row["v"], list)


def test_the_row_travels_once_and_the_records_are_vectors(runtime):
    """Строка списка -- вектор значений, а не дерево.

    То, ради чего форма менялась: описание строки едет один раз на список, а на
    запись приходится столько, сколько в ней своего. Дерево на запись
    возвращало нагрузку, равную размеру таблицы, -- проверяется здесь, а не
    замером, потому что вернуться оно может молча.
    """
    for template in row_templates(runtime.snapshot()):
        assert missing(template, SCHEMA["rowTemplate"]["required"]) == []

    for node in nodes_of(runtime.snapshot()):
        if node["type"] != "list" or not node.get("rows"):
            continue
        slots = max(
            (max(n["bind"].values()) + 1 for n in walk(node) if n.get("bind")),
            default=0,
        )
        for row in node["rows"]:
            assert len(row["v"]) == slots, (
                f"{node['id']}: {len(row['v'])} значений на {slots} гнёзд"
            )
            for value in row["v"]:
                assert not isinstance(value, dict) or set(value) <= {"id", "display", "color"}


def test_every_slot_a_row_declares_is_filled(runtime):
    """`bind` называет гнездо номером, и номер обязан существовать."""
    seen = 0
    for node in nodes_of(runtime.snapshot()):
        if node["type"] != "list" or not node.get("rows"):
            continue
        width = len(node["rows"][0]["v"])
        for inner in walk(node):
            for key, index in (inner.get("bind") or {}).items():
                assert key in inner, f"{inner['id']} связывает {key}, которого у него нет"
                assert 0 <= index < width, f"{inner['id']}.{key} -> гнездо {index}"
                seen += 1
    assert seen, "ни одно гнездо не объявлено -- проверять нечего"


def test_ids_are_unique_within_a_frame(runtime):
    """A renderer keys elements by id; a duplicate silently drops a widget."""
    for stack in runtime.snapshot()["stacks"].values():
        for frame in stack:
            # ids repeat across rows on purpose -- one item view, many records --
            # so uniqueness is asked of the frame's own tree, not of the rows.
            ids = [
                n["id"]
                for c in frame.get("children") or ()
                for n in walk({**c, "rows": []})
                if "id" in n
            ]
            assert len(ids) == len(set(ids)), f"duplicate ids in {frame['view']}"


def test_the_renderer_is_given_answers_and_never_questions(runtime):
    """`visible=` и `enabled=` -- выражения в документе и «да»/«нет» в дереве.

    Ровно та граница, ради которой вид разделён надвое. В документе условие
    обязано сохраниться целиком, иначе шаблон, разложенный на две машины,
    значит на них разное; в дереве от него обязан остаться ответ, иначе
    рендереру пришлось бы уметь вычислять домены -- и он бы вычислял их иначе.
    """
    for node in nodes_of(runtime.snapshot()):
        for key in ("visible", "enabled"):
            if key not in node:
                continue
            # Внутри строки списка ответ у каждой записи свой, и живёт он в её
            # векторе: узел называет гнездо, а на месте самого ответа стоит
            # ``null``. Выражения не остаётся и там.
            if (node.get("bind") or {}).get(key) is not None:
                assert node[key] is None, (
                    f"{node['type']}.{key} и связано, и отвечено сразу"
                )
                continue
            assert isinstance(node[key], bool), (
                f"{node['type']}.{key} приехало выражением: {node[key]!r}"
            )


# --------------------------------------------------------------------------
# the actions
# --------------------------------------------------------------------------
def samples(runtime):
    """По одному законному кадру на каждое действие -- из снимка, не из кода.

    Строится по снимку нарочно: рендерер тоже не знает про приложение ничего,
    кроме снимка, и кадр, который нельзя собрать из снимка, он не отправит.
    """
    snap = runtime.snapshot()
    nodes = list(nodes_of(snap))
    lst = next(n for n in nodes if n["type"] == "list" and n.get("rows"))
    rows = lst["rows"]
    screen = snap["stacks"][snap["active"]][-1]
    state = next(n for n in nodes if n["type"] == "field" and n["scope"] == "view")
    button = next(n for n in nodes if n["type"] == "button" and n.get("context"))
    flag = next(n for n in nodes if n["type"] == "field" and n.get("scope") == "record"
                and n["ftype"] == "boolean")
    return {
        "switch_screen": {"key": snap["active"]},
        "back": {},
        # Уровень назван ключом кадра -- тем самым, что стоит в снимке: крошки
        # берут его оттуда же, откуда рендерер берёт всё остальное.
        "back_to": {"screen_id": screen["id"]},
        # Путь -- то же, что стоит в адресной строке (`web/src/address.js`): по
        # паре «вид -- запись» на кадр. Здесь он берётся из стека, потому что
        # рендерер и строит его оттуда.
        "goto": {"screen": snap["active"],
                 "path": [{"view": screen["view"], "record_id": rows[0]["id"]}]},
        "open": {"list_id": lst["id"], "record_id": rows[0]["id"]},
        "write": {"model": lst["model"], "record_id": rows[0]["id"],
                  "screen_id": screen["id"], "values": {flag["name"]: True}},
        "set_state": {"screen_id": screen["id"], "field": state["name"], "value": None},
        "action": {"button_id": button["id"],
                   "context": {**button["context"], "record_id": rows[0]["id"]}},
        "set_search": {"list_id": lst["id"], "value": "зонт"},
        "set_filter": {"list_id": lst["id"], "index": 0},
        "set_sort": {"list_id": lst["id"], "index": 0},
        "load_more": {"list_id": lst["id"]},
        "reorder": {"list_id": lst["id"], "record_id": rows[1]["id"], "from": 1, "to": 0},
        "probe": {},
    }


def to_root(runtime):
    """Свернуть стек: следующий образец описан от корня, а не от того, что
    открыло предыдущее действие."""
    while len(runtime.snapshot()["stacks"][runtime.active]) > 1:
        runtime.dispatch({"type": "back"})


#: Рантайм -- тот, что стоит на устройстве: провод описывает границу между
#: языком приложения и рендерером, и держать её обязана та сторона, которая на
#: этой границе правда стоит.
@pytest.fixture()
def runtime(todo_app):
    import seed as seed_module

    r = Рантайм(todo_app.app, seed=seed_module.seed)
    yield r
    r.close()


@pytest.fixture()
def blank(todo_app):
    """Чистый рантайм на каждый вопрос.

    Изъятие ключа -- вопрос о разборе одного кадра, и ответ на него не должен
    зависеть от предыдущего. Зависел: `set_search` без ключа сбрасывает поиск,
    а под другим поиском список не показывает записи -- и `reorder`, которому
    нечего переставлять, «отвечает успехом» по совсем другой причине. Такая
    проверка сообщала бы не про тот ключ, про который спрашивали.
    """
    import seed as seed_module

    поднятые = []

    def make():
        r = Рантайм(todo_app.app, seed=seed_module.seed)
        поднятые.append(r)
        return r

    yield make
    for r in поднятые:
        r.close()


def test_every_declared_action_is_accepted(runtime):
    """The runtime answers each documented action rather than raising."""
    frames = samples(runtime)
    assert set(frames) == set(SCHEMA["actions"]), (
        f"без образца: {sorted(set(SCHEMA['actions']) - set(frames))}; "
        f"лишний образец: {sorted(set(frames) - set(SCHEMA['actions']))}"
    )
    for name, payload in frames.items():
        runtime.dispatch({"type": name, **payload})
        to_root(runtime)

    # Спрашивается не «не упало», а «доехало» -- потому что «не упало» здесь
    # ничего не значило. Образец слал `text`, рантайм читал `value` через
    # `or ""`, и кадр уходил в «поиск сброшен»: тест был зелёным, проверив
    # ровно ноль. Единственная защита от повтора -- смотреть на последствие.
    list_id = frames["set_search"]["list_id"]
    runtime.dispatch({"type": "set_search", "list_id": list_id, "value": "зонт"})
    after = next(n for n in nodes_of(runtime.snapshot()) if n["id"] == list_id)
    assert after["state"]["text"] == "зонт", after["state"]


#: Обязательные ключи, которые рантайм пока подставляет вместо отказа.
#:
#: Список -- храповик, и уменьшаться он обязан только в одну сторону: сверка
#: точная, поэтому и починка обработчика, и новое гадание одинаково роняют
#: проверку. Держать его в файле неприятно, и это правильно -- долг, который
#: видно, чинят; долг, которого не видно, живёт годами. Отказ здесь -- дело
#: обоих рантаймов (`session.py`, `session.js`), а не схемы.
GUESSED_INSTEAD_OF_REFUSED = {
    ("set_state", "value"),
    ("set_search", "value"),
    ("set_filter", "index"),
    ("set_sort", "index"),
}


def test_an_action_without_its_required_key_is_refused_and_not_guessed(blank):
    """Пропущенный обязательный ключ -- отказ, а не значение по умолчанию.

    Спрашивается изъятием потому, что молчаливая подстановка выглядит успехом:
    `set_search` без `value` до сих пор значит «сбросить поиск». Такую поломку
    нельзя найти по симптому -- поиск просто ничего не находит, и никто ничего
    не сказал.

    Проверка ставит вопрос ровно так: изъять один ключ и посмотреть, отказал ли
    рантайм. Изъятий столько, сколько обязательных ключей во всей схеме;
    отказывают почти все, а те, что пока подставляют значение, названы выше
    поимённо -- чтобы новое гадание нельзя было завести молча.
    """
    guessing = set()
    for name, spec in SCHEMA["actions"].items():
        for key in spec["required"]:
            runtime = blank()
            payload = samples(runtime)[name]
            try:
                runtime.dispatch({"type": name, **{k: v for k, v in payload.items() if k != key}})
            except Exception:
                continue
            guessing.add((name, key))
    assert guessing == GUESSED_INSTEAD_OF_REFUSED, (
        f"перестали отказывать: {sorted(guessing - GUESSED_INSTEAD_OF_REFUSED)}; "
        f"уже отказывают, а список ещё помнит: "
        f"{sorted(GUESSED_INSTEAD_OF_REFUSED - guessing)}"
    )


def test_no_action_has_an_undeclared_required_key(blank):
    """Обратная сторона: названное необязательным таким и является.

    Иначе `optional` был бы вежливым словом, а не разрешением не слать ключ:
    чужая реализация, написанная строго по схеме, отправила бы голый кадр и
    получила отказ, которого договор не обещал.
    """
    for name, spec in SCHEMA["actions"].items():
        runtime = blank()
        payload = samples(runtime)[name]
        runtime.dispatch(
            {"type": name, **{k: v for k, v in payload.items() if k in spec["required"]}}
        )


def test_the_renderer_sends_every_key_the_schema_requires():
    """Каждая отправка читается целиком, а не по имени действия.

    Проверка снизу вверх: раньше схема и рендерер сверялись только списком
    имён, и разойтись в *ключах* они могли беспрепятственно -- что и произошло
    с `set_search`.
    """
    for name, keys in _sent_frames():
        assert missing(keys, SCHEMA["actions"][name]["required"]) == [], (
            f"{name} едет без {missing(keys, SCHEMA['actions'][name]['required'])}"
        )


def test_the_renderer_sends_no_key_the_schema_does_not_name():
    """Ключ на проводе, которого нет в договоре, -- недокументированное
    поведение: чужая реализация о нём не узнает никогда."""
    for name, keys in _sent_frames():
        assert keys <= declared(name), f"{name} везёт незваное: {sorted(keys - declared(name))}"


def test_the_runtimes_read_the_keys_the_schema_names_and_no_others():
    """Второй конец провода -- те же ключи.

    Обязательный ключ, который не читает никто, -- обещание впустую; читаемый
    ключ, которого нет в схеме, -- поведение, о котором знает только этот
    рантайм. Оба случая тихие, поэтому спрашиваются оба.
    """
    handlers = _read_keys(RUNTIME)
    for name, spec in SCHEMA["actions"].items():
        assert name in handlers, f"рантайм не отвечает {name!r}"
        read = handlers[name]
        assert read <= declared(name), (
            f"{name} читает незваное: {sorted(read - declared(name))}"
        )
        assert set(spec["required"]) <= read, (
            f"{name} не читает обязательного: "
            f"{sorted(set(spec['required']) - read)}"
        )


#: Обработчик, которого не зовёт никто.
#:
#: `on_flush` в рантайме есть, но кадра `{"type": "flush"}` не шлёт никто -- ни
#: рендерер, ни хост, ни одна проверка. Хост, которому нужна запись на диск,
#: зовёт базу напрямую (`web/src/runtime/worker.js::flush`), потому что базой
#: он и владеет; путь через событие -- вторая копия того же умения, и она не
#: исполняется ни разу. Правильный конец у неё один -- удаление. Пока этого не
#: сделали, имя стоит здесь: сверка точная, поэтому удаление уронит проверку и
#: заставит убрать заодно и эту строку.
UNCALLED_HANDLERS = {"flush"}


def test_the_runtimes_answer_exactly_the_declared_actions():
    """Обработчик вне схемы -- поведение, о котором не знает никто.

    Обратная сторона проверки «объявлено, но не шлётся»: там ловится обещание
    без исполнителя, здесь -- исполнитель без обещания. Второе тише: такой
    обработчик не падает, не мешает и не зовётся, он просто лежит, и рядом с ним
    лежит уверенность, что провод описан целиком.
    """
    answered = set(_read_keys(RUNTIME))
    assert answered == set(SCHEMA["actions"]) | UNCALLED_HANDLERS, (
        f"не объявлено {sorted(answered - set(SCHEMA['actions']))}; "
        f"объявлено, но не отвечает {sorted(set(SCHEMA['actions']) - answered)}"
    )


#: Здесь стояла ``test_both_runtimes_read_the_same_keys``: два рантайма обязаны
#: читать у каждого действия одни и те же ключи, иначе приложение на двух
#: устройствах отвечает на одно нажатие по-разному. Рантайм остался один --
#: сверять стало не с чем, и расходиться нечему. Договор держат две проверки
#: выше: рантайм читает ровно то, что названо схемой, и отвечает ровно на то,
#: что она объявляет.


def test_the_document_states_the_same_actions_as_the_schema():
    """Таблица в `docs/protocol.md` -- та же запись, а не пересказ.

    Именно там `set_search` числился с ключом `text`, и там же жили `create` и
    `refresh` -- действия, которых не шлёт рендерер и не знает ни один рантайм.
    Документ, который никто не сверяет, врёт так же молча, как схема.
    """
    table = _documented_actions()
    assert set(table) == set(SCHEMA["actions"]), (
        f"только в документе: {sorted(set(table) - set(SCHEMA['actions']))}; "
        f"только в схеме: {sorted(set(SCHEMA['actions']) - set(table))}"
    )
    for name, spec in SCHEMA["actions"].items():
        assert table[name] == (spec["required"], spec.get("optional") or []), (
            f"{name}: в документе {table[name]}, в схеме "
            f"{(spec['required'], spec.get('optional') or [])}"
        )


def test_documented_actions_and_implemented_actions_agree():
    """Nothing is documented that the renderer never sends, and vice versa.

    Читается весь рендерер, а не один файл, и читается перечислением каталога,
    а не списком имён. Раньше здесь стоял `renderer.js` в единственном числе, и
    проверка держалась на том, что все отправки действий лежат в нём одном --
    допущение, которое перестало быть верным, как только рендерер начал
    переезжать по частям. Потом здесь появился список из трёх имён, и он устарел
    на следующем же шаге переезда. Тест при этом падал бы не на настоящей потере
    действия, а на переименовании файла: ложная тревога, из-за которой в
    следующий раз ему поверят меньше.

    Рантайм исключён нарочно: он тоже разговаривает событиями, но он их
    *принимает*, а вопрос здесь -- что рендерер *отправляет*.
    """
    renderer = _renderer_sources()
    for name, spec in SCHEMA["actions"].items():
        sent = f'type: "{name}"' in renderer
        # `sender` разделяет провод надвое: почти всё шлёт рендерер, а `probe`
        # -- хост. Проверяется поэтому не «шлётся», а «шлётся тем, кто назван»:
        # иначе пометка была бы словом без последствий, и действие рендерера,
        # названное хостовым, выпало бы из проверки целиком.
        if spec["sender"] == "renderer":
            assert sent, f"{name} is documented but never sent"
        else:
            assert not sent, f"{name} назван хостовым, а шлёт его рендерер"


def test_write_round_trips_through_the_wire(runtime):
    """The one action that changes data, stated as the schema states it.

    Through a bound row, because that is what the renderer has in hand when the
    user taps: the node comes from `list.row`, the record's key and value from
    its vector.
    """
    from conftest import bind_row

    list_node = next(n for n in nodes_of(runtime.snapshot()) if n["type"] == "list")
    row = bind_row(list_node, list_node["rows"][0])
    field = next(
        n
        for c in row["children"]
        for n in walk(c)
        if n["type"] == "field" and n["scope"] == "record"
    )
    runtime.dispatch(
        {
            "type": "write",
            "model": field["model"],
            "record_id": field["record_id"],
            "values": {field["name"]: not field["value"]}
            if field["ftype"] == "boolean"
            else {field["name"]: field["value"]},
        }
    )
    assert missing(field, SCHEMA["nodes"]["field"]["required"]) == []


#: Кто обещает читателю, что провод кем-то сторожится.
#:
#: Обещание проверяемо ровно одним способом -- назвать файл. Пока файл звался
#: `test_protocol.py`, все шестеро называли его верно; после того как имя занял
#: чужой договор, все шестеро стали отправлять читателя не туда, и заметить это
#: было неоткуда.
#:
#: Список записан именами, а не выведен обходом дерева, потому что выводить
#: нечем: `wire.json` поминают и те, кто ничего не обещает, а `test_protocol.py`
#: -- живой сторож таблицы типов полей, и `oneframework/protocol.py` зовёт его
#: совершенно верно. Обход, не умеющий отличить обещание от упоминания, обвинял
#: бы правого.
CLAIM_A_GUARD = [
    "protocol/wire.json",
    "docs/protocol.md",
    "docs/custom-code.md",
    "tests/test_document.py",
    "web/src/react/nodes.jsx",
    "docs/research/build_architecture.py",
]


def test_whoever_promises_a_guard_names_the_file_that_guards():
    """Ссылка на сторожа обязана вести к сторожу.

    Проверяется не существование файла, а совпадение с этим: `test_protocol.py`
    существует и сегодня -- он сторожит таблицу типов полей. Отправить туда за
    проводом хуже, чем не отправить никуда: ссылка ведёт в живой файл, и
    читатель уходит уверенным.
    """
    здесь = Path(__file__).relative_to(ROOT).as_posix()
    for name in CLAIM_A_GUARD:
        text = (ROOT / name).read_text(encoding="utf-8")
        assert здесь in text, f"{name} не называет сторожа провода ({здесь})"
        assert "tests/test_protocol.py" not in text, (
            f"{name} отправляет за проводом в договор о полях"
        )


# --------------------------------------------------------------------------
# the version
# --------------------------------------------------------------------------
def test_the_renderer_pins_the_same_protocol_version():
    assert f'PROTOCOL = "{VERSION}"' in _renderer_sources(), (
        f"the renderer does not pin protocol {VERSION}; "
        "bump both sides together or the contract is a guess"
    )


def test_schema_and_renderer_agree_on_the_node_types():
    """Both sides state the list; the test is that they are the same list.

    A node type the schema promises but the renderer cannot draw is a broken
    promise, and one the renderer draws but the schema omits is undocumented
    behaviour another language would never know to produce.
    """
    renderer = _renderer_sources()
    block = renderer.split("export const NODE_TYPES = [", 1)[1].split("]", 1)[0]
    drawn = set(re.findall(r'"([a-z]+)"', block))
    assert drawn == set(SCHEMA["nodes"]), (
        f"only in the renderer: {sorted(drawn - set(SCHEMA['nodes']))}; "
        f"only in the schema: {sorted(set(SCHEMA['nodes']) - drawn)}"
    )

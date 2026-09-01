"""Приведение значения обязано значить одно и то же во всех рантаймах.

Сторон теперь **три**: питон (`oneframework/model/fields.py`), JS
(`src/runtime/fields.js`) и модуль (`core-db/src/fields.rs`). Все они пишут
в одну базу и обмениваются одними changeset-ами, поэтому `to_db` обязан давать
не «эквивалентное», а одно и то же значение. Расхождение здесь тихое: не
исключение, а неверно показанное число -- цена, разошедшаяся на копейку, дата,
обрезанная по половине эмодзи, `1` в колонке там, где эталон пишет `0`.

Отсюда устройство теста: питон гоняет представительный набор значений через
каждый тип поля, две другие стороны гоняют тот же набор, и результаты
сравниваются побайтно -- один и тот же канонический JSON со отсортированными
ключами. Схемы берутся не выдуманные, а настоящие: пробная модель со всеми
девятнадцатью типами плюс модели `examples/gtasks` и `examples/kitchen`, где
типы уже настроены руками (свои `digits`, валюта, максимум, `accept`).

Модуль сверяется только по приведениям (`cases`, `raws`) и намеренно не по
`meta`: подписи, виджеты и `sql_type` -- это язык объявления приложения, он
остаётся у питона, и документ схемы везёт его дальше как есть.
"""

import datetime
import importlib.util
import json
import re
import struct
import sys
from pathlib import Path

import pytest
from conftest import needs_node, run_node

from oneframework.model import fields as F
from oneframework.model.ids import is_id
from oneframework.model.meta import Model, ModelMeta
from oneframework.model.schema import model_schema, type_schema

ROOT = Path(__file__).resolve().parents[1]
FIELDS_JS = ROOT / "src" / "core" / "runtime" / "fields.js"

#: Значение, которого не получилось: питон на «int("")» падает, и JS обязан
#: отказать тоже. Сравнивается только сам факт отказа -- набор исключений у
#: языков разный, а вот молча положить в колонку NaN не должен ни один.
ERR = "err"


# --------------------------------------------------------------------------
# пробная модель: все девятнадцать типов сразу
# --------------------------------------------------------------------------
class Peer(Model):
    name = F.String("Имя")


class Probe(Model):
    text = F.String("Строка")
    key = F.Uuid("Ключ")
    count = F.Integer("Целое", maximum=99)
    ratio = F.Float("Дробное")
    percent = F.Percent("Проценты")
    price = F.Monetary("Деньги", currency="₽")
    spent = F.Duration("Длительность")
    flag = F.Boolean("Флаг")
    data = F.Json("Json")
    state = F.Selection([("draft", "Черновик"), ("done", "Готово")], "Выбор", default="draft")
    accent = F.Color("Цвет")
    day = F.Date("Дата")
    moment = F.Datetime("Момент")
    clock = F.Time("Время")
    blob = F.Binary("Файл")
    photo = F.Image("Картинка")
    place = F.GeoPoint("Точка")
    owner = F.Many2one(Peer, "Ссылка")
    twin = F.One2one(Peer, "Двойник")
    kids = F.One2many("Kid", "parent", "Дети")
    tags = F.Many2many(Peer, "Метки")


class Kid(Model):
    parent = F.Many2one(Probe, "Родитель")


# --------------------------------------------------------------------------
# значения
# --------------------------------------------------------------------------
#: Единый набор для всего, что в конце концов зовёт str(): пусто, пустая
#: строка, юникод вне BMP (его питон режет по кодовым точкам, а JS -- по
#: единицам UTF-16), булево (str(True) -- это «True», а не «true») и числа.
TEXTUAL = [None, "", "текст", "  пробелы  ", "🎉 emoji", "строка\nс переводом",
           "0", "42", True, False, 0, 42, -7, 3.5]

VALUES = {
    "string": TEXTUAL,
    "uuid": TEXTUAL,
    "selection": [None, "", "draft", "  draft  ", "🎉", 0, 42, True],
    "color": [None, "", "#ff0000", "  #ff0000  ", "\t\n ", " ", "﻿",
              "\x1c#abc\x1f", "красный", 0, True],
    "binary": [None, "", "data:image/png;base64,AAAA", "🎉", 0, True],
    "date": [None, "", "2026-08-15", "2026-08-15T09:41:03.118000Z", "26-08",
             "🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉", 0, True],
    "datetime": [None, "", "2026-08-15T09:41:03.118000Z", "текст", 0, True],
    "time": [None, "", "09:41", "09:41:03", "9:4", "🎉🎉🎉🎉🎉🎉🎉", 0, True],
    # -0.5 и -0.0: int() в питоне возвращает ноль без знака, Math.trunc -- со знаком.
    "integer": [None, "", 0, -0.0, 1, -7, 3.9, -3.9, 0.5, -0.5, True, False,
                "42", "  -7  ", "3.5", "abc", "1_000", 10 ** 15, 2 ** 53 - 1],
    "duration": [None, "", 0, -1, 3600, 3.9, True, "90", "abc"],
    # 0.125 и 2.675 -- ничьи и почти-ничьи: round в питоне решает их по
    # настоящим битам числа, toFixed -- нет. У float, в отличие от int, знак
    # нуля есть, и −0.001 обязан остаться −0.0 с обеих сторон.
    "float": [None, "", 0, -0.0, 1, -7, 0.125, -0.125, 0.135, 2.675, 1.005,
              2.5, -0.001, 1 / 3, 12345.6789, 1e15, "3.5", "  -2.5  ", "abc", True],
    "monetary": [None, "", 0, -0.0, 0.005, 0.125, -0.125, -0.001, 2.5, 12.345,
                 -12.345, 1234567.89, "2.5", "abc", True],
    # [] и {} в JS истинны, в питоне ложны -- в колонке это 1 против 0.
    "boolean": [None, "", 0, 1, -1, 0.0, 3.5, "0", "false", [], {}, [0],
                {"a": 1}, "текст", True, False],
    "json": [None, "", 0, 42, -7, 3.5, True, False, "строка", [], {},
             [1, 2, "ю"], {"a": 1, "b": [1, {"c": None}]}, {"кл": "зн"},
             "не json", "[1,2]", '{"a": 1}'],
    "geopoint": [None, "", [53.9, 27.5667], [-0.0, 180.0], ["53.9", "27.5"],
                 [1 / 3, 2 / 3], [0.1234565, 0.0000005], "53.9,27.5667",
                 "53.9", "a,b", 0, True],
    "many2one": [None, "", "abc", 0, 42, {"id": "x1"}, {"id": None},
                 {"id": ""}, {}, True],
    "one2one": [None, "", "abc", 0, 42, {"id": "x1"}, {"id": None},
                {"id": ""}, {}, True],
    "one2many": [None, "", 0, 42, True, "текст", [1, 2], {"a": 1}],
    "many2many": [None, "", 0, 42, True, "текст", [1, 2], {"a": 1}],
}


def raw_values(ftype):
    """То, что может прийти из колонки: только скаляры, которые знает SQLite."""
    return [v for v in VALUES[ftype]
            if v is None or isinstance(v, str)
            or (isinstance(v, (int, float)) and not isinstance(v, bool))]


# --------------------------------------------------------------------------
# канонический вид
# --------------------------------------------------------------------------
def canon(value):
    """Значение -> строка, одинаковая с точностью до байта на обеих сторонах.

    Число печатается как `repr(float)`, потому что int и float для JS -- одно и
    то же; заодно этим проверяется `pyFloatRepr`, которым JS печатает числа в
    строки и в JSON.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return "n:" + repr(float(value))
    if isinstance(value, str):
        return "s:" + value
    if isinstance(value, (list, tuple)):
        return "[" + "\x1f".join(canon(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + "\x1f".join(f"{k}\x1e{canon(v)}" for k, v in sorted(value.items())) + "}"
    return "?" + type(value).__name__


def cases(field):
    """Значение -> to_db -> from_db, плюс отдельно from_db прямо из колонки."""
    out = []
    for value in VALUES[field.ftype]:
        try:
            stored = field.to_db(value)
        except Exception:
            out.append({"in": canon(value), "db": ERR, "back": ERR})
            continue
        try:
            back = canon(field.from_db(stored))
        except Exception:
            back = ERR
        out.append({"in": canon(value), "db": canon(stored), "back": back})

    raws = []
    for value in raw_values(field.ftype):
        try:
            raws.append({"in": canon(value), "out": canon(field.from_db(value))})
        except Exception:
            raws.append({"in": canon(value), "out": ERR})
    return out, raws


def meta(field):
    """Всё, что поле рассказывает о себе рендереру и драйверу базы."""
    if field.ftype == "uuid":
        # Ключ каждый раз новый, сравнивать значение нечего -- сравнивается то,
        # что поле вообще заполняет себя само.
        default = "uuid" if is_id(field.default()) else "не ключ"
    else:
        default = canon(field.default())
    return {
        "column": canon(field.column),
        "ftype": field.ftype,
        "sqlType": canon(field.sql_type),
        "stored": bool(field.stored),
        "system": bool(field.system),
        "required": bool(field.required),
        "displayLabel": field.display_label,
        "widgets": list(field.widgets),
        "defaultWidget": field.default_widget,
        "default": default,
    }


def described(model):
    fields = {}
    for field in model._fields.values():
        rows, raws = cases(field)
        fields[field.name] = {"meta": meta(field), "cases": rows, "raws": raws}
    shown = model.display_field()
    return {
        "table": model._table,
        "stored": [f.name for f in model.stored_fields()],
        "virtual": [f.name for f in model.virtual_fields()],
        "relations": [f.name for f in model.relations()],
        "display": canon(shown.name if shown else None),
        "fields": fields,
    }


# --------------------------------------------------------------------------
# модели примеров
# --------------------------------------------------------------------------
_EXAMPLES = None


def example_models():
    """Модели `examples/gtasks` и `examples/kitchen` -- настоящие объявления.

    Реестр моделей восстанавливается: имена вроде `Task` заняты и в примерах, и
    в других тестах, и оставлять после себя чужую запись нельзя.
    """
    global _EXAMPLES
    if _EXAMPLES is not None:
        return _EXAMPLES

    paths = [ROOT / "examples" / "gtasks" / "modules" / "tasks" / "models.py"]
    paths += sorted((ROOT / "examples" / "kitchen" / "modules").glob("*/models.py"))

    saved = dict(F.MODEL_REGISTRY)
    found = []
    try:
        for path in paths:
            app, module = path.parts[-4], path.parts[-2]
            name = f"_parity_{app}_{module}"
            spec = importlib.util.spec_from_file_location(name, path)
            loaded = importlib.util.module_from_spec(spec)
            sys.modules[name] = loaded
            try:
                spec.loader.exec_module(loaded)
                for value in vars(loaded).values():
                    if isinstance(value, ModelMeta) and value is not Model:
                        found.append((f"{app}.{module}.{value.__name__}", value))
            finally:
                sys.modules.pop(name, None)
    finally:
        F.MODEL_REGISTRY.clear()
        F.MODEL_REGISTRY.update(saved)

    _EXAMPLES = found
    return found


def all_models():
    return [("probe.Probe", Probe), ("probe.Kid", Kid), ("probe.Peer", Peer)] + example_models()


# --------------------------------------------------------------------------
# сверка
# --------------------------------------------------------------------------
RUNNER = """
import { readFileSync } from "node:fs";
import { makeModel, pyFloatRepr } from "%(fields)s";

const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const ERR = "%(err)s";

function canon(value) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return "n:" + pyFloatRepr(value);
  if (typeof value === "string") return "s:" + value;
  if (Array.isArray(value)) return "[" + value.map(canon).join("\\x1f") + "]";
  if (typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((k) => k + "\\x1e" + canon(value[k])).join("\\x1f") + "}";
  }
  return "?" + typeof value;
}

function attempt(fn) {
  try { return canon(fn()); } catch { return ERR; }
}

function describe(model) {
  const fields = {};
  for (const field of model.fieldList) {
    const cases = payload.values[field.ftype].map((value) => {
      let stored;
      try { stored = field.toDb(value); } catch { return { in: canon(value), db: ERR, back: ERR }; }
      return { in: canon(value), db: canon(stored), back: attempt(() => field.fromDb(stored)) };
    });
    const raws = payload.raw[field.ftype].map((value) => (
      { in: canon(value), out: attempt(() => field.fromDb(value)) }
    ));
    const shown = field.ftype === "uuid"
      ? (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(field.default())
          ? "uuid" : "не ключ")
      : canon(field.default());
    fields[field.name] = {
      meta: {
        column: canon(field.column),
        ftype: field.ftype,
        sqlType: canon(field.sqlType),
        stored: Boolean(field.stored),
        system: Boolean(field.system),
        required: Boolean(field.required),
        displayLabel: field.displayLabel,
        widgets: field.widgets,
        defaultWidget: field.defaultWidget,
        default: shown,
      },
      cases,
      raws,
    };
  }
  const shown = model.displayField();
  return {
    table: model.table,
    stored: model.storedFields().map((f) => f.name),
    virtual: model.virtualFields().map((f) => f.name),
    relations: model.relations().map((f) => f.name),
    display: canon(shown ? shown.name : null),
    fields,
  };
}

const out = {};
for (const entry of payload.models) {
  out[entry.key] = describe(makeModel(entry.doc, payload.types));
}

/** Ключи по алфавиту и без пробелов -- как json.dumps(sort_keys=True). */
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}
process.stdout.write(stable(out));
"""


@needs_node
def test_javascript_converts_exactly_like_python(tmp_path):
    models = all_models()
    payload = {
        "types": type_schema([m for _, m in models]),
        "models": [{"key": key, "doc": model_schema(m)} for key, m in models],
        "values": VALUES,
        "raw": {ftype: raw_values(ftype) for ftype in VALUES},
    }
    expected = {key: described(model) for key, model in models}

    got = run_node(tmp_path, RUNNER % {"fields": FIELDS_JS, "err": ERR}, payload)
    want = json.dumps(expected, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    if got != want:                      # разница внятно, а не «строки не равны»
        assert json.loads(got) == json.loads(want)
        raise AssertionError("значения совпали, а запись разошлась")


# --------------------------------------------------------------------------
# третья сторона: приведения внутри модуля
# --------------------------------------------------------------------------
# Здесь стояли две проверки через **третью** реализацию -- модуль-базу на Rust:
# он приводил значения полей тем же кодом, что и запись в SQLite внутри WASM.
# Модуль удалён вместе со всем WASM (16.08.2026), и правило теперь сторожат две
# стороны, а не три. Потеря честная: третья сторона ловила бы расхождение,
# которого две не видят, -- но её содержание стоило мегабайта в браузере.

def test_every_field_type_is_covered():
    """Тест бесполезен, если новый тип поля в него не попал."""
    assert set(VALUES) == set(F.FIELD_TYPES)
    covered = {f.ftype for _, model in all_models() for f in model._fields.values()}
    assert covered == set(F.FIELD_TYPES)


#: Бесконечность и nan через JSON не проедут, поэтому едут именем.
NUMBERS_JS = """
import { readFileSync } from "node:fs";
import { pyFloatRepr } from "%(fields)s";

const special = { nan: NaN, inf: Infinity, "-inf": -Infinity };
const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const answer = payload.numbers.map((v) => pyFloatRepr(typeof v === "string" ? special[v] : v));
process.stdout.write(JSON.stringify(answer));
"""


@needs_node
def test_a_float_is_printed_the_way_python_prints_it(tmp_path):
    """Сверка выше опирается на `pyFloatRepr`, поэтому он проверяется отдельно.

    Иначе функция, возвращающая всем числам одну и ту же строку, сделала бы
    весь тест зелёным. Здесь же ответ сравнивается с `repr` напрямую, и заодно
    проверяются границы, на которых записи расходятся: питон уходит в
    экспоненциальную форму с 1e16, JS -- только с 1e21.
    """
    numbers = [0.0, -0.0, 1.0, -7.0, 0.1, 1 / 3, 0.125, 2.675, 1e15, 1e16,
               1e17, 1.5e18, 1e-4, 1e-5, 1e-7, 5e-324, 1.7976931348623157e308,
               float("inf"), float("-inf"), float("nan"), 123456.789]
    payload = {"numbers": [repr(v) if v != v or abs(v) == float("inf") else v
                           for v in numbers]}
    got = json.loads(run_node(tmp_path, NUMBERS_JS % {"fields": FIELDS_JS}, payload))
    assert got == [repr(v) for v in numbers]


MOMENT_JS = """
import { readFileSync } from "node:fs";
import { makeModel, now } from "%(fields)s";

const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const model = makeModel(payload.doc, payload.types);
process.stdout.write(JSON.stringify({
  now: now(),
  written: payload.moments.map((ms) => ["day", "clock", "moment"].map(
    (name) => model.fields[name].toDb(new Date(ms)),
  )),
}));
"""


@needs_node
def test_a_moment_is_written_the_way_python_writes_it(tmp_path):
    """Момент -- шесть знаков дробной части, как `%f`.

    Миллисекундной точности не хватает: записи, созданные в одном цикле, встают
    вровень, и «сначала новые» начинает выглядеть случайным. У JS часы всё равно
    миллисекундные, но ширина обязана остаться питоновской -- по этой строке
    записи сортируются, в том числе рядом с написанными питоном.
    """
    shape = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")
    moments = [0, 1786786863118, 1786786863000, 253402300799999]
    payload = {
        "doc": model_schema(Probe),
        "types": type_schema([Probe]),
        "moments": moments,
    }
    answer = json.loads(run_node(tmp_path, MOMENT_JS % {"fields": FIELDS_JS}, payload))

    mine = F.Datetime.now()
    assert shape.match(mine), mine
    assert shape.match(answer["now"]), answer["now"]
    assert len(answer["now"]) == len(mine)

    epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    expected = [
        [Probe._fields[name].to_db(epoch + datetime.timedelta(milliseconds=ms))
         for name in ("day", "clock", "moment")]
        for ms in moments
    ]
    assert answer["written"] == expected


def test_python_rounds_halves_to_even(tmp_path):
    """Опора всей арифметики: питон решает ничью по битам, а не по виду числа.

    Если это перестанет быть правдой, тест выше начнёт сверять два одинаково
    неверных ответа.
    """
    assert round(0.125, 2) == 0.12          # а не 0.13, как ответил бы toFixed
    assert round(0.5) == 0 and round(2.5) == 2
    assert Probe._fields["price"].to_db(0.005) == 0
    assert struct.pack(">d", 0.125).hex() == "3fc0000000000000"

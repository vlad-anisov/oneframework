/**
 * Две привязки объявляют одно и то же приложение одинаково.
 *
 * Зачем этот файл появился. Пятьдесят две проверки правил объявления приложены
 * к **питоновской** привязке (`tests/test_dsl.py`, `tests/test_declaration.py`).
 * Другие держались сверкой документов -- `tests/test_three_languages.py`, -- а
 * та сверяет тройку `notes-*`: модель, строка-вид, карточка, кнопка. Четыре
 * рода узлов из семнадцати. Всё остальное у второй привязки было не сверено ни
 * с чем, и разойтись могло молча.
 *
 * Подопытное приложение -- `tests/fixtures/parity_app.{py,mjs}`: оно задевает
 * каждый род узла и каждое умолчание, которое способно разойтись. Первый же
 * прогон нашёл четыре расхождения -- варианты выбора, подложку группы, `unit` у
 * двух числовых типов и текстовый узел, которого у питона нет вовсе.
 *
 * Сверяется двумя способами. Отпечатками канона -- тем, чем документы
 * различают на устройстве; и разобранным целиком -- потому что отпечаток
 * сжимает, и обе стороны могли бы сойтись на одной и той же ошибке канона.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Отпечатки документов пакета -- тем же каноном, что считает устройство. */
function отпечатки(пакет) {
  const docs = [пакет.types, ...пакет.models, ...пакет.views];
  const готово = spawnSync("node", [path.join(ROOT, "tests/parity/canon_driver.mjs")], {
    input: JSON.stringify({ docs, numbers: [], probes: {} }),
    encoding: "utf8", cwd: ROOT, maxBuffer: 64 * 1024 * 1024,
  });
  if (готово.status !== 0) throw new Error(готово.stderr);
  const имена = ["types", ...пакет.models.map((м) => м.name), ...пакет.views.map((в) => в.name)];
  const ответы = JSON.parse(готово.stdout).docs;
  for (const о of ответы) if (о.error) throw new Error(о.error);
  return Object.fromEntries(имена.map((и, к) => [и, ответы[к].ok.fp]));
}

const наJS = async () => (await import("../fixtures/parity_app.mjs")).пакет();

/** Питоновская половина -- отдельным процессом: своего разбора у неё нет. */
function наПитоне() {
  const скрипт = "import json, sys\n"
    + "sys.path.insert(0, 'tests/fixtures')\n"
    + "import parity_app\n"
    + "from oneframework.declaration import declare\n"
    + "import oneframework.model.defs as defs\n"
    + "пакет = declare(parity_app.app)\n"
    + "assert not getattr(defs, 'SKIPPED', {}), defs.SKIPPED\n"
    + "print(json.dumps(пакет, ensure_ascii=False))\n";
  return JSON.parse(execFileSync("python3", ["-c", скрипт], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: ROOT },
  }));
}

//: Каждый род узла, который договор знает, обязан быть в образце. Иначе
//: сверка тихо мельчает: заведут узел, образец его не тронет, и «привязки
//: совпадают» будет значить «совпадают в том, что мы вспомнили проверить».
const РОДЫ_УЗЛОВ = [
  "accordion", "button", "col", "field", "filter", "group", "icon", "list",
  "menu", "pill", "repeat", "row", "search", "section", "sort", "tab", "tabs",
  "view",
];

test("образец задевает каждый род узла договора", async () => {
  const внутри = new Set();
  const обойти = (значение) => {
    if (Array.isArray(значение)) { значение.forEach(обойти); return; }
    if (!значение || typeof значение !== "object") return;
    if (typeof значение.type === "string") внутри.add(значение.type);
    Object.values(значение).forEach(обойти);
  };
  обойти((await наJS()).views);
  const пропущены = РОДЫ_УЗЛОВ.filter((р) => !внутри.has(р));
  assert.deepEqual(пропущены, [], `образец не трогает: ${пропущены}`);
});

test("две привязки объявляют одинаковые документы", async () => {
  const пж = отпечатки(наПитоне());
  const дж = отпечатки(await наJS());
  assert.deepEqual(Object.keys(дж).sort(), Object.keys(пж).sort(),
                   "у сторон разный состав документов");
  assert.deepEqual(дж, пж);
});

test("объявления совпадают целиком, а не только отпечатками", async () => {
  assert.deepEqual(await наJS(), наПитоне());
});

//: Чего вторая привязка **не** умеет и чего первая не умеет тоже.
//:
//: Список записан именами, а не выведен обходом: выводить нечем -- у двух
//: привязок разные слова для одного и того же, и «нет такого имени» ещё не
//: значит «нет такого умения». Зато список точный, и всякая правка обязана его
//: тронуть -- иначе «привязки совпали» станет верой, а не фактом.
const РАЗОШЛИСЬ = {
  //: `Text("слова")` отдельным узлом. В JavaScript есть, у питона нет вовсе:
  //: там `Text` -- это **поле** (многострочная строка), а текстовый узел
  //: строится только подписью вкладки. Одно из двух имён придётся отдать.
  "текстовый узел": ["javascript"],
  //: Колонки таблицы (`List(columns=...)`): питон умеет, JavaScript отказывает
  //: вслух.
  "колонки таблицы": ["python"],
};

test("расхождения привязок названы поимённо, а не подразумеваются", async () => {
  const { Text, List, model, string } = await import("../../../oneframework-js/index.mjs");
  // Текстовый узел: в JavaScript он есть...
  assert.equal(Text("слова").type, "text");
  // ...а у питона `Text` -- поле, и это видно по тому, что он строит.
  const питоновский = execFileSync("python3", ["-c",
    "from oneframework import Text; print(type(Text('с')).__name__)"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, PYTHONPATH: ROOT } }).trim();
  assert.notEqual(питоновский, "TextNode", "у питона появился текстовый узел -- список устарел");

  // Колонки таблицы: JavaScript отказывает, и отказ обязан оставаться вслух.
  const M = model("M", { fields: { t: string("Т") } });
  assert.throws(() => List(M, { columns: [1] }), /колонки библиотека для JavaScript/);

  assert.deepEqual(Object.keys(РАЗОШЛИСЬ).sort(), ["колонки таблицы", "текстовый узел"]);
});

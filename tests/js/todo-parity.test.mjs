/**
 * Один и тот же todo на двух языках даёт один и тот же документ.
 *
 * `examples/todo-js/app.mjs` существует не как пример, а как **подопытное
 * приложение проверок**: на нём написана половина проверок рантайма, и пока
 * объявлял его только питон, проверки оставались на питоне. Пара сторожит
 * ровно то, ради чего она заведена: что перевод ничего не потерял по дороге.
 *
 * Сверяется отпечатками канонической записи -- тем же, чем различают документы
 * на устройстве. Порядок ключей в объекте не считается: канон их сортирует, а
 * `types` у двух сторон складывается в разном порядке -- разница в порядке
 * ключей объекта не разница.
 *
 * Тем же приёмом, что и тройка `notes-*` (`tests/together/test_three_languages.py`);
 * отдельным файлом потому, что там сверяются три языка на одном приложении, а
 * здесь два языка на другом.
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

const наJS = async () => {
  const { declare } = await import("../../../oneframework-js/index.mjs");
  const { application } = await import("../../../oneframework-examples/todo-js/app.mjs");
  return declare(application);
};

/** Питоновская половина -- отдельным процессом: своего разбора у неё нет. */
function наПитоне() {
  const скрипт = "import json, app\n"
    + "from oneframework.declaration import declare\n"
    + "print(json.dumps(declare(app.app), ensure_ascii=False))\n";
  return JSON.parse(execFileSync("python3", ["-c", скрипт], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: `${ROOT}:${path.join(ROOT, "examples", "todo")}` },
  }));
}

test("два языка объявляют один и тот же todo", async () => {
  const пж = отпечатки(наПитоне());
  const дж = отпечатки(await наJS());
  assert.deepEqual(Object.keys(дж).sort(), Object.keys(пж).sort(),
                   "у сторон разный состав документов");
  assert.deepEqual(дж, пж);
});

test("объявления совпадают целиком, а не только отпечатками", async () => {
  // Отпечаток сжимает документ, и разойтись они могли бы обе стороны сразу --
  // на одной и той же ошибке канона. Прямое сравнение разобранного этого не
  // умеет: оно смотрит на сам документ.
  assert.deepEqual(await наJS(), наПитоне());
});

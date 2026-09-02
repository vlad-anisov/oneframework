/**
 * Точка входа сборщика: пакет объявления -> собранное приложение.
 *
 *     node src/build/cli.mjs web <пакет.json|App.kt> [--root <куда>]
 *                                       [--extra <файл.json>] [--dev] [--port N]
 *
 * Языка приложения отсюда почти не видно: приезжает пакет, а чем он напечатан
 * -- питоном, Kotlin или JavaScript -- дело привязки. Исключение одно и
 * названо: `.kt` печатается здесь же, потому что для этого нужен компилятор
 * Kotlin, а не язык, на котором написан сборщик. В этом весь смысл переезда:
 * поставить ядро и собрать приложение можно, не ставя ни одного из этих
 * языков.
 *
 * `--extra` -- то, что привязка сделала у себя и передаёт готовым: исходники
 * виджетов и стилей её модулей. Собирать их ядро не умеет и не должно.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bundle } from "./bundle.mjs";
import { buildAndroid } from "./android.mjs";
import { declare as объявитьKotlin } from "./kotlin.mjs";
import { buildWeb, devWeb } from "./web.mjs";

const ЗДЕСЬ = path.dirname(fileURLToPath(import.meta.url));
const ПИСАТЕЛЬ = path.join(ЗДЕСЬ, "..", "build-db.mjs");

/**
 * Куда собирается приложение: каталог со страницей и настройками сборки.
 *
 * Ищется приметой -- `web/index.html` рядом с `package.json`, -- а не счётом
 * уровней. Глубина у сборщика разная: в общем дереве он лежит в
 * `libs/js/src/build`, в отдельном репозитории -- в `src/build`. Счёт верен
 * ровно в одной раскладке; поймано первой же сборкой из расколотых деревьев,
 * где база пошла писаться двумя каталогами выше, чем надо.
 */
function корень() {
  let где = ЗДЕСЬ;
  for (let шаг = 0; шаг < 8; шаг += 1) {
    if (existsSync(path.join(где, "web", "index.html"))
        && existsSync(path.join(где, "package.json"))) return где;
    const выше = path.dirname(где);
    if (выше === где) break;
    где = выше;
  }
  throw new Error(
    "Не нашёлся корень сборки: web/index.html рядом с package.json. " +
    "Сборщик запускается из ядра, и страница лежит в нём же.");
}

/** План -> файл SQLite, тем же писателем, что зовёт питон. */
function писатьБазу(план) {
  const готово = spawnSync("node", [ПИСАТЕЛЬ], {
    input: JSON.stringify(план), encoding: "utf8",
    cwd: корень(),
  });
  if (готово.status !== 0) {
    throw new Error(`Сборщик базы отказал: ${готово.stderr || готово.stdout}`);
  }
  const ответ = JSON.parse(готово.stdout);
  if (ответ.error) throw new Error(`Сборщик базы отказал: ${ответ.error}`);
  return ответ.ok;
}

function разобрать(argv) {
  const [цель, пакет, ...прочее] = argv;
  const опции = { цель, пакет, root: null, extra: null, dev: false, port: 5173,
                  open: false, install: false };
  for (let i = 0; i < прочее.length; i += 1) {
    if (прочее[i] === "--root") опции.root = прочее[++i];
    else if (прочее[i] === "--extra") опции.extra = прочее[++i];
    else if (прочее[i] === "--dev") опции.dev = true;
    else if (прочее[i] === "--open") опции.open = true;
    else if (прочее[i] === "--install") опции.install = true;
    else if (прочее[i] === "--port") опции.port = Number(прочее[++i]);
  }
  return опции;
}

export function main(argv) {
  const о = разобрать(argv);
  if (!["web", "android"].includes(о.цель) || !о.пакет) {
    process.stderr.write(
      "node cli.mjs <web|android> <пакет.json> [--root <куда>] [--extra <файл.json>] " +
      "[--dev] [--port N] [--open] [--install]\n");
    return 2;
  }
  // `.kt` -- это ещё не пакет, а приложение: чтобы напечатать пакет, его надо
  // собрать под JVM и запустить. Умеет это ядро, и питон в цепочке не нужен.
  const doc = о.пакет.endsWith(".kt")
    ? объявитьKotlin(о.пакет)
    : JSON.parse(readFileSync(о.пакет, "utf8"));
  const пакет = new Bundle(doc, { source: о.пакет });
  const root = о.root || корень();
  const доп = о.extra
    ? JSON.parse(readFileSync(о.extra, "utf8"))
    : { scripts: [], styles: [] };
  const опции = { доп, buildDb: писатьБазу, port: о.port, open: о.open };
  if (о.цель === "android") {
    // Веб внутри APK -- обычная боевая сборка: тот же код, что и для браузера.
    buildAndroid(root, { собратьВеб: () => buildWeb(root, пакет, опции),
                         install: о.install });
  } else if (о.dev) devWeb(root, пакет, опции);
  else buildWeb(root, пакет, опции);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (отказ) {
    process.stderr.write(`oneframework: ${отказ.message}\n`);
    process.exit(1);
  }
}

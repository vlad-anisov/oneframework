/**
 * Сборка веба: от пакета объявления до `dist/`.
 *
 * Четвёртая и последняя перенесённая часть сборщика, после плана, пакета и
 * файлов. Здесь собрано то, что **не зависит от языка**: база, манифест,
 * значки, конфиг, vite и список для офлайна.
 *
 * Шаги, привязанные к языку, ядро не делает и делать не должно -- питон на
 * устройстве нужен только питоновскому приложению, Kotlin в WASM только
 * котлиновскому. Они приезжают списком `доп`: привязка отрабатывает их у себя
 * и говорит, что положила. Так ядро остаётся тем, что можно поставить, не
 * ставя ни одного из этих языков.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildManifest, writePwaAssets } from "./assets.mjs";
import { buildPlan } from "./plan.mjs";
import { build as собратьМодуль, resolve as разрешить } from "./teavm.mjs";

/** Файлы, которым не место в списке офлайн-кэша. */
const НЕ_КЭШИРОВАТЬ = new Set(["sw.js", ".DS_Store"]);

/**
 * Всё, что нужно и `dev`, и `build`, до запуска vite.
 *
 * `доп` -- шаги привязки, уже отработавшие: {scripts, styles} с исходниками
 * виджетов модулей. Ядро их не собирает, а только раскладывает.
 */
/**
 * Скомпилировать объявленные модули и положить рядом с приложением.
 *
 * Объявление называет модуль и его исходники; чем он собран -- дело шага
 * сборки. Сегодня это Kotlin, завтра тем же местом добавятся Rust и C++: на
 * устройство в любом случае приезжает `.wasm`.
 *
 * Шаг этот не привязан к языку приложения: просит его **пакет**, а пакет
 * печатает кто угодно -- потому он и здесь, а не у привязки.
 */
export function собратьМодули(root, пакет) {
  // Чистим заранее: без этого модуль от прошлой сборки остаётся лежать в
  // приложении, которое его не объявляло. Замечено сразу -- у трёх примеров на
  // разных языках оказался один и тот же лишний `.wasm`.
  const корень = path.join(root, "web", "public", "wasm");
  const записи = пакет.logic_modules();
  const нужны = new Set(записи.flatMap((з) => (з.actions || [])
    .filter((д) => д.wasm).map((д) => д.wasm.module)));
  if (existsSync(корень)) {
    for (const имя of readdirSync(корень)) {
      if (!нужны.has(имя)) rmSync(path.join(корень, имя), { recursive: true, force: true });
    }
    if (!нужны.size) rmSync(корень, { recursive: true, force: true });
  }

  for (const запись of записи) {
    for (const действие of запись.actions || []) {
      const объявление = действие.wasm;
      if (!объявление || !(объявление.sources || []).length) continue;
      const имя = объявление.module;
      try {
        собратьМодуль(объявление.sources, path.join(корень, имя), имя,
                      "oneframework.generated.EntryKt", разрешить(пакет.maven));
        console.log(`Модуль на устройстве: ${имя} ` +
                    "(Kotlin -> байткод -> TeaVM -> WebAssembly)");
      } catch (отказ) {
        // Пропуск, а не отказ: приложение без модуля собирается и работает --
        // просто без этого действия. Отказ здесь остановил бы сборку всего
        // из-за одного не поставленного инструмента.
        console.log(`oneframework: модуль «${имя}» пропущен -- ${отказ.message}`);
      }
    }
  }
}

export function prepareWeb(root, пакет, { доп = { scripts: [], styles: [] }, buildDb } = {}) {
  // Ни интерпретатора, ни исходников на устройстве: сборка отработала здесь и
  // оставила после себя базу со схемой, определениями и данными.
  const план = buildPlan(пакет.doc);
  план.file = path.join(root, "web", "public", "oneframework-app.db");
  if (existsSync(план.file)) rmSync(план.file);
  buildDb(план);

  собратьМодули(root, пакет);
  buildManifest(root, пакет, доп);
  writePwaAssets(root, пакет.title);
  writeBuildConfig(root, пакет);
  return root;
}

/**
 * Настройки, которые vite обязан вписать в страницу на старте.
 *
 * Тема и цвет нужны, чтобы построить Framework7, а это происходит задолго до
 * того, как открывается база, -- поэтому в метаданных приложения они ехать не
 * могут.
 */
export function writeBuildConfig(root, пакет) {
  // Отпечаток поставки: он обесценивает кэш снимка интерпретатора всякий раз,
  // когда меняется приложение или каркас.
  const пакетик = path.join(root, "web", "public", "oneframework-bundle.zip");
  const build = existsSync(пакетик)
    ? createHash("sha1").update(readFileSync(пакетик)).digest("hex").slice(0, 16)
    : "dev";
  writeFileSync(path.join(root, ".oneframework-build.json"), JSON.stringify({
    theme: пакет.theme,
    color: пакет.color,
    dynamic_color: пакет.dynamic_color,
    title: пакет.title,
    build,
  }, null, 2), "utf8");
  console.log(`Theme: ${пакет.theme}   Colour: ${пакет.color}`);
}

function npx(root, args, env = {}) {
  const команда = ["npx", "--no-install", ...args];
  console.log(`$ ${команда.join(" ")}`);
  const готово = spawnSync(команда[0], команда.slice(1),
                           { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
  if (готово.status !== 0) throw new Error(`command failed: ${команда.join(" ")}`);
}

export function devWeb(root, пакет, опции = {}) {
  prepareWeb(root, пакет, опции);
  const args = ["vite", "--port", String(опции.port ?? 5173), "--host"];
  if (опции.open) args.push("--open");
  npx(root, args);
}

export function buildWeb(root, пакет, опции = {}) {
  prepareWeb(root, пакет, опции);
  const dist = path.join(root, "dist");
  if (existsSync(dist)) rmSync(dist, { recursive: true });
  npx(root, ["vite", "build"]);
  injectServiceWorker(dist, опции.now ?? Math.floor(Date.now() / 1000));
  console.log(`\nWeb build: ${dist}`);
  return dist;
}

/**
 * Порядок файлов в списке офлайн-кэша -- **по частям пути**, не по строке.
 *
 * Разница не косметическая: «a/b/c/deep.js» встаёт раньше «a/b.js», потому что
 * «b» короче «b.js», а строчная сортировка поставила бы их наоборот («.»
 * меньше «/»). Так сортирует `sorted(Path)` в питоне, и так обязан
 * сортировать этот сборщик: отпечаток кэша считается по списку, и другой
 * порядок -- другой отпечаток. Устройство перекачало бы всё приложение
 * заново, и связать это с порядком обхода было бы нечем.
 *
 * Отдельной работой, а не внутри обхода: обход по отсортированным каталогам
 * даёт тот же порядок сам собой, и правило, встроенное в него, проверить
 * нечем -- снятое, оно оставляет сверку зелёной. Замерено.
 */
export function поПорядку(части) {
  return [...части].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    // Досюда доходят только совпавшие целиком: путь-приставка другого пути --
    // это каталог, а собираются одни файлы. Сравнения длин здесь нет намеренно:
    // сработать оно не может, а стояло бы навсегда зелёным.
    return 0;
  });
}

/** Переписать `dist/sw.js` настоящим списком файлов этой сборки. */
export function injectServiceWorker(dist, now) {
  const sw = path.join(dist, "sw.js");
  if (!existsSync(sw)) {
    console.log("warning: dist/sw.js missing, offline support disabled");
    return;
  }
  const файлы = [];
  const обойти = (каталог) => {
    for (const имя of readdirSync(каталог)) {
      const п = path.join(каталог, имя);
      if (statSync(п).isDirectory()) обойти(п);
      else if (!НЕ_КЭШИРОВАТЬ.has(имя)) файлы.push(path.relative(dist, п).split(path.sep));
    }
  };
  обойти(dist);
  const пути = поПорядку(файлы).map((ч) => "./" + ч.join("/"));

  const отпечаток = createHash("sha1")
    .update(пути.join("") + String(now)).digest("hex").slice(0, 12);
  let исходник = readFileSync(sw, "utf8");
  исходник = исходник.replace("/*__ASSETS__*/ []",
                              "[\n" + пути.map((a) => `  "${a}"`).join(",\n") + "\n]");
  исходник = исходник.replace("__BUILD_ID__", отпечаток);
  writeFileSync(sw, исходник, "utf8");

  const всего = пути.reduce((s, a) => s + statSync(path.join(dist, a.slice(2))).size, 0);
  console.log(`Service worker: ${пути.length} assets precached (${(всего / 1e6).toFixed(1)} MB)`);
}

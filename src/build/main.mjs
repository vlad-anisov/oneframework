/**
 * Команда `oneframework` -- одна на все языки.
 *
 *     oneframework declare  app.py            пакет объявления в stdout
 *     oneframework check    app.kt            собрать документы и промолчать
 *     oneframework dev      app.mjs           сервер разработки
 *     oneframework build    web|android app   боевая сборка
 *     oneframework serve    app.py            обмен и клиент с одного адреса
 *     oneframework keygen   ключ.pem          пара ключей издателя
 *
 * На каком языке написано приложение, видно по файлу; чем его прочесть, знает
 * `sources.mjs`. Всё, что дальше, одинаково для всех четырёх.
 *
 * Команда в ядре, а не у привязки. Она собирает приложение на любом языке, и
 * привязка, у которой она живёт, становится обязательной для всех: пока
 * `oneframework` был питоновским, человек с приложением на Kotlin ставил питон
 * ради своего же Kotlin. Привязке остаётся напечатать пакет -- всё.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { bundleOf, SourceError, ЯЗЫКИ } from "./sources.mjs";
import { корень, собрать } from "./cli.mjs";

const КОМАНДЫ = new Set(["declare", "check", "dev", "build", "serve", "keygen"]);
const ЦЕЛИ = new Set(["web", "android"]);

/** Разобрать хвост: флаги со значением, флаги без и всё остальное. */
function разобрать(хвост) {
  const о = { слова: [], port: null, open: false, install: false, force: false,
              host: "127.0.0.1", dist: null, data: null, build: false };
  for (let i = 0; i < хвост.length; i += 1) {
    const а = хвост[i];
    if (а === "--open") о.open = true;
    else if (а === "--install") о.install = true;
    else if (а === "--force") о.force = true;
    else if (а === "--build") о.build = true;
    else if (а === "--port") о.port = Number(хвост[++i]);
    else if (а === "--host") о.host = хвост[++i];
    else if (а === "--dist") о.dist = хвост[++i];
    else if (а === "--data") о.data = хвост[++i];
    else if (а.startsWith("--")) throw new SourceError(`${а}: такого флага нет`);
    else о.слова.push(а);
  }
  return о;
}

/**
 * Проверить пакет, не собирая.
 *
 * Проверяется то, что вообще можно проверить у документа: есть ли корневой
 * вид, все ли ссылки на модели и поля разрешаются, все ли виды собрались.
 * Само **исполнение** объявления делает привязка, когда печатает пакет: у
 * питона `ui` -- это программа, и неизвестное поле вылезает уже там. Отсюда
 * правило: пакет напечатался -- половина проверки уже прошла.
 */
function проверить(doc, пропущено = {}) {
  const беды = [];
  for (const [имя, отказ] of Object.entries(пропущено)) {
    беды.push(`вид «${имя}» объявлен, но не собрался: ${отказ}`);
  }
  const модели = new Map((doc.models || []).map((м) => [м.name, м]));
  const виды = new Map((doc.views || []).map((в) => [в.name, в]));
  if (!виды.size) беды.push("в пакете нет ни одного вида");
  // Корневой вид назван в `app.root`, а не признаком на самом виде: вид не
  // знает, показывают его с порога или из другого вида, и знать не должен.
  const корневой = doc.app?.root;
  if (!корневой) беды.push("не назван корневой вид -- при запуске нечего показать");
  else if (!виды.has(корневой)) беды.push(`корневой вид «${корневой}» не объявлен`);
  for (const экран of doc.app?.screens || []) {
    if (экран.view && !виды.has(экран.view)) {
      беды.push(`раздел «${экран.label || экран.key}» открывает вид «${экран.view}», которого нет`);
    }
  }
  for (const вид of виды.values()) {
    if (вид.model && !модели.has(вид.model)) {
      беды.push(`вид «${вид.name}» объявлен на модели «${вид.model}», которой нет`);
    }
  }
  for (const модель of модели.values()) {
    for (const поле of модель.fields || []) {
      if (поле.comodel && !модели.has(поле.comodel)) {
        беды.push(`${модель.name}.${поле.name} ссылается на модель «${поле.comodel}», которой нет`);
      }
    }
  }
  return беды;
}

/** Пара ключей издателя. */
async function keygen(о) {
  const { generateKeyPairSync } = await import("node:crypto");
  const { chmodSync, writeFileSync } = await import("node:fs");
  const куда = о.слова[0];
  if (!куда) {
    process.stderr.write("oneframework keygen <файл.pem> [--force]\n");
    return 2;
  }
  const путь = path.resolve(куда);
  if (existsSync(путь) && !о.force) {
    throw new SourceError(
      `${путь} уже существует. Перезаписать -- --force, но учтите: старый ключ `
      + "восстановить нельзя, а всё подписанное им перестанет приниматься "
      + "устройствами, которые знают только его.");
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(путь, privateKey.export({ type: "pkcs8", format: "pem" }));
  // Права ставятся здесь, а не оставляются на человека: ключ, созданный
  // доступным на чтение всем, остаётся таким навсегда -- никто больше на него
  // не посмотрит.
  chmodSync(путь, 0o600);
  // Голые 32 байта: у DER-обёртки Ed25519 они последние. Шестнадцатеричным, а
  // не PEM -- на устройстве ключ попадает в `crypto.subtle.importKey("raw")`.
  const публичный = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  console.log(`Приватный ключ: ${путь}  (права 0600)`);
  console.log(`Публичный ключ: ${публичный.toString("hex")}`);
  console.log();
  console.log("Держите файл вне репозитория и назовите его сборке:");
  console.log("    export PYAPP_SIGNING_KEY=" + путь);
  console.log();
  console.log("Сборка с этой переменной подписывает модули логики и кладёт");
  console.log("публичный ключ на устройство; без неё остаётся неподписанной.");
  return 0;
}

/**
 * Обмен и клиент с одного адреса.
 *
 * Сборки нет -- значит её надо сделать, и это делается здесь, чтобы команда
 * осталась одной. Сервер зовётся прямо, а не подпроцессом: мы уже в node.
 */
async function serve(о, appFile, doc, extra) {
  const root = корень();
  const dist = о.dist ? path.resolve(о.dist) : path.join(root, "dist");
  if (о.build || !existsSync(path.join(dist, "index.html"))) {
    console.log(`Собираю веб-клиент в ${dist}…`);
    собрать(doc, { root, доп: extra, source: appFile });
  }
  if (!existsSync(path.join(dist, "index.html"))) {
    throw new SourceError(`Нет собранного веб-клиента в ${dist}.`);
  }
  const { mkdirSync } = await import("node:fs");
  const данные = path.resolve(о.data || path.join(root, "data"));
  mkdirSync(данные, { recursive: true });

  const { serve: поднять } = await import("../http.mjs");
  const s = await поднять({
    file: path.join(данные, "server.db"),
    dist,
    host: о.host,
    port: о.port || 8765,
    standTitle: doc.app?.title || path.basename(path.dirname(path.resolve(appFile))),
  });
  console.log(`Обмен и клиент: http://${s.host}:${s.port}`);
  console.log(`База: ${path.join(данные, "server.db")} | журнал: ${s.server.logSize()}`);
  // Выход по сигналу -- через `stop`: он дописывает базу. Без этого последняя
  // правка осталась бы только в памяти умершего процесса.
  for (const сигнал of ["SIGINT", "SIGTERM"]) {
    process.on(сигнал, async () => { await s.stop(); process.exit(0); });
  }
  return new Promise(() => {});
}

export async function main(argv) {
  const [команда, ...хвост] = argv;
  if (!команда || !КОМАНДЫ.has(команда)) {
    process.stderr.write(
      `oneframework <${[...КОМАНДЫ].join("|")}> <приложение>\n`
      + `Приложение -- файл ${ЯЗЫКИ.join(", ")} либо готовый пакет объявления.\n`);
    return 2;
  }
  const о = разобрать(хвост);
  if (команда === "keygen") return keygen(о);

  // `build` берёт цель первым словом, остальные команды -- только приложение.
  const цель = команда === "build" && ЦЕЛИ.has(о.слова[0]) ? о.слова.shift() : "web";
  const appFile = о.слова[0];
  if (!appFile) {
    process.stderr.write(`oneframework ${команда} <приложение>\n`);
    return 2;
  }
  // `--root` привязке даётся только на сборку: `declare` и `check` ничего не
  // кладут на диск, и возить ради них рантайм на устройство незачем.
  const собираем = команда === "build" || команда === "dev" || команда === "serve";
  const { bundle, extra, skipped } = await bundleOf(appFile, { root: собираем ? корень() : null });

  if (команда === "declare") {
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return 0;
  }
  if (команда === "check") {
    const беды = проверить(bundle, skipped);
    for (const беда of беды) process.stderr.write(`  ${беда}\n`);
    if (беды.length) {
      process.stderr.write(`${appFile}: ${беды.length} шт.\n`);
      return 1;
    }
    // Поимённо, а не счётом: проверка отчитывается о **пакете**, и увидеть
    // надо именно то, что поедет. Счёт сойдётся и тогда, когда уехала не та
    // модель -- скажем, одноимённая из соседнего примера.
    const имена = (что) => (что || []).map((э) => э.name).join(", ") || "нет";
    console.log(`${appFile}: OK`);
    console.log(`  модели: ${имена(bundle.models)}`);
    console.log(`  виды:   ${имена(bundle.views)}`);
    return 0;
  }
  if (команда === "serve") return serve(о, appFile, bundle, extra);
  return собрать(bundle, {
    цель, root: корень(), доп: extra, source: appFile,
    dev: команда === "dev", port: о.port || 5173, open: о.open, install: о.install,
  });
}

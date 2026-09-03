/**
 * Список офлайн-кэша и конфиг сборки -- правилами, а не сверкой с питоном.
 *
 * Пути сортируются **по частям**, а не по строке: обход по строкам поставил бы
 * «a/b.js» раньше «a/b/c/deep.js».
 *
 * Порядок важен не сам по себе: по списку считается отпечаток кэша. Другой
 * порядок -- другой отпечаток, то есть перезакачка всего приложения на ровном
 * месте, и связать её с обходом каталогов было бы нечем.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Bundle } from "../../src/build/bundle.mjs";
import { injectServiceWorker, writeBuildConfig, поПорядку }
  from "../../src/build/web.mjs";

const времянка = () => mkdtempSync(path.join(tmpdir(), "web-build-"));

//: Каверзное дерево: файл и каталог с общим началом имени, вложенность, и то,
//: чему в кэше не место.
const ДЕРЕВО = [
  "index.html", "assets/index-abc.js", "assets/index-abc.css", "assets.txt",
  "a/b/c/deep.js", "a/b.js", "icons/icon-192.png", "sw.js", ".DS_Store",
];

function разложить(корень) {
  for (const имя of ДЕРЕВО) {
    const ф = path.join(корень, имя);
    mkdirSync(path.dirname(ф), { recursive: true });
    writeFileSync(ф, имя === "sw.js" ? "/*__ASSETS__*/ []\n__BUILD_ID__\n" : имя, "utf8");
  }
  return корень;
}

const прочитать = (dist) => readFileSync(path.join(dist, "sw.js"), "utf8");
const список = (текст) => JSON.parse(текст.slice(текст.indexOf("["),
                                                 текст.indexOf("]", текст.indexOf("[")) + 1));

test("в кэш попадает всё, кроме самого воркера", () => {
  const dist = разложить(path.join(времянка(), "dist"));
  injectServiceWorker(dist, 1_700_000_000);
  const в_кэше = список(прочитать(dist));
  // Свой файл в свой же кэш класть нельзя: обновиться он тогда не сможет.
  assert.ok(!в_кэше.includes("./sw.js"));
  assert.ok(!в_кэше.includes("./.DS_Store"));
  assert.deepEqual(в_кэше.slice().sort(),
                   ДЕРЕВО.filter((и) => и !== "sw.js" && и !== ".DS_Store")
.map((и) => `./${и}`).sort());
});

test("отпечаток сборки попадает в воркер", () => {
  // Имя кэша обязано смениться вместе со сборкой -- иначе старое останется.
  const dist = разложить(path.join(времянка(), "dist"));
  injectServiceWorker(dist, 1_700_000_000);
  assert.ok(!прочитать(dist).includes("__BUILD_ID__"), "отпечаток не подставлен");
});

test("отпечаток следует за мгновением сборки", () => {
  // Две сборки одного дерева в разные секунды -- разные отпечатки.
  const где = времянка();
  const отпечатки = [1_700_000_000, 1_700_000_001].map((время) => {
    const dist = разложить(path.join(где, `dist-${время}`));
    injectServiceWorker(dist, время);
    return прочитать(dist).split("\n").at(-2) ?? "";
  });
  assert.notEqual(отпечатки[0], отпечатки[1], отпечатки);
});

test("пропавший воркер -- предупреждение, а не падение", () => {
  // `sw.js` нет -- офлайна просто не будет.
  const пусто = path.join(времянка(), "пусто");
  mkdirSync(пусто, { recursive: true });
  const сказано = [];
  const прежний = console.log;
  console.log = (...ч) => сказано.push(ч.join(" "));
  try { injectServiceWorker(пусто, 1_700_000_000); } finally { console.log = прежний; }
  assert.match(сказано.join("\n"), /sw\.js missing/);
});

//: Перемешанный список -- чтобы порядок задавала сортировка, а не обход.
//:
//: Через файловую систему это правило **не проверить**: обход выдаёт имена в
//: том порядке, в каком их отдаёт файловая система, а APFS отдаёт их уже
//: отсортированными -- снятая сортировка оставляла ту проверку зелёной,
//: замерено. Проверка, зависящая от файловой системы, -- не проверка. Поэтому
//: правило проверяется прямо и перемешанным входом.
const ПУТИ = [
  "assets.txt", "a/b.js", "index.html", "a/b/c/deep.js",
  "assets/index-abc.css", "icons/icon-192.png", "assets/index-abc.js",
  "a/b/c.js", "a/bb.js", "z", "a/b/c/d/e.js",
];

test("пути упорядочены по частям, а не как строки", () => {
  // «a/b/c/deep.js» раньше «a/b.js»: «b» короче «b.js», а «.» меньше «/».
  //
  // Правило то же, что у `sorted(Path)` в питоне, и это не совпадение: под ним
  // собраны все прежние сборки, и сменить порядок значило бы обесценить кэш у
  // всех, кто уже поставил приложение. Ожидаемое записано списком, а не вычислено
  // тем же кодом: вычисленное сошлось бы с любой ошибкой сортировки.
  const ждём = [
    "a/b/c/d/e.js", "a/b/c/deep.js", "a/b/c.js", "a/b.js", "a/bb.js",
    "assets/index-abc.css", "assets/index-abc.js", "assets.txt",
    "icons/icon-192.png", "index.html", "z",
  ];
  assert.deepEqual(поПорядку(ПУТИ.map((п) => п.split("/"))).map((ч) => ч.join("/")), ждём);
  // Строчная сортировка дала бы другое -- иначе проверять было бы нечего.
  assert.notDeepEqual(ждём, ПУТИ.slice().sort());
});

/** Конфиг сборки для подопытного todo, с поставкой или без неё. */
async function конфиг(поставка = null) {
  const { подопытноеTodo } = await import("./помощь.mjs");
  const корень = времянка();
  mkdirSync(path.join(корень, "web", "public"), { recursive: true });
  if (поставка !== null) {
    writeFileSync(path.join(корень, "web", "public", "oneframework-bundle.zip"), поставка);
  }
  writeBuildConfig(корень, new Bundle(await подопытноеTodo()));
  return JSON.parse(readFileSync(path.join(корень, ".oneframework-build.json"), "utf8"));
}

test("конфиг несёт то, что оболочке нужно до базы", async () => {
  // Тема и цвет читаются раньше базы -- по ним строится Framework7.
  const к = await конфиг();
  assert.deepEqual(Object.keys(к).sort(),
                   ["build", "color", "dynamic_color", "theme", "title"]);
  assert.equal(к.title, "Todo");
  assert.ok(к.color.startsWith("#"));
  assert.equal(к.build, "dev", "поставки нет -- отпечатку неоткуда взяться");
});

test("отпечаток следует за поставкой", async () => {
  // Он обесценивает кэш снимка интерпретатора: не сменись он вместе с
  // поставкой, устройство подняло бы старый снимок к новому приложению -- и
  // разошлись бы они молча, уже у пользователя.
  const один = await конфиг(Buffer.from("PK\x03\x04".repeat(64)));
  const другой = await конфиг(Buffer.from("PK\x03\x04".repeat(65)));
  assert.notEqual(один.build, "dev");
  assert.equal(один.build.length, 16, один.build);
  assert.notEqual(один.build, другой.build, "отпечаток не следует за поставкой");
});

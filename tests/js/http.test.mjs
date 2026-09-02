/**
 * HTTP сервера обмена: точка обмена, предполётный ответ, раздача клиента,
 * ограждение от обхода каталога и долговечность базы.
 *
 * Этот файл -- единственный, кто держит эти правила, и мерить он обязан не
 * «работает», а **каждое правило поимённо**.
 *
 * Сервер поднимается по-настоящему, на свободном порту, и стучатся в него так
 * же, как стучалось бы устройство.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveStatic, serve } from "../../../oneframework-js/src/http.mjs";

let каталог, статика, файл, сервер, адрес;

before(async () => {
  каталог = mkdtempSync(join(tmpdir(), "of-http-"));
  статика = join(каталог, "dist");
  mkdirSync(статика, { recursive: true });
  writeFileSync(join(статика, "index.html"), "<!doctype html><title>стенд</title>");
  writeFileSync(join(статика, "app.js"), "console.log(1);\n");
  // Файл **рядом** с корнем раздачи и заведомо существующий. Целиться в
  // `server.db` было нельзя: он появляется только при остановке сервера, и
  // `existsSync` возвращал ложь -- проверка зеленела со снятым сторожем.
  writeFileSync(join(каталог, "секрет.txt"), "это наружу отдавать нельзя");
  файл = join(каталог, "server.db");
  сервер = await serve({ port: 0, file: файл, dist: статика, flushMs: 20 });
  адрес = `http://127.0.0.1:${сервер.http.address().port}`;
});

after(async () => { await сервер.stop(); });

async function взять(путь, настройки) {
  const r = await fetch(адрес + путь, настройки);
  const тип = r.headers.get("content-type") || "";
  return {
    код: r.status,
    тип,
    разрешено: r.headers.get("access-control-allow-headers"),
    источник: r.headers.get("access-control-allow-origin"),
    стенд: r.headers.get("x-pyapp-stand"),
    тело: тип.includes("json") ? await r.json() : (await r.text()).slice(0, 40),
  };
}

const круг = (тело) => взять("/sync", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(тело),
});

test("точка обмена отвечает по HTTP", async () => {
  // Круг обмена доезжает через настоящий POST, а не только вызовом.
  const о = await круг({ protocol: 1, schema: сервер.server.schema, node: "n1",
                         cursor: 0, changes: [] });
  assert.equal(о.код, 200);
  assert.equal(о.тело.protocol, 1);
  assert.equal(о.тело.error ?? null, null);
  assert.equal(о.тело.cursor, 0);
});

test("разошедшаяся схема возвращается ответом, а не обрывом", async () => {
  // Отказ обмена -- это ответ: устройству есть что с ним делать. Пустой разрыв
  // связи оно объяснить не может, а отказ со словами -- может.
  const о = await круг({ protocol: 1, schema: "чужая", node: "n1", changes: [] });
  assert.equal(о.код, 200);
  assert.match(о.тело.error, /Схемы разошлись/);
});

test("предполёт разрешает заголовок, который шлёт устройство", async () => {
  // `Authorization` устройство шлёт всегда, когда обмен закрыт ключом.
  // Заголовок, не названный в предполётном ответе, браузер не пропускает -- и
  // не пропускает молча. С одного источника это не видно вовсе: беда вылезает
  // в вебвью Capacitor и в PWA на другом домене.
  const о = await взять("/sync", { method: "OPTIONS" });
  assert.equal(о.код, 204);
  const разрешено = new Set((о.разрешено || "").split(",").map((ч) => ч.trim()));
  for (const нужен of ["Content-Type", "Authorization"]) assert.ok(разрешено.has(нужен), о.разрешено);
});

test("стенд говорит вслух, что он открыт", async () => {
  // Без ключа -- сказать об этом, а не умолчать.
  const о = await взять("/sync");
  assert.equal(о.тело.auth, false);
  assert.equal(о.стенд, "test; no authentication");
  assert.equal(о.источник, "*");
});

test("собранный клиент раздаётся", async () => {
  const корень = await взять("/");
  assert.equal(корень.код, 200);
  assert.match(корень.тип, /text\/html/);
  const файлJS = await взять("/app.js");
  assert.equal(файлJS.код, 200);
  assert.match(файлJS.тип, /javascript/);
  assert.equal((await взять("/нет-такого.js")).код, 404);
});

test("наружу не достаётся ничего, кроме собранного клиента", async () => {
  // Первое из двух дешёвых ограждений: наружу отдаётся только `dist`. База
  // сервера лежит рядом с ним, и достать её по HTTP не должно выйти ни
  // точкой-точкой, ни ссылкой.
  //
  // Через HTTP -- двумя дорогами: с закодированными точками и сырым запросом,
  // который node не нормализует. `fetch` сам приводит `/../` ещё до отправки,
  // и сторож при этом не зовётся вовсе.
  const сырой = (путь) => new Promise((готово) => {
    const req = request({ host: "127.0.0.1", port: сервер.http.address().port, path: путь },
                        (r) => { r.resume(); готово(r.statusCode); });
    req.on("error", () => готово(0));
    req.end();
  });
  assert.equal((await взять("/%2e%2e/%D1%81%D0%B5%D0%BA%D1%80%D0%B5%D1%82.txt")).код, 404);
  assert.equal(await сырой("/../%D1%81%D0%B5%D0%BA%D1%80%D0%B5%D1%82.txt"), 404);
  // И напрямую у сторожа: первая редакция этой проверки была зелёной со снятым
  // сторожем -- ловится только так.
  assert.equal(resolveStatic(статика, "/../секрет.txt"), null);
  assert.equal(resolveStatic(статика, "/%2e%2e%2fсекрет.txt"), null);
  assert.ok(resolveStatic(статика, "/app.js"));
});

test("база переживает перезапуск", async () => {
  // SQLite под node живёт в памяти, и файл -- это выгрузка байтами. Значит
  // долговечность здесь не даётся сама собой, как в OPFS: её надо проверять,
  // иначе сервер теряет всё при первом же перезапуске -- молча.
  const свой = join(каталог, "перезапуск.db");
  const первый = await serve({ port: 0, file: свой, dist: статика, flushMs: 20 });
  первый.db.connect().execute('CREATE TABLE IF NOT EXISTS "проба" (id TEXT PRIMARY KEY, t TEXT)');
  первый.db.connect().execute('INSERT OR REPLACE INTO "проба" VALUES (?,?)', ["a", "пережило"]);
  первый.db.commit();
  await первый.stop();

  // Через `finally`: упавшая проверка иначе оставит слушателя открытым, и
  // прогон не завершится вовсе -- падение выглядело бы зависанием.
  const второй = await serve({ port: 0, file: свой, dist: статика, flushMs: 20 });
  try {
    assert.deepEqual(второй.db.connect()
.execute('SELECT t FROM "проба" WHERE id = ?', ["a"]).map((r) => r.t), ["пережило"]);
  } finally { await второй.stop(); }
});

test("правка на диске раньше ответа", async () => {
  // Ответ «принято» -- обещание, и до записи его давать нельзя. Устройство,
  // получившее подтверждение, вправе выбросить changeset из своей очереди.
  // Скажи сервер «принято» и умри до записи -- правка не существует больше
  // нигде.
  //
  // Прежде сохранение шло по таймеру, и процесс, убитый между тиками,
  // терял до секунды чужой работы -- молча. Разница в долговечности была бы
  // худшим родом разницы -- незаметной.
  //
  // Таймер здесь выставлен в час, а сервер бросается без остановки: если
  // правка на диске, значит её положил обмен, а не таймер и не выход.
  const свой = join(каталог, "жёстко.db");
  const первый = await serve({ port: 0, file: свой, flushMs: 3_600_000 });
  первый.db.connect().execute('CREATE TABLE IF NOT EXISTS "т" (id TEXT PRIMARY KEY, v TEXT)');
  первый.db.connect().execute('INSERT OR REPLACE INTO "т" VALUES (?,?)', ["a", "до обмена"]);
  первый.db.commit();
  await fetch(`http://127.0.0.1:${первый.http.address().port}/sync`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocol: 1, schema: первый.server.schema, node: "n9",
                           cursor: 0, changes: [] }),
  });
  // Закрыть слушателя, но **не сохранять** -- это и есть убийство процесса с
  // точки зрения диска. Слушателя всё же закрываем: иначе node не выйдет.
  первый.http.close();

  const другой = await serve({ port: 0, file: свой, flushMs: 3_600_000 });
  try {
    assert.deepEqual(другой.db.connect()
.execute('SELECT v FROM "т" WHERE id = ?', ["a"]).map((r) => r.v), ["до обмена"]);
  } finally { await другой.stop(); }
});

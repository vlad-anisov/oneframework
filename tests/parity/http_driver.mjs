/**
 * HTTP сервера обмена на JS -- под node, с настоящими запросами.
 *
 * Драйвер поднимает сервер на свободном порту, стучится в него так же, как
 * стучалось бы устройство, и отдаёт питону то, что увидел. Сверяется с
 * питоновскому серверу (`server.py`, удалён) через `tests/test_js_http.py`.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { request } from "node:http";

import { resolveStatic, serve } from "../../src/http.mjs";

const каталог = mkdtempSync(join(tmpdir(), "of-http-"));
const статика = join(каталог, "dist");
mkdirSync(статика, { recursive: true });
writeFileSync(join(статика, "index.html"), "<!doctype html><title>стенд</title>");
writeFileSync(join(статика, "app.js"), "console.log(1);\n");
//: Файл **рядом** с корнем раздачи и заведомо существующий. Целиться в
//: `server.db` было нельзя: он появляется только при остановке сервера, и
//: `existsSync` возвращал ложь -- проверка зеленела со снятым сторожем.
writeFileSync(join(каталог, "секрет.txt"), "это наружу отдавать нельзя");

const файл = join(каталог, "server.db");
const ответ = {};

let s = await serve({ port: 0, file: файл, dist: статика, flushMs: 20 });
const адрес = `http://127.0.0.1:${s.http.address().port}`;

//: Сырой запрос: `node:http` кладёт путь в строку как есть, не нормализуя.
const новыйЗапрос = (путь) => new Promise((готово) => {
  const req = request({ host: "127.0.0.1", port: s.http.address().port, path: путь },
                      (r) => { r.resume(); готово({ код: r.statusCode }); });
  req.on("error", (e) => готово({ код: 0, ошибка: e.message }));
  req.end();
});

const взять = async (путь, настройки) => {
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
};

ответ.паспорт = await взять("/sync");
ответ.предполёт = await взять("/sync", { method: "OPTIONS" });
ответ.обмен = await взять("/sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ protocol: 1, schema: s.server.schema, node: "n1",
                         cursor: 0, changes: [] }),
});
ответ.чужаясхема = await взять("/sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ protocol: 1, schema: "чужая", node: "n1", changes: [] }),
});
ответ.корень = await взять("/");
ответ.файл = await взять("/app.js");
ответ.нетТакого = await взять("/нет-такого.js");
// Обход каталога проверяется двумя способами, и оба нужны. `fetch` сам
// нормализует `/../` ещё до отправки -- запрос уходит уже как `/server.db`, и
// сторож при этом не зовётся вовсе. Первая редакция проверки на этом и
// провалилась: сторожа сняли, а она осталась зелёной.
ответ.обходКаталога = await взять("/%2e%2e/%D1%81%D0%B5%D0%BA%D1%80%D0%B5%D1%82.txt");
ответ.обходСырой = await новыйЗапрос("/../%D1%81%D0%B5%D0%BA%D1%80%D0%B5%D1%82.txt");
ответ.сторож = {
  наружу: resolveStatic(статика, "/../секрет.txt"),
  вбок: resolveStatic(статика, "/%2e%2e%2fсекрет.txt"),
  свой: Boolean(resolveStatic(статика, "/app.js")),
};

// Долговечность без остановки: правка через POST обязана лежать на диске
// **до** ответа. Устройство, получившее «принято», вправе выбросить changeset
// из своей очереди -- скажи сервер «принято» и умри до записи, правка не
// существовала бы больше нигде.
{
  const своя = await serve({ port: 0, file: join(каталог, "жёстко.db"),
                             flushMs: 3_600_000 });   // таймер заведомо не сработает
  const адрес2 = `http://127.0.0.1:${своя.http.address().port}`;
  своя.db.connect().execute('CREATE TABLE IF NOT EXISTS "т" (id TEXT PRIMARY KEY, v TEXT)');
  своя.db.connect().execute('INSERT OR REPLACE INTO "т" VALUES (?,?)', ["a", "до обмена"]);
  своя.db.commit();
  await fetch(адрес2 + "/sync", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocol: 1, schema: своя.server.schema, node: "n9",
                           cursor: 0, changes: [] }),
  });
  // Остановка **без сохранения** -- это и есть убийство процесса с точки
  // зрения диска. Слушателя закрываем: иначе node не выйдет и драйвер повиснет
  // навсегда -- на чём первая редакция и повисла.
  своя.http.close();
  const другой = await serve({ port: 0, file: join(каталог, "жёстко.db"),
                               flushMs: 3_600_000 });
  ответ.безОстановки = другой.db.connect()
    .execute('SELECT v FROM "т" WHERE id = ?', ["a"]).map((r) => r.v);
  await другой.stop();
}

// Долговечность: записать, остановить, поднять заново, прочитать.
s.db.connect().execute('CREATE TABLE IF NOT EXISTS "проба" (id TEXT PRIMARY KEY, t TEXT)');
s.db.connect().execute('INSERT OR REPLACE INTO "проба" VALUES (?,?)', ["a", "пережило"]);
s.db.commit();
await s.stop();

s = await serve({ port: 0, file: файл, dist: статика, flushMs: 20 });
ответ.послеПерезапуска = s.db.connect()
  .execute('SELECT t FROM "проба" WHERE id = ?', ["a"])
  .map((r) => r.t);
await s.stop();

process.stdout.write(JSON.stringify(ответ));

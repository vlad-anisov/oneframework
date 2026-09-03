/**
 * HTTP вокруг `SyncServer` -- вторая половина сервера обмена на JS.
 *
 * Умеет ровно то же и ровно столько: одна точка обмена, раздача собранного
 * веб-клиента и заголовки, без которых вебвью Capacitor не дозвонится.
 *
 * Долговечность. `@sqlite.org/sqlite-wasm` под node держит базу в памяти:
 * OPFS там нет, а файлового VFS у этой сборки нет тоже. Поэтому база
 * поднимается из файла байтами и выгружается обратно -- `sqlite3_js_db_export`.
 * Выгрузка не после каждой правки, а по таймеру и на выходе: снимок миллиона
 * строк стоит десятков миллисекунд, и платить их на каждый POST незачем.
 *
 * Это **не** быстрее и не лучше питоновского. Это доказательство, что
 * обходиться без него можно: пока стенд не поднимется на нём и не отработает,
 * удалять питоновский нельзя.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { Database } from "./core/runtime/db.js";
import { makeModels } from "./core/runtime/fields.js";
import { loadSchema } from "./core/runtime/defs.js";
import * as sync from "./core/runtime/sync.js";
import { SyncServer } from "./server.mjs";

//: Что говорится о стенде тем, кто спросит. Слово в слово как у питона: это
//: обещание человеку, а не украшение.
export const STAND_NOTE = "test; no authentication";

const ТИПЫ = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * Файл под корнем -- или `null`.
 *
 * Первое из двух дешёвых ограждений: сервер отдаёт **только** собранный
 * веб-клиент. Путь приводится к настоящему и обязан лежать внутри корня; ни
 * `..`, ни ссылка наружу не проходят, и база сервера -- она в другом каталоге
 * -- недостижима по HTTP вовсе.
 */
export function resolveStatic(корень, путь) {
  if (!корень) return null;
  const база = resolve(корень);
  const хвост = decodeURIComponent(String(путь).split("?")[0].split("#")[0])
    .replace(/^\/+/, "");
  const цель = resolve(join(база, хвост || "index.html"));
  if (цель !== база && !цель.startsWith(база + sep)) return null;
  return existsSync(цель) && !цель.endsWith(sep) ? цель : null;
}

/**
 * Поднять базу из файла в память. Файла нет -- база пустая.
 *
 * Отказ на WAL -- не придирка. База в памяти файла журнала не имеет, а
 * заголовок, помеченный как WAL, требует его при первом же запросе: SQLite
 * отвечает `SQLITE_CANTOPEN`, и понять по нему, что дело в режиме журнала,
 * нельзя ничем. Замерено 20.08.2026 на живой базе стенда: отказывало даже
 * `PRAGMA journal_mode = MEMORY`, потому что и она -- запрос.
 *
 * Лечится одной строкой на той стороне: `PRAGMA journal_mode = DELETE`.
 */
function поднять(sqlite3, файл) {
  if (файл && existsSync(файл)) {
    const байты = new Uint8Array(readFileSync(файл));
    // Байты 18 и 19 заголовка -- версии записи и чтения. Двойка значит WAL.
    if (байты.length > 19 && (байты[18] === 2 || байты[19] === 2)) {
      throw new Error(
        `База ${файл} в режиме WAL, а поднять её надо в память -- файла журнала `
        + "у такой базы нет, и SQLite откажет невнятным SQLITE_CANTOPEN на "
        + "первом же запросе. Переведите её один раз: "
        + `sqlite3 ${файл} 'PRAGMA journal_mode=DELETE'`,
      );
    }
    const p = sqlite3.wasm.allocFromTypedArray(байты);
    //: Имя обязательно: `new DB()` без него пытается открыть файл и отказывает
    //: `SQLITE_CANTOPEN`. Байты приезжают следом, `sqlite3_deserialize`.
    const db = new sqlite3.oo1.DB(":memory:");
    sqlite3.capi.sqlite3_deserialize(
      db.pointer, "main", p, байты.length, байты.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE
        | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    return db;
  }
  return new sqlite3.oo1.DB(":memory:");
}

/** Выгрузить базу в файл. Через временное имя: обрыв на записи не портит базу. */
function сохранить(sqlite3, handle, файл) {
  if (!файл) return;
  const байты = sqlite3.capi.sqlite3_js_db_export(handle.pointer);
  mkdirSync(dirname(файл), { recursive: true });
  const врем = `${файл}.new`;
  writeFileSync(врем, Buffer.from(байты));
  writeFileSync(файл, readFileSync(врем));
}

/**
 * Поднять сервер обмена.
 *
 * @param file      куда класть базу; `null` -- держать в памяти
 * @param dist      корень собранного веб-клиента или `null`
 * @param port      порт
 * @param flushMs   как часто выгружать базу на диск
 */
export async function serve({ file = null, dist = null, port = 8765,
                              host = "127.0.0.1", flushMs = 2000,
                              standTitle = null } = {}) {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  const handle = поднять(sqlite3, file);
  // База живёт в памяти: файла для журнала у неё нет, и умолчание `DELETE`
  // отказало бы `SQLITE_CANTOPEN`. Долговечность здесь даёт не журнал, а
  // выгрузка байтами -- по таймеру и на выходе.
  const db = new Database(handle, { sqlite3, journal: "MEMORY" });
  const api = new sync.SessionApi(sqlite3);

  // Схема берётся из самой базы, а не из объявления: обмен возит строки, и
  // сторожить ему надо места колонок, а не то, какими их задумывали.
  const схема = loadSchema(db);
  if (схема.models.length) db.ensureSchema(Object.values(makeModels(схема)));

  const сервер = new SyncServer(db, api, null);

  // Сохранение -- **сразу после правки**, а не по таймеру. Таймер оставлял
  // окно: процесс, убитый между тиками, терял до `flushMs` миллисекунд чужой
  // работы, и терял молча. У питоновского сервера такого окна нет -- там
  // журнал SQLite на диске, -- и разница в долговечности была бы худшим родом
  // разницы: незаметным.
  //
  // Замерено 20.08.2026, на чём и основано решение: выгрузка базы стенда
  // (528 КБ) -- 0,14 мс, запись на диск -- 0,80 мс; на восьми мегабайтах
  // (200 000 строк) выгрузка 2,25 мс. Миллисекунда на POST -- не та цена, за
  // которую покупают окно потери.
  //
  // Таймер остался сторожем на то, что правит базу мимо точки обмена: сейчас
  // такого нет, но появись оно -- лучше секунда, чем ничего.
  let грязно = false;
  const таймер = setInterval(() => {
    if (!грязно) return;
    грязно = false;
    сохранить(sqlite3, handle, file);
  }, flushMs);
  таймер.unref?.();

  const шапки = (доп = {}) => ({
    "Access-Control-Allow-Origin": "*",
    "X-Pyapp-Stand": STAND_NOTE,
    ...доп,
  });

  const http = createServer(async (req, res) => {
    const путь = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      // `Authorization` здесь не для полноты: устройство шлёт его всегда, когда
      // обмен закрыт ключом. Разрешая один `Content-Type`, сервер сам запрещал
      // бы браузеру этот запрос -- и запрещал молча.
      res.writeHead(204, шапки({
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      }));
      res.end();
      return;
    }

    if (путь === "/sync") {
      if (req.method === "GET") {
        const тело = JSON.stringify({
          protocol: sync.PROTOCOL, stand: standTitle || "js", auth: false,
          note: STAND_NOTE, log: сервер.logSize(),
        });
        res.writeHead(200, шапки({ "Content-Type": "application/json; charset=utf-8",
                                   "Cache-Control": "no-store" }));
        res.end(тело);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, шапки()); res.end(); return;
      }
      let сырое = "";
      for await (const кусок of req) сырое += кусок;
      let ответ;
      try {
        ответ = await сервер.sync(сырое);
        // Сохранение до ответа, а не после: устройство, получившее «принято»,
        // вправе выбросить changeset из своей очереди. Скажи мы «принято» и
        // умри до записи -- правка не существует больше нигде.
        сохранить(sqlite3, handle, file);
      } catch (err) {
        // Отказ обмена -- это ответ, а не пятисотая: у устройства есть что с
        // ним делать, а с пустым разрывом связи -- нечего.
        ответ = { protocol: sync.PROTOCOL, error: `${err.name}: ${err.message}` };
      }
      const тело = JSON.stringify(ответ);
      res.writeHead(200, шапки({ "Content-Type": "application/json; charset=utf-8",
                                 "Cache-Control": "no-store" }));
      res.end(тело);
      return;
    }

    if (req.method !== "GET") { res.writeHead(405, шапки()); res.end(); return; }

    const файл = resolveStatic(dist, req.url || "/");
    if (!файл) { res.writeHead(404, шапки()); res.end("нет такого"); return; }
    const тело = readFileSync(файл);
    res.writeHead(200, шапки({
      "Content-Type": ТИПЫ[extname(файл)] || "application/octet-stream",
      "Content-Length": String(тело.length),
    }));
    res.end(тело);
  });

  await new Promise((готово) => http.listen(port, host, готово));

  const остановить = async () => {
    clearInterval(таймер);
    сохранить(sqlite3, handle, file);
    await new Promise((готово) => http.close(готово));
  };
  return { http, server: сервер, db, stop: остановить, port, host };
}

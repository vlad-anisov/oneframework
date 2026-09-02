/**
 * Транспорт обмена на клиенте: круг, расписание, обрыв, отсутствие сети.
 *
 * Механизм обмена проверяется отдельно (`test_sync.py`, `test_js_sync_parity.py`)
 * и здесь не повторяется -- ни один из этих случаев не про changeset'ы. Здесь
 * проверяется то, чего у механизма нет и не должно быть: **когда** заводится
 * круг и **что видно**, когда он не удался.
 *
 * Всё, что транспорту нужно снаружи, он принимает аргументами -- `fetch`, часы,
 * таймеры, признак сети, -- поэтому проверяется он тем же файлом, который
 * поедет в браузер, а не его пересказом. Взамен подделываются ровно три вещи:
 * хост рантайма, сеть и время.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveEndpoint, SyncTransport, describe, sinceText, PHASE }
  from "../../web/src/runtime/transport.js";

/** Хост: очередь исходящего и счётчик наложенного. */
function хост({ pending = 1, applied = 0 } = {}) {
  const h = {
    pending,
    calls: { envelope: 0, apply: 0, status: 0 },
    async pendingChanges() {
      h.calls.envelope += 1;
      return {
        protocol: 1, node: "node-a", schema: "s", cursor: 0,
        changes: Array.from({ length: h.pending }, (_, i) => ({
          id: `c${i}`, stamp: "st", blob: "AA==",
        })),
        defs: {},
      };
    },
    async applyChanges() {
      h.calls.apply += 1;
      h.pending = 0;                          // сервер подтвердил -- очередь пуста
      return { snapshot: { screens: [] }, sync: { applied, skipped: 0, conflicts: 0 } };
    },
    async syncStatus() {
      h.calls.status += 1;
      return { enabled: true, pending: h.pending };
    },
  };
  return h;
}

/** Таймеры, которые не идут сами: время двигает проверка. */
function часы() {
  let seq = 0;
  const jobs = new Map();
  return {
    api: {
      set: (fn, ms) => { const id = ++seq; jobs.set(id, { fn, ms }); return id; },
      clear: (id) => { jobs.delete(id); },
    },
    /** Выполнить всё запланированное. */
    async fire() {
      const due = [...jobs.values()];
      jobs.clear();
      for (const job of due) await job.fn();
    },
    delays: () => [...jobs.values()].map((j) => j.ms),
  };
}

const ok = (тело) => ({ ok: true, status: 200, json: async () => тело });
const дать = () => new Promise((r) => setTimeout(r, 0));

test("куда ходить: явный адрес, свой собственный и никакой", () => {
  assert.equal(resolveEndpoint({ meta: { sync: "https://terminal.anisov.by" } }),
               "https://terminal.anisov.by/sync");
  assert.equal(resolveEndpoint({ meta: { sync: "https://terminal.anisov.by/" } }),
               "https://terminal.anisov.by/sync");
  assert.equal(resolveEndpoint({ meta: { sync: "https://host/app" } }), "https://host/app/sync");
  // Веб-клиент, отданный самим сервером обмена: настройки нет и не нужно.
  assert.equal(resolveEndpoint({ meta: {}, base: "https://terminal.anisov.by/index.html" }),
               "https://terminal.anisov.by/sync");
  assert.equal(resolveEndpoint({ meta: {}, base: "https://host/app/index.html" }),
               "https://host/app/sync");
  // Внутри Capacitor origin принадлежит вебвью -- своего сервера там нет.
  assert.equal(resolveEndpoint({ meta: {}, base: "https://localhost/index.html", native: true }),
               null);
  assert.equal(resolveEndpoint({ meta: { sync: "https://terminal.anisov.by" },
                                 base: "https://localhost/", native: true }),
               "https://terminal.anisov.by/sync");
  assert.equal(resolveEndpoint({ meta: { sync: false }, base: "https://host/" }), null);
  assert.equal(resolveEndpoint({ meta: { sync: "off" }, base: "https://host/" }), null);
  assert.equal(resolveEndpoint({ meta: { sync: "https://a/" }, override: "https://b/" }),
               "https://b/sync");
  assert.equal(resolveEndpoint({ meta: {}, base: "file:///Users/x/index.html" }), null);
});

test("один круг: конверт уехал, ответ наложен, очередь опустела", async () => {
  const h = хост({ pending: 2, applied: 3 });
  const видели = [], состояния = [];
  let показано = 0;
  const t = часы();
  const транспорт = new SyncTransport({
    host: h,
    endpoint: "https://host/sync",
    timers: t.api,
    now: () => 1000,
    fetch: async (url, init) => {
      видели.push({ url, body: JSON.parse(init.body) });
      return ok({ protocol: 1, accepted: ["c0", "c1"], changes: [], cursor: 7 });
    },
    onChange: (s) => состояния.push(s.phase),
    onApplied: () => { показано += 1; },
  });
  транспорт.start();
  await транспорт.run("test");                // тот же круг, а не второй

  assert.equal(видели.length, 1);
  assert.equal(видели[0].url, "https://host/sync");
  assert.equal(видели[0].body.changes.length, 2);
  // Состояние проходит через «идёт обмен» -- иначе показывать было бы нечего.
  assert.ok(состояния.includes("syncing"), состояния);
  assert.equal(транспорт.state.phase, "idle");
  assert.equal(транспорт.state.pending, 0, "подтверждённое больше не висит в очереди");
  assert.equal(транспорт.state.lastAt, 1000);
  assert.equal(транспорт.state.applied, 3);
  assert.equal(показано, 1, "принятые строки обязаны попасть в кадр");
  assert.deepEqual(t.delays(), [15000], "следующий круг назначен");
});

test("два повода разом -- один запрос", async () => {
  const h = хост({ pending: 1 });
  let запросов = 0;
  const транспорт = new SyncTransport({
    host: h,
    endpoint: "https://host/sync",
    timers: часы().api,
    fetch: async () => { запросов += 1; return ok({ protocol: 1, accepted: [], changes: [], cursor: 1 }); },
  });
  const [a, b] = await Promise.all([транспорт.run("one"), транспорт.run("two")]);
  assert.equal(запросов, 1);
  assert.equal(h.calls.envelope, 1, "конверт снимается один раз, а не дважды");
  assert.equal(a, b);
});

test("нет сети: в сеть не ходим, очередь видна, срока не назначаем", async () => {
  const h = хост({ pending: 4 });
  let запросов = 0;
  const t = часы();
  const транспорт = new SyncTransport({
    host: h,
    endpoint: "https://host/sync",
    timers: t.api,
    isOnline: () => false,
    fetch: async () => { запросов += 1; return ok({}); },
  });
  транспорт.start();
  await транспорт.run("test");
  assert.equal(транспорт.state.phase, "offline");
  assert.equal(запросов, 0, "без сети в сеть не ходим");
  assert.equal(транспорт.state.pending, 4, "неотправленное видно и офлайн");
  // Срока не назначаем: возвращение сети -- событие.
  assert.equal(t.delays().length, 0);

  // Сеть вернулась -- накопленное догоняет.
  транспорт._isOnline = () => true;
  транспорт._fetch = async () =>
    ok({ protocol: 1, accepted: ["c0", "c1", "c2", "c3"], changes: [], cursor: 2 });
  await транспорт.wake();
  assert.equal(транспорт.state.phase, "idle");
  assert.equal(транспорт.state.pending, 0);
});

test("обрыв связи: очередь цела, пауза нарастает и упирается в потолок", async () => {
  const h = хост({ pending: 1 });
  const t = часы();
  const транспорт = new SyncTransport({
    host: h,
    endpoint: "https://host/sync",
    timers: t.api,
    options: { backoff: [10, 20, 40] },
    fetch: async () => { throw new Error("connect ECONNREFUSED"); },
  });
  транспорт.start();                          // start() заводит первый круг
  await дать();
  const паузы = [t.delays()[0]];
  for (let i = 0; i < 3; i += 1) {            // ступеней три -- дальше та же
    await транспорт.run("again");
    паузы.push(t.delays()[0]);
  }
  assert.equal(транспорт.state.phase, "error");
  assert.equal(транспорт.state.pending, 1, "очередь при обрыве цела");
  assert.match(транспорт.state.lastError, /ECONNREFUSED/);
  assert.deepEqual(паузы, [10, 20, 40, 40], "пауза растёт и упирается в потолок");
  assert.equal(h.calls.apply, 0);
});

test("отказ по существу -- это не обрыв связи", async () => {
  const h = хост({ pending: 1 });
  const t = часы();
  const транспорт = new SyncTransport({
    host: h,
    endpoint: "https://host/sync",
    timers: t.api,
    options: { backoff: [10, 20, 40] },
    fetch: async () => ok({ protocol: 1, error: "Схемы разошлись" }),
  });
  транспорт.start();
  await дать();
  assert.equal(транспорт.state.phase, "error");
  assert.match(транспорт.state.lastError, /Схемы разошлись/);
  assert.equal(h.calls.apply, 0, "отказ не накладывается");
  assert.equal(t.delays()[0], 40, "быстрое повторение ничего не изменит");
});

test("запись подталкивает обмен, но не мгновенно", async () => {
  const h = хост({ pending: 1 });
  let запросов = 0;
  const t = часы();
  const транспорт = new SyncTransport({
    host: h,
    endpoint: "https://host/sync",
    timers: t.api,
    options: { debounce: 700, interval: 15000 },
    fetch: async () => { запросов += 1; return ok({ protocol: 1, accepted: ["c0"], changes: [], cursor: 1 }); },
  });
  транспорт.start();
  await дать();
  assert.equal(t.delays()[0], 15000);
  транспорт.nudge();
  assert.equal(t.delays()[0], 700, "после записи -- скоро, но не мгновенно");
  await t.fire();
  assert.equal(запросов, 2);
});

test("без адреса обмена нет, и об этом сказано", async () => {
  let запросов = 0;
  const транспорт = new SyncTransport({
    host: хост(), endpoint: null, timers: часы().api,
    fetch: async () => { запросов += 1; return ok({}); },
  });
  транспорт.start();
  await транспорт.run("test");
  assert.equal(транспорт.state.phase, "off");
  assert.equal(запросов, 0);
  assert.equal(describe(транспорт.state), "Обмен не настроен");
});

test("то, что читает владелец", () => {
  assert.equal(describe({ phase: PHASE.IDLE, pending: 0 }), "Всё отправлено");
  assert.equal(describe({ phase: PHASE.IDLE, pending: 3 }), "Не отправлено: 3");
  assert.equal(describe({ phase: PHASE.OFFLINE, pending: 2 }), "Нет сети, не отправлено: 2");
  assert.equal(sinceText({ lastAt: null }), "обмена ещё не было");
  assert.equal(sinceText({ lastAt: 1000 }, 3000), "только что");
  assert.equal(sinceText({ lastAt: 1000 }, 301000), "5 мин назад");
});

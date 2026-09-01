/**
 * Транспорт обмена под Node: ни окна, ни сети, ни базы.
 *
 * Всё, что транспорту нужно снаружи, он принимает аргументами -- `fetch`,
 * часы, таймеры, признак сети, -- поэтому проверяется он тем же кодом, который
 * поедет в браузер, а не его пересказом. Взамен здесь приходится подделать
 * ровно три вещи: хост рантайма, сеть и время.
 */

import { readFileSync } from "node:fs";
import { resolveEndpoint, SyncTransport, describe, sinceText, PHASE }
  from "../../web/src/runtime/transport.js";

const input = JSON.parse(readFileSync(process.argv[2], "utf-8"));

/** Хост: очередь исходящего и счётчик наложенного. */
function fakeHost({ pending = 1, applied = 0 } = {}) {
  const host = {
    pending,
    calls: { envelope: 0, apply: 0, status: 0 },
    async pendingChanges() {
      host.calls.envelope += 1;
      return {
        protocol: 1, node: "node-a", schema: "s", cursor: 0,
        changes: Array.from({ length: host.pending }, (_, i) => ({
          id: `c${i}`, stamp: "st", blob: "AA==",
        })),
        defs: {},
      };
    },
    async applyChanges() {
      host.calls.apply += 1;
      host.pending = 0;                       // сервер подтвердил -- очередь пуста
      return { snapshot: { screens: [] }, sync: { applied, skipped: 0, conflicts: 0 } };
    },
    async syncStatus() {
      host.calls.status += 1;
      return { enabled: true, pending: host.pending };
    },
  };
  return host;
}

/** Таймеры, которые не идут сами: время двигает тест. */
function fakeTimers() {
  let seq = 0;
  const jobs = new Map();
  return {
    jobs,
    api: {
      set: (fn, ms) => { const id = ++seq; jobs.set(id, { fn, ms }); return id; },
      clear: (id) => { jobs.delete(id); },
    },
    /** Выполнить всё запланированное. */
    async fire() {
      const due = [...jobs.entries()];
      jobs.clear();
      for (const [, job] of due) await job.fn();
    },
    delays: () => [...jobs.values()].map((j) => j.ms),
  };
}

const ok = (payload) => ({
  ok: true, status: 200, json: async () => payload,
});

const CASES = {
  // Куда ходить: разбор адреса во всех формах, в которых он приходит.
  endpoint() {
    return {
      explicit: resolveEndpoint({ meta: { sync: "https://terminal.anisov.by" } }),
      trailing: resolveEndpoint({ meta: { sync: "https://terminal.anisov.by/" } }),
      subpath: resolveEndpoint({ meta: { sync: "https://host/app" } }),
      // Веб-клиент, отданный самим сервером обмена: адреса не задавали вовсе.
      sameOrigin: resolveEndpoint({ meta: {}, base: "https://terminal.anisov.by/index.html" }),
      nested: resolveEndpoint({ meta: {}, base: "https://host/app/index.html" }),
      // Внутри Capacitor origin принадлежит вебвью, а не серверу.
      native: resolveEndpoint({ meta: {}, base: "https://localhost/index.html", native: true }),
      nativeExplicit: resolveEndpoint({
        meta: { sync: "https://terminal.anisov.by" },
        base: "https://localhost/", native: true,
      }),
      off: resolveEndpoint({ meta: { sync: false }, base: "https://host/" }),
      offWord: resolveEndpoint({ meta: { sync: "off" }, base: "https://host/" }),
      override: resolveEndpoint({ meta: { sync: "https://a/" }, override: "https://b/" }),
      file: resolveEndpoint({ meta: {}, base: "file:///Users/x/index.html" }),
    };
  },

  // Один круг: конверт уехал, ответ наложен, очередь опустела.
  async round() {
    const host = fakeHost({ pending: 2, applied: 3 });
    const seen = [];
    const states = [];
    let rendered = 0;
    const timers = fakeTimers();
    const transport = new SyncTransport({
      host,
      endpoint: "https://host/sync",
      timers: timers.api,
      now: () => 1000,
      fetch: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return ok({ protocol: 1, accepted: ["c0", "c1"], changes: [], cursor: 7 }); },
      onChange: (s) => states.push(s.phase),
      onApplied: () => { rendered += 1; },
    });
    transport.start();
    await transport.run("test");               // тот же круг, а не второй
    return {
      requests: seen.length,
      url: seen[0].url,
      sentChanges: seen[0].body.changes.length,
      phases: states,
      phase: transport.state.phase,
      pending: transport.state.pending,
      lastAt: transport.state.lastAt,
      applied: transport.state.applied,
      rendered,
      scheduledAfter: timers.delays(),
    };
  },

  // Два повода разом -- один запрос, а не два.
  async coalesce() {
    const host = fakeHost({ pending: 1 });
    let requests = 0;
    const transport = new SyncTransport({
      host,
      endpoint: "https://host/sync",
      timers: fakeTimers().api,
      fetch: async () => { requests += 1; return ok({ protocol: 1, accepted: [], changes: [], cursor: 1 }); },
    });
    const [a, b] = await Promise.all([transport.run("one"), transport.run("two")]);
    return { requests, envelopes: host.calls.envelope, same: a === b };
  },

  // Сети нет: в сеть не ходим, состояние честное, таймера не заводим.
  async offline() {
    const host = fakeHost({ pending: 4 });
    let requests = 0;
    const timers = fakeTimers();
    const transport = new SyncTransport({
      host,
      endpoint: "https://host/sync",
      timers: timers.api,
      isOnline: () => false,
      fetch: async () => { requests += 1; return ok({}); },
    });
    transport.start();
    await transport.run("test");
    const offline = { phase: transport.state.phase, pending: transport.state.pending,
                      requests, scheduled: timers.delays().length };

    // Сеть вернулась -- круг заводится событием, а не сроком.
    let online = false;
    transport._isOnline = () => online;
    online = true;
    transport._fetch = async () => ok({ protocol: 1, accepted: ["c0", "c1", "c2", "c3"], changes: [], cursor: 2 });
    await transport.wake();
    return { offline, after: { phase: transport.state.phase, pending: transport.state.pending } };
  },

  // Отказ: состояние «не удалось», очередь цела, пауза нарастает.
  async failure() {
    const host = fakeHost({ pending: 1 });
    const timers = fakeTimers();
    const transport = new SyncTransport({
      host,
      endpoint: "https://host/sync",
      timers: timers.api,
      options: { backoff: [10, 20, 40] },
      fetch: async () => { throw new Error("connect ECONNREFUSED"); },
    });
    transport.start();                        // start() заводит первый круг
    await new Promise((r) => setTimeout(r, 0));
    const waits = [timers.delays()[0]];
    await transport.run("again");
    waits.push(timers.delays()[0]);
    await transport.run("again");
    waits.push(timers.delays()[0]);
    await transport.run("again");
    waits.push(timers.delays()[0]);           // ступеней три -- дальше та же
    return {
      phase: transport.state.phase,
      pending: transport.state.pending,
      error: transport.state.lastError,
      waits,
      applied: host.calls.apply,
    };
  },

  // Сервер ответил и отказал (схемы разошлись): это не сбой связи.
  async refused() {
    const host = fakeHost({ pending: 1 });
    const timers = fakeTimers();
    const transport = new SyncTransport({
      host,
      endpoint: "https://host/sync",
      timers: timers.api,
      options: { backoff: [10, 20, 40] },
      fetch: async () => ok({ protocol: 1, error: "Схемы разошлись" }),
    });
    transport.start();
    await new Promise((r) => setTimeout(r, 0));
    return {
      phase: transport.state.phase,
      error: transport.state.lastError,
      applied: host.calls.apply,              // накладывать было нечего
      wait: timers.delays()[0],               // сразу самая длинная ступень
    };
  },

  // Запись подталкивает обмен, но не в ту же миллисекунду.
  async nudge() {
    const host = fakeHost({ pending: 1 });
    let requests = 0;
    const timers = fakeTimers();
    const transport = new SyncTransport({
      host,
      endpoint: "https://host/sync",
      timers: timers.api,
      options: { debounce: 700, interval: 15000 },
      fetch: async () => { requests += 1; return ok({ protocol: 1, accepted: ["c0"], changes: [], cursor: 1 }); },
    });
    transport.start();
    await new Promise((r) => setTimeout(r, 0));
    const idle = timers.delays()[0];
    transport.nudge();
    const nudged = timers.delays()[0];
    await timers.fire();
    return { idle, nudged, requests };
  },

  // Адреса нет -- транспорт молчит и говорит об этом.
  async off() {
    let requests = 0;
    const transport = new SyncTransport({
      host: fakeHost(), endpoint: null, timers: fakeTimers().api,
      fetch: async () => { requests += 1; return ok({}); },
    });
    transport.start();
    await transport.run("test");
    return { phase: transport.state.phase, requests, text: describe(transport.state) };
  },

  // То, что читает владелец.
  words() {
    return {
      idle: describe({ phase: PHASE.IDLE, pending: 0 }),
      unsent: describe({ phase: PHASE.IDLE, pending: 3 }),
      offline: describe({ phase: PHASE.OFFLINE, pending: 2 }),
      never: sinceText({ lastAt: null }),
      justNow: sinceText({ lastAt: 1000 }, 3000),
      minutes: sinceText({ lastAt: 1000 }, 301000),
    };
  },
};

const out = await CASES[input.case]();
process.stdout.write(JSON.stringify(out, null, 2));

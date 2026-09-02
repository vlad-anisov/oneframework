/**
 * Захват хранилища: вторая вкладка против протёкшего держателя.
 *
 * `opfs-sahpool` отказывает одним и тем же `NoModificationAllowedError` в двух
 * совершенно разных положениях, и лечатся они противоположно:
 *
 * * каталог держит **живая вторая вкладка** -- обходить нельзя. Обход здесь
 *   значит: не нашлась база, скачалась заново, ветка `fresh` выдала новый
 *   номер узла -- и у пользователя молча завелось второе устройство со своей
 *   базой и своей очередью неотправленного;
 * * держатель **протёк** -- обходить обязательно. Воркер, убитый браузером не
 *   по-хорошему, запирает каталог наглухо, отпустить его некому, и без обхода
 *   приложение не запускается совсем.
 *
 * Различает их замок `navigator.locks`: браузер снимает его сам, когда
 * владелец умирает.
 *
 * Настоящего OPFS в node нет, и он не нужен: подменяются ровно две вещи, от
 * которых решение зависит, -- отдаётся ли каталог и жив ли держатель замка.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StorageBusyError, openPool } from "../../web/src/runtime/pool.js";

/**
 * Один заход: подменённые хранилище и замки, ответ или отказ.
 *
 * `locked` -- имена, которые не отдаются; `alive` -- те, чей замок держит
 * живая вкладка; `errorName` -- каким именем отказывает движок (Chromium
 * говорит одно, WebKit другое).
 */
async function заход({ locked = [], alive = [], errorName = "NoModificationAllowedError",
                       preferred = null, noLocks = false } = {}) {
  const заперты = new Set(locked);
  const живы = new Set(alive.map((n) => `oneframework-storage:${n}`));
  const пробовали = [];
  const sqlite3 = {
    async installOpfsSAHPoolVfs({ name }) {
      пробовали.push(name);
      if (заперты.has(name)) {
        const о = new Error(`${name} держат`);
        о.name = errorName;
        throw о;
      }
      return { name };
    },
  };
  const взяты = [];
  const locks = {
    request(name, options, callback) {
      if (живы.has(name)) return Promise.resolve(callback(null));
      взяты.push(name);
      return Promise.resolve(callback({ name }));
    },
  };
  const ответ = { tried: пробовали, claimed: взяты };
  try {
    const хранилище = await openPool(sqlite3, preferred, {
      locks: noLocks ? null : locks,
      sleep: async () => {},          // ждать в проверке нечего
    });
    ответ.name = хранилище.name;
    ответ.fellBack = хранилище.fellBack;
  } catch (о) {
    ответ.busy = о instanceof StorageBusyError;
    ответ.error = о.name;
    ответ.message = о.message;
  }
  return ответ;
}

describe("захват хранилища", () => {
  it("свободное берётся как есть", async () => {
    const о = await заход();
    assert.equal(о.name, "oneframework");
    assert.equal(о.fellBack, false);
    assert.deepEqual(о.claimed, ["oneframework-storage:oneframework"],
                     "замок обязан быть взят");
  });

  it("живой второй вкладке говорят правду, а не заводят ей своё устройство",
     async () => {
    const о = await заход({ locked: ["oneframework"], alive: ["oneframework"] });
    assert.equal(о.busy, true);
    assert.match(о.message, /другой вкладке/);
    assert.deepEqual(о.tried, [], "занятое живой вкладкой даже не пробуется");
    assert.ok(!("name" in о), "второе хранилище не заводится");
  });

  it("протёкший держатель обходится -- но не сразу", async () => {
    const о = await заход({ locked: ["oneframework"], alive: [] });
    assert.equal(о.name, "oneframework-2");
    assert.equal(о.fellBack, true);
    assert.equal(о.tried.filter((и) => и === "oneframework").length, 6,
                 "прежде чем обходить, надо подождать");
  });

  it("имя из прошлого запуска пробуется первым", async () => {
    const о = await заход({ preferred: "oneframework-2" });
    assert.equal(о.name, "oneframework-2");
    assert.deepEqual(о.tried, ["oneframework-2"]);
  });

  it("вторая вкладка на запасном хранилище тоже получает отказ", async () => {
    const о = await заход({ locked: ["oneframework"], alive: ["oneframework-2"],
                            preferred: "oneframework-2" });
    assert.equal(о.busy, true);
  });

  it("без navigator.locks остаётся прежнее поведение", async () => {
    const о = await заход({ locked: ["oneframework"], noLocks: true });
    assert.equal(о.name, "oneframework-2");
    assert.equal(о.busy, undefined);
  });

  it("WebKit называет тот же отказ иначе -- обход обязан начаться", async () => {
    // `createSyncAccessHandle` в WebKit бросает `UnknownError` там, где
    // Chromium бросает `NoModificationAllowedError`. Пока разбиралось только
    // второе имя, в Safari отказ пролетал наружу сырым. Поймано на стенде.
    const о = await заход({ locked: ["oneframework"], errorName: "UnknownError" });
    assert.equal(о.name, "oneframework-2");
    assert.equal(о.fellBack, true);
  });

  it("живая вкладка отвергается и на WebKit: замок решает раньше имени",
     async () => {
    const о = await заход({ locked: ["oneframework"], alive: ["oneframework"],
                            errorName: "UnknownError" });
    assert.equal(о.busy, true);
    assert.match(о.message, /другой вкладке/);
  });

  it("браузеру без пригодного хранилища говорят об этом", async () => {
    // Замерено на WebKit: `getDirectory()` отвечает, а `getFileHandle(...,
    // {create: true})` внутри воркера сразу отказывает `UnknownError`. Обход
    // по именам не помогает -- все пять отказывают одинаково. Раньше наружу
    // летел сырой отказ SQLite; именно с ним к нам и пришли со стенда.
    const все = ["oneframework", "oneframework-2", "oneframework-3",
                 "oneframework-4", "oneframework-5"];
    const о = await заход({ locked: все, errorName: "UnknownError" });
    assert.equal(о.error, "StorageUnavailableError", JSON.stringify(о));
    assert.match(о.message, /хранилище/);
    // И это **не** «занято»: занято -- живая вкладка, а тут её нет.
    assert.equal(о.busy, false);
  });
});

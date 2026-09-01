/**
 * Захват хранилища с подменёнными файлами и замками.
 *
 * Настоящего OPFS в node нет, и он здесь не нужен: проверяется решение, а не
 * файловая система. Подменяются ровно две вещи, от которых оно зависит, --
 * отдаётся ли каталог и держит ли его замок кто-то живой.
 *
 * Вход одним аргументом JSON:
 *   locked    -- имена VFS, которые не отдаются
 *   errorName -- каким именем отказа (умолчание -- хромовское)
 *   alive     -- имена VFS, чей замок держит живая вкладка
 *   preferred -- имя из прошлого запуска, если было
 *   noLocks   -- среда без `navigator.locks`
 */

import { StorageBusyError, openPool } from "../../web/src/runtime/pool.js";

const input = JSON.parse(process.argv[2]);
const locked = new Set(input.locked || []);
const alive = new Set((input.alive || []).map((n) => `oneframework-storage:${n}`));

const tried = [];
const sqlite3 = {
  async installOpfsSAHPoolVfs({ name }) {
    tried.push(name);
    if (locked.has(name)) {
      const err = new Error(`${name} держат`);
      // Имя отказа -- движка: Chromium говорит одно, WebKit другое.
      err.name = input.errorName || "NoModificationAllowedError";
      throw err;
    }
    return { name };
  },
};

const claimed = [];
const locks = {
  request(name, options, callback) {
    if (alive.has(name)) return Promise.resolve(callback(null));
    claimed.push(name);
    return Promise.resolve(callback({ name }));
  },
};

const out = { tried, claimed };
try {
  const storage = await openPool(sqlite3, input.preferred || null, {
    locks: input.noLocks ? null : locks,
    sleep: async () => {},          // ждать в проверке нечего
  });
  out.name = storage.name;
  out.fellBack = storage.fellBack;
} catch (err) {
  out.busy = err instanceof StorageBusyError;
  out.error = err.name;
  out.message = err.message;
}
process.stdout.write(JSON.stringify(out));

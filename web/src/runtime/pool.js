/**
 * Захват хранилища устройства -- и различение двух похожих отказов.
 *
 * `opfs-sahpool` держит файлы каталога эксклюзивно: `acquireAccessHandles`
 * берёт разом все и **бросает, если не отдался хотя бы один**, освободив
 * остальные. Отказ приходит один и тот же -- `NoModificationAllowedError`, -- а
 * причин у него две, и лечатся они противоположно:
 *
 * * **файлы держит живая вторая вкладка.** Ждать бесполезно: она никуда не
 *   денется. Обойти -- значит завести второе устройство со своей базой, своим
 *   номером узла и своей очередью неотправленного. Именно это и происходило:
 *   `openPool` брала следующее имя (`oneframework-2`…), `install` не находила базы и
 *   скачивала её заново, а ветка `fresh` выдавала новый номер узла. Всё молча.
 *   Правильный ответ здесь -- сказать правду и не заводить ничего;
 *
 * * **держатель протёк.** Воркер, убитый браузером не по-хорошему, запирает
 *   каталог наглухо, и отпустить его некому. Так и было на живом стенде:
 *   приложение переставало запускаться совсем, и перезагрузка не помогала.
 *   Здесь обход -- единственное, что вообще работает.
 *
 * Отличает их замок. `navigator.locks` держится ровно столько, сколько жив тот,
 * кто его взял: браузер снимает его сам, когда вкладка закрыта или убита. Замок
 * занят -- значит на том конце кто-то живой; замок свободен, а файлы не
 * отдаются -- значит держатель мёртв, и это протечка.
 *
 * Старый каталог при обходе **не трогается**: в нём могут лежать неотправленные
 * правки, и стереть их молча было бы хуже исходной беды.
 */

/**
 * «Файлы не отдались» -- на двух движках это два разных имени отказа.
 *
 * Chromium говорит `NoModificationAllowedError`, WebKit -- `UnknownError`, с
 * припиской «for an unknown transient reason (e.g. out of memory)». Причина
 * при этом та же: `createSyncAccessHandle` не смог взять файл, который уже
 * кем-то держится. Разбирали мы только первое имя, поэтому в Safari отказ
 * пролетал наружу сырым -- человек видел `UnknownError` вместо ответа, а
 * обход, ради которого всё написано, не начинался вовсе.
 *
 * Различать «живая вкладка» и «протёкший держатель» это не мешает: тем
 * занимается замок, а не имя отказа.
 */
const не_отдались = (err) =>
  err?.name === "NoModificationAllowedError" || err?.name === "UnknownError";

export const VFS_NAME = "oneframework";

//: Имя замка. Своё пространство имён, потому что замки общие на весь origin, а
//: рядом живёт всё остальное, что вздумается взять странице.
const lockName = (vfs) => `oneframework-storage:${vfs}`;

export const BUSY_MESSAGE =
  "Приложение уже открыто в другой вкладке. Данные лежат в одном хранилище, "
  + "и открыть его дважды нельзя: вторая копия завела бы себе отдельное "
  + "устройство со своей базой и своей очередью неотправленного. Закройте "
  + "лишнюю вкладку и обновите эту.";

/** Хранилище занято живой вкладкой -- это не поломка, а положение дел. */
export class StorageBusyError extends Error {
  constructor(message = BUSY_MESSAGE) {
    super(message);
    this.name = "StorageBusyError";
  }
}

//: Хранилища нет вовсе -- не «занято», а «этот движок его не даёт».
//:
//: Замерено 20.08.2026 на WebKit: `navigator.storage.getDirectory()` отвечает,
//: а `getFileHandle(..., {create: true})` внутри воркера сразу отказывает
//: `UnknownError`. То есть до синхронного доступа дело не доходит, и обход по
//: именам не помогает: все пять отказывают одинаково.
//:
//: Раньше в этом случае наружу летел сырой отказ SQLite -- «The operation
//: failed for an unknown transient reason (e.g. out of memory)». Человек видел
//: это вместо ответа и не имел ни одного способа понять, что случилось; ровно
//: с этой строкой к нам и пришли со стенда.
const NO_STORAGE_MESSAGE =
  "Этот браузер не даёт приложению своё хранилище: файловая система OPFS "
  + "отвечает, но создать в ней файл не даёт. Без хранилища приложение "
  + "работать не может -- ему негде держать базу. Так ведут себя приватные "
  + "окна и движки, где OPFS выключена частично.";

export class StorageUnavailableError extends Error {
  constructor(cause) {
    super(NO_STORAGE_MESSAGE);
    this.name = "StorageUnavailableError";
    //: Исходный отказ не выбрасывается: он нужен тому, кто чинит, а человеку
    //: показывают верхнее сообщение.
    this.cause = cause;
  }
}

/**
 * Взять замок на имя хранилища и держать его, пока жив этот воркер.
 *
 * Возвращает `{held, release}`. `held === false` значит, что замок держит
 * кто-то другой -- и он живой, иначе браузер бы его снял.
 *
 * Замков нет вовсе (старая среда) -- отвечаем `held: true`: тогда поведение
 * остаётся прежним, обходом. Молчаливое второе устройство хуже, но выдумывать
 * занятость там, где её нечем проверить, ещё хуже.
 */
export function claim(locks, name) {
  if (!locks) return Promise.resolve({ held: true, release: () => {} });
  return new Promise((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve({ held: false, release: () => {} });
          return undefined;
        }
        // Замок держится, пока не разрешится этот промис, -- то есть до конца
        // жизни воркера. Наружу отдаётся способ его отпустить.
        return new Promise((done) => resolve({ held: true, release: done }));
      })
      .catch(reject);
  });
}

/**
 * Захватить каталог, дождавшись, пока прежний владелец его отпустит.
 *
 * Браузер освобождает файлы сам, но не мгновенно, а захватывали мы ровно один
 * раз -- и одной неудачной попытки хватало, чтобы приложение показало «Ошибка
 * запуска» и больше не поднялось: перезагрузка попадала в то же состояние.
 *
 * `forceReinitIfPreviouslyFailed` здесь не украшение, а обязательное условие.
 * sqlite-wasm запоминает исход захвата по имени VFS -- **включая неудачу**:
 *
 *     if (initPromises[vfsName]) try { return await initPromises[vfsName]; }
 *     catch (e) { if (options.forceReinitIfPreviouslyFailed) delete ...; }
 *
 * Без этого ключа каждая следующая попытка мгновенно возвращает ту же самую
 * запомненную ошибку, ни разу не обратившись к файлам.
 */
export async function tryPool(sqlite3, name, attempts, sleep) {
  const wait = sleep || ((ms) => new Promise((done) => setTimeout(done, ms)));
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({
        name,
        initialCapacity: 6,
        forceReinitIfPreviouslyFailed: i > 0,
      });
    } catch (err) {
      last = err;
      if (!не_отдались(err)) throw err;
      await wait(Math.min(50 * 2 ** i, 800));
    }
  }
  // Отказ уходит наверх как есть: `openPool` по нему решает, перебирать ли
  // следующие имена. Свой отказ она поставит, когда кончатся все.
  throw last;
}

/**
 * Хранилище, на котором приложение сможет работать.
 *
 * Выбранное имя возвращается наружу -- хост его запоминает, чтобы следующий
 * запуск шёл сразу на него, а не заводил третий каталог поверх второго.
 */
export async function openPool(sqlite3, preferred, options = {}) {
  const locks = "locks" in options
    ? options.locks
    : globalThis.navigator && globalThis.navigator.locks;
  const names = [preferred || VFS_NAME];
  if (names[0] !== VFS_NAME) names.push(VFS_NAME);
  for (let n = 2; n <= 5; n += 1) {
    const name = `${VFS_NAME}-${n}`;
    if (!names.includes(name)) names.push(name);
  }

  let last;
  for (const name of names) {
    const claimed = await claim(locks, lockName(name));
    if (!claimed.held) {
      // Живая вкладка. Обход здесь -- это молча заведённое второе устройство,
      // поэтому обхода нет: есть ответ.
      throw new StorageBusyError();
    }
    try {
      const pool = await tryPool(sqlite3, name, name === names[0] ? 6 : 2,
                                 options.sleep);
      return { pool, name, fellBack: name !== VFS_NAME, release: claimed.release };
    } catch (err) {
      claimed.release();
      last = err;
      if (!не_отдались(err)) throw err;
    }
  }
  // Все имена отказали одним и тем же «не отдались». Обход придуман против
  // занятого каталога, а тут отказывает само хранилище -- значит обходить
  // нечего, и молчать об этом нельзя.
  throw new StorageUnavailableError(last);
}

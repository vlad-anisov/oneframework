/**
 * Воркер: здесь живёт весь рантайм.
 *
 * Почему именно воркер, а не главный поток: синхронный доступ к OPFS
 * (`createSyncAccessHandle`) на главном потоке не существует, а в воркере есть.
 * Благодаря этому база остаётся синхронной, и слой моделей не пришлось
 * выворачивать в промисы -- асинхронной стала ровно одна граница, «воркер ↔
 * главный поток», и на ней уже сидит рендерер, который и раньше разговаривал с
 * Pyodide через сообщения.
 *
 * VFS `opfs-sahpool` выбран не от хорошей жизни, а потому что он единственный
 * не требует COOP/COEP: обычный `opfs` просит SharedArrayBuffer, то есть особых
 * заголовков от сервера, а внутри Capacitor-вебвью их взять неоткуда.
 *
 * Договор с хостом -- тот же JSON, что был у Pyodide, слово в слово:
 *
 *     boot            -> {meta, snapshot}   или {error}
 *     dispatch(event) -> {snapshot}         или {error}
 *     pending_changes -> конверт обмена
 *     apply_changes   -> {snapshot, sync}
 *     sync_status     -> {enabled, pending}
 *     flush           -> "1"
 */

import { setPythonBase } from "../../../src/runtime/python.js";
import { setWasmBase } from "../../../src/runtime/wasm_action.js";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { Database } from "../../../src/runtime/db.js";
import { get as getDef, loadDocuments, loadSchema } from "../../../src/runtime/defs.js";
import { makeModels } from "../../../src/runtime/fields.js";
import { nodeId } from "../../../src/runtime/hlc.js";
import * as logic from "../../../src/runtime/logic.js";
import { StorageBusyError, openPool } from "./pool.js";
import { Runtime } from "../../../src/runtime/session.js";
import * as sync from "../../../src/runtime/sync.js";

let sqlite3 = null;
let pool = null;
let db = null;
let runtime = null;
let api = null;
let schema = null;
let meta = null;
//: Замок на хранилище. Держится всё время жизни воркера -- по нему следующая
//: вкладка и узнаёт, что на этом конце кто-то живой (см. pool.js).
let releaseStorage = () => {};

/**
 * Первый запуск: база приезжает готовой, собранной питоном на сборке. В ней уже
 * есть и таблицы, и определения, и демо-данные -- поэтому старт не тратит ни
 * секунды на выкладку и заполнение, а определения лежат в обычной таблице и
 * уезжают обменом наравне с задачами.
 */
async function install(path, url) {
  if (pool.getFileNames().includes(path)) return false;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url} не найден (${response.status})`);
  pool.importDb(path, new Uint8Array(await response.arrayBuffer()));
  return true;
}

/**
 * Хост бизнес-логики для этого устройства, либо `null`.
 *
 * Модули берутся **из базы**, а не из сборки: они приезжают туда обменом
 * наравне с задачами, и устройство, получившее новый модуль, начинает его
 * исполнять без переустановки. Развернуть экземпляр -- единственное здесь
 * асинхронное место: `WebAssembly.instantiate` компилирует в фоне, и
 * синхронного пути к этому в браузере нет. Поэтому оно и стоит на старте, а не
 * в обработчике нажатия: рантайм за границей воркера обязан оставаться
 * синхронным.
 *
 * Было парой к `App.attach_logic` в `oneframework/runtime/app.py, удалён` (метод
 * удалён 21.08.2026 вместе с питоновским хостом логики; файл переехал в
 * `oneframework/app.py`). Здесь эта дорога и осталась единственной.
 */
async function attachLogic(database, schemaDoc, models) {
  if (!logic.manifests(database).length) return null;
  const docs = Object.fromEntries(schemaDoc.models.map((m) => [m.name, m]));
  const logicApi = new logic.Api(database, Object.values(models), { docs });
  await logic.register(database, logicApi);
  // Проверка при сохранении. База не знает ни про WASM, ни про объявления:
  // ей отдаётся функция, а откуда та берёт правила -- её дело.
  database.validator = logic.validator(logicApi);
  return logicApi;
}

async function boot(config) {
  const base = config.base || "/";
  // Питон на устройстве, если приложение его объявило: где лежит рантайм,
  // знает только тот, кто знает базу.
  setPythonBase(base);
  setWasmBase(base);
  const manifest = await (await fetch(`${base}oneframework-manifest.json`, { cache: "no-cache" })).json();
  meta = manifest.meta;

  sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: (m) => console.warn("[sqlite]", m) });
  const storage = await openPool(sqlite3, config.vfs);
  pool = storage.pool;
  releaseStorage = storage.release;

  const path = `/${manifest.db_name || "app.db"}`;
  const fresh = await install(path, `${base}oneframework-app.db`);

  db = new Database(new pool.OpfsSAHPoolDb(path), { sqlite3 });
  if (!db.installStepLimit()) {
    // Молчаливое отсутствие предела -- худший исход: всё работает ровно до
    // первой тяжёлой формулы, и тогда вкладка виснет без единого слова.
    console.warn("[oneframework] предел работы запроса не поставлен: "
      + "sqlite3_progress_handler недоступен в этой сборке");
  }
  // Номер узла принадлежит **устройству**, а не сборке. База приезжает готовой
  // и одинаковой для всех, поэтому первое, что делает устройство со своей
  // копией, -- берёт себе новый номер. Иначе два устройства из одной сборки
  // неотличимы друг от друга: сервер не возвращает узлу его же changeset'ы, и
  // оба молча перестают видеть правки соседа, не сообщив ни об одной ошибке.
  if (fresh) {
    db.setMeta("hlc:node", nodeId());
    db.commit();
  }
  api = new sync.SessionApi(sqlite3);

  await собрать();
  const snapshot = runtime.boot();
  return { meta, snapshot, fresh, vfs: storage.name, fellBack: storage.fellBack };
}

/**
 * Собрать рантайм по тому, что лежит в базе **сейчас**.
 *
 * Вынесено из `boot` 20.08.2026, и вот зачем. Схема и документы читались из
 * базы, а не из сборки, -- и в шапке было написано, что так устройство,
 * получившее вид обменом, начинает рисовать его без переустановки. Читались
 * они при этом **один раз за жизнь воркера**: приехавший вид ложился в
 * `_oneframework_def` и там оставался до следующего запуска. Обещание было
 * шире дела, и заметил это разбор со стороны, а не наша сюита.
 *
 * Теперь то же самое зовётся ещё и после обмена, если обмен привёз хоть одно
 * определение. Дорого это ровно настолько, насколько дорог запуск, -- и
 * платится только тогда, когда определения правда менялись.
 */
async function собрать() {
  schema = loadSchema(db);
  const documents = loadDocuments(db);
  const models = makeModels(schema);
  // База приезжает готовой, и таблицы в ней уже есть -- но у той, что приехала
  // прошлой сборкой и осталась на устройстве, может не быть колонки, добавленной
  // каркасом позже (так появилась `_cv`). Проход добавляющий: он ничего не
  // трогает, кроме недостающего, и стоит десятка PRAGMA на запуске.
  db.ensureSchema(Object.values(models));

  runtime = new Runtime({
    documents,
    models,
    db,
    logic: await attachLogic(db, schema, models),
    // Разделы по-прежнему из манифеста сборки, а не из базы: пакет объявления
    // кладёт в `_oneframework_def` виды, модели и действия, но не сам список
    // разделов. Значит новый *раздел* обменом не приезжает и сегодня, и это
    // записано здесь, а не умолчано.
    screens: meta.screens.map((s) => ({
      key: s.key, label: s.label, icon: s.icon, view: s.view,
    })),
  });
}

const HANDLERS = {
  boot: async (payload) => boot(payload || {}),

  /**
   * Отпустить хранилище перед уходом со страницы.
   *
   * Браузер освободил бы файлы и сам, но с задержкой, и следующая загрузка
   * тратила бы на ожидание попытки из `openPool`. Отпустив их явно, мы
   * возвращаемся мгновенно -- а обновление страницы у местного приложения
   * происходит чаще, чем у обычного сайта.
   */
  release: async () => {
    if (db) db.commit();
    if (pool && !pool.isPaused()) pool.pauseVfs();
    // Замок снимается вместе с файлами: иначе следующая вкладка увидела бы
    // живого держателя там, где хранилище уже отдано, и отказалась бы работать
    // из вежливости к тому, кого нет.
    releaseStorage();
    releaseStorage = () => {};
    return { released: true };
  },

  // `await`, а не просто вызов: действие на устройстве бывает асинхронным
  // (питон поднимается секунду, скомпилированный модуль -- доли), и тогда
  // `dispatch` возвращает обещание. Без ожидания в кадр уезжало само обещание,
  // главный поток получал его вместо снимка и экран оставался прежним --
  // значение записано, а на карточке старое.
  dispatch: async (event) => ({ snapshot: await runtime.dispatch(event) }),

  pending_changes: () => {
    // Первый вызов заодно включает учёт: до него сессия не открыта, и правки
    // ничего не записывают. Всё, что уже лежит, попадает в первый же конверт
    // снимком -- поэтому включить обмен на заполненном устройстве это один
    // вызов, а не миграция.
    if (db.tracker === null) sync.enable(db, api);
    return sync.envelope(db);
  },

  // Дёшево и без сети: сколько changeset'ов ещё не уехало. Учёт здесь не
  // включается -- пока обмен не завёлся ни разу, отправлять нечего по
  // определению, и включать сессию ради ответа «ноль» незачем.
  sync_status: () => {
    if (db === null || db.tracker === null) return { enabled: false, pending: 0 };
    db.commit();
    return { enabled: true, pending: sync.pendingCount(db) };
  },

  apply_changes: async (response) => {
    // Обмен -- не путь чтения, а фоновый писатель: он приносит строки между
    // кадрами и просит нарисовать заново.
    const report = await sync.receive(db, api, response);
    // Приехали определения -- значит рисовать надо по новым, а не по тем, что
    // прочитаны при запуске. Пересборка полная и только по этому условию:
    // обмен, привёзший одни записи, стоит ровно столько же, сколько раньше.
    if (report.defs) {
      await собрать();
      return { snapshot: runtime.boot(), sync: report };
    }
    for (const name of Object.keys(runtime.models)) runtime.touch(name);
    return { snapshot: runtime.snapshot(), sync: report };
  },

  flush: () => {
    db.flushNow();
    return "1";
  },

  /**
   * Прочитать строку и посчитать строки -- для проверок Playwright.
   *
   * Единственная дверь к базе, оставшаяся снаружи воркера. Пока рантайм был на
   * Pyodide, проверка спрашивала базу через `runPython` на главном потоке; в
   * воркере такого хода нет вовсе -- OPFS держит файлы эксклюзивно, и второго
   * соединения к той же базе не открыть ни из окна, ни из другого воркера.
   *
   * Поэтому вопрос задаётся тому, кто базой владеет. Оба вызова только читают и
   * ничего не заводят: `sync_status` рядом нарочно не включает учёт по той же
   * причине -- проверка не должна менять поведение того, что проверяет.
   */
  read: ({ model, id }) => ({ record: db.read(runtime.model(model), id) }),

  count: ({ model }) => ({ count: db.count(runtime.model(model)) }),

  /**
   * Прочитать определение -- третья дверь того же назначения, что `read` и
   * `count`.
   *
   * Нужна ровно за тем же: проверить, что приехавшее обменом определение
   * становится экраном, можно только имея на руках то, что лежит сейчас.
   * Снимок для этого не годится -- в нём документ уже развёрнут по записям, и
   * отправить его обратно определением значит подменить объявление его же
   * тенью. Первая редакция проверки так и сделала, и список схлопнулся до
   * одной строки.
   */
  read_definition: ({ kind, name }) => ({ doc: getDef(db, kind, name) }),
};

/**
 * Очередь. Запросы исполняются **по одному**, в том порядке, в каком пришли.
 *
 * Без неё `self.onmessage = async` заводил на каждое сообщение свою цепочку, и
 * пока одна ждала (питон на устройстве, обмен по сети), воркер начинал
 * следующую. Беда не в порядке ответов, а в том, что обе цепочки трогают
 * **одну синхронную базу**: вторая приходила в неё посреди чужой транзакции.
 *
 * Наружу это выглядело так: медленное действие заканчивалось позже быстрого и
 * перезаписывало экран своим кадром -- уже устаревшим. Ни исключения, ни следа
 * в журнале; человек видел старые данные и не имел способа понять, почему.
 *
 * Нашёл разбор со стороны 20.08.2026. Своей проверки на это не было ни одной.
 *
 * Цепочка обещаний, а не массив: она короче, и у неё нет состояния «идёт
 * разбор очереди», которое пришлось бы сбрасывать при отказе.
 */
let очередь = Promise.resolve();

self.onmessage = (event) => {
  очередь = очередь.then(() => обслужить(event)).catch(() => {});
};

async function обслужить(event) {
  const { id, kind, payload } = event.data || {};
  const handler = HANDLERS[kind];
  if (!handler) {
    self.postMessage({ id, error: { message: `неизвестный запрос ${kind}` } });
    return;
  }
  try {
    self.postMessage({ id, result: await handler(payload) });
  } catch (err) {
    // Занятое хранилище -- не поломка, а положение дел, и объяснять его следом
    // вызовов нечем: у него нет места в коде, которое стоило бы показывать.
    // Хост печатает след, когда он есть, поэтому здесь его нет.
    const busy = err instanceof StorageBusyError;
    self.postMessage({
      id,
      error: {
        message: busy ? err.message : `${err && err.name}: ${err && err.message}`,
        traceback: busy ? "" : String((err && err.stack) || ""),
      },
    });
  }
}

self.postMessage({ ready: true });

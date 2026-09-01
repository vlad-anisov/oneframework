/**
 * Хост рантайма на главном потоке. Замена `pyodide-host.js` с тем же лицом.
 *
 * Разница ровно одна и она видна снаружи: `dispatch` теперь возвращает обещание.
 * Иначе и быть не может -- рантайм уехал в воркер, потому что синхронный OPFS
 * есть только там. Взамен исчезло всё остальное: интерпретатор, снимок кучи в
 * десятки мегабайт, распаковка архива, IDBFS и ручная синхронизация файловой
 * системы. База лежит в OPFS и сохраняется сама, поэтому `flush` здесь почти
 * ничего не делает и оставлен ради договора.
 */

const assetURL = (path) => new URL(path, document.baseURI).href;

export class JsHost {
  constructor({ onStep } = {}) {
    this.onStep = onStep || (() => {});
    this.worker = null;
    this.timings = {};
    //: OPFS переживает перезапуск сам; отдельного «сохранить» ему не нужно.
    this.persistent = true;
    this._seq = 0;
    this._waiting = new Map();
    this._manifest = { scripts: [], styles: [] };
  }

  async start() {
    const t0 = performance.now();
    this.onStep("Запуск рантайма");

    this.worker = new Worker(new URL("./runtime/worker.js", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event) => this._receive(event.data);
    this.worker.onerror = (event) => {
      console.error("[oneframework] воркер упал", event.message);
    };

    this.onStep("Подключение хранилища");
    const base = new URL(".", document.baseURI).pathname;
    // Какое хранилище выбрали в прошлый раз. Без этой памяти запуск, ушедший
    // на запасное хранилище, каждый раз начинал бы с занятого основного и
    // заводил бы всё новые каталоги поверх своих же данных.
    let preferred = null;
    try { preferred = localStorage.getItem("oneframework:vfs"); } catch { /* приватный режим */ }
    const payload = await this._call("boot", { base, vfs: preferred || undefined });
    if (payload && payload.vfs) {
      try { localStorage.setItem("oneframework:vfs", payload.vfs); } catch { /* см. выше */ }
      this.storageFellBack = Boolean(payload.fellBack);
    }

    // Виджеты и стили модулей приезжают манифестом: питона на устройстве нет, и
    // прочитать их из его файловой системы больше нельзя.
    try {
      this._manifest = await (await fetch(assetURL("oneframework-manifest.json"))).json();
    } catch (err) {
      console.warn("[oneframework] манифест недоступен", err);
    }

    //: Ставилась ли база этим запуском. Холодный старт разворачивает готовую
    //: базу из сборки, тёплый находит её на месте -- и разница видна снаружи:
    //: демо-данные заводятся ровно один раз, и повторный завод был бы виден
    //: только удвоившимся списком.
    this.fresh = Boolean(payload && payload.fresh);
    this.timings.total = performance.now() - t0;
    console.info(
      `[oneframework] старт ${Math.round(this.timings.total)} мс` +
        `${payload.fresh ? ", база установлена" : ""}`,
    );
    return payload;
  }

  _receive(data) {
    if (data && data.ready) return;      // воркер поднялся
    const pending = this._waiting.get(data.id);
    if (!pending) return;
    this._waiting.delete(data.id);
    if (data.error) pending.reject(Object.assign(new Error(data.error.message), data.error));
    else pending.resolve(data.result);
  }

  _call(kind, payload) {
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, kind, payload });
    });
  }

  /** Одно событие интерфейса -- следующий кадр. */
  async dispatch(event) {
    try {
      return await this._call("dispatch", event);
    } catch (err) {
      return { error: { message: err.message, traceback: err.traceback } };
    }
  }

  async pendingChanges() {
    return this._call("pending_changes");
  }

  async applyChanges(response) {
    return this._call("apply_changes", response);
  }

  /** Сколько changeset'ов ещё не уехало -- для признака состояния обмена. */
  async syncStatus() {
    return this._call("sync_status");
  }

  /** Что приехало манифестом сборки: разделы, оформление, адрес обмена. */
  meta() {
    return this._manifest.meta || {};
  }

  moduleScripts() {
    return this._manifest.scripts || [];
  }

  moduleStyles() {
    return this._manifest.styles || [];
  }

  /**
   * Одна строка из базы и число строк в таблице -- для проверок Playwright.
   *
   * База лежит в воркере и синхронного доступа к ней снаружи нет, поэтому
   * проверка не читает её сама, а спрашивает владельца. Приложение этими двумя
   * не пользуется: кадр приходит снимком, а не выборкой.
   */
  async readRecord(model, id) {
    return (await this._call("read", { model, id })).record;
  }

  async countRecords(model) {
    return (await this._call("count", { model })).count;
  }

  /** Определение, как оно лежит в базе сейчас. Та же дверь, что и две выше. */
  async readDefinition(kind, name) {
    return (await this._call("read_definition", { kind, name })).doc;
  }

  /** OPFS пишет сама; вызов остаётся, чтобы хост был взаимозаменяем. */
  flushNow() {
    this._call("flush").catch(() => {});
  }

  /**
   * Отпустить хранилище: страница уходит.
   *
   * Файлы `opfs-sahpool` держатся эксклюзивно, и пока их держит воркер
   * уходящей страницы, следующая загрузка захватить их не может. Отпущенные
   * явно, они свободны сразу.
   */
  releaseStorage() {
    this._call("release").catch(() => {});
  }
}

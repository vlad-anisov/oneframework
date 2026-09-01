/**
 * Транспорт обмена: единственное место в клиенте, которое ходит в сеть.
 *
 * Механизм обмена (`sync.js`) сети не касается вовсе -- у него на входе конверт,
 * на выходе конверт, а как они доехали, ему неинтересно. Здесь ровно
 * недостающее: **круг** (собрать, отправить, наложить), **расписание** (когда
 * его заводить) и **состояние** (что показать человеку).
 *
 * Три решения, которые стоит помнить.
 *
 * **Круг неделим и не наслаивается.** Два повода обменяться, пришедшие разом --
 * таймер и только что записанная задача, -- дают один запрос, а не два: второй
 * получает то же обещание. Иначе конверт снимается дважды, и одни и те же
 * changeset'ы уезжают парой.
 *
 * **Ошибка -- это не «нет сети».** Отказ сервера и отсутствие сети выглядят
 * снаружи одинаково (`fetch` бросает), но ведут себя по-разному: без сети ждать
 * бессмысленно и надо ждать события `online`, а при отказе -- отступать с
 * нарастающей паузой. Поэтому состояний два, а не одно.
 *
 * **Неотправленное считается в базе, а не здесь.** Соблазн держать счётчик
 * рядом с очередью велик, но правда о том, что не уехало, лежит в таблице
 * исходящих, и любой её пересказ рано или поздно разойдётся с ней.
 */

//: Адрес обмена относительно адреса приложения. Один и тот же и у сервера, и у
//: клиента: обмен -- это `POST /sync` рядом со страницей.
export const SYNC_PATH = "sync";

export const DEFAULTS = {
  //: Обычный круг. Не «как можно чаще»: между кругами ничего не теряется,
  //: очередь копится, и редкий круг стоит ровно столько же, сколько частый.
  interval: 15000,
  //: После записи -- почти сразу, но не мгновенно: правка обычно приходит
  //: очередью (набрал строку, поставил галочку), и ждать её конца дешевле.
  debounce: 700,
  //: Молчащий сервер обязан кончиться отказом, иначе круг не завершится
  //: никогда и следующий не начнётся.
  timeout: 20000,
  //: Отступление при отказах. Последняя ступень -- та, на которой остаёмся.
  backoff: [1000, 3000, 8000, 20000, 60000],
};

/** Состояния, в которых бывает обмен. */
export const PHASE = {
  OFF: "off",           // адреса нет -- обмен не настроен
  IDLE: "idle",         // всё уехало, ждём повода
  SYNCING: "syncing",   // круг идёт прямо сейчас
  OFFLINE: "offline",   // сети нет; ждём, когда появится
  ERROR: "error",       // сеть есть, договориться не вышло
};

/**
 * Куда ходить.
 *
 * Порядок отвечает на вопрос «кто главнее», и главный здесь -- тот, кто ближе к
 * запуску: подстановка в окне (её ставит проверка), потом сборка, потом сам
 * адрес страницы.
 *
 * Последняя ступень и есть обещание «для веб-клиента, отданного тем же
 * сервером, работает без настройки»: страница приехала оттуда же, откуда будет
 * приезжать обмен, и другого адреса ей знать не нужно. Внутри Capacitor этой
 * ступени нет -- там origin принадлежит вебвью, а не серверу, и адрес обязан
 * быть задан на сборке.
 */
export function resolveEndpoint({ meta, base, native = false, override } = {}) {
  const raw = override !== undefined && override !== null ? override : meta?.sync;
  if (raw === false || raw === 0) return null;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text || ["off", "none", "0"].includes(text.toLowerCase())) return null;
    return new URL(SYNC_PATH, text.endsWith("/") ? text : `${text}/`).href;
  }
  if (native || !base) return null;
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return new URL(SYNC_PATH, url).href;
}

/** Человеческое имя состояния -- то, что читает владелец в карточке обмена. */
export function describe(state) {
  switch (state.phase) {
    case PHASE.OFF: return "Обмен не настроен";
    case PHASE.SYNCING: return "Идёт обмен…";
    case PHASE.OFFLINE:
      return state.pending ? `Нет сети, не отправлено: ${state.pending}` : "Нет сети";
    case PHASE.ERROR: return `Не удалось: ${state.lastError || "неизвестная ошибка"}`;
    default:
      return state.pending ? `Не отправлено: ${state.pending}` : "Всё отправлено";
  }
}

/** «Когда был последний» -- словами, а не отметкой времени. */
export function sinceText(state, now = Date.now()) {
  if (!state.lastAt) return "обмена ещё не было";
  const seconds = Math.max(0, Math.round((now - state.lastAt) / 1000));
  if (seconds < 10) return "только что";
  if (seconds < 90) return `${seconds} с назад`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} мин назад`;
  return `${Math.round(minutes / 60)} ч назад`;
}

export class SyncTransport {
  constructor({
    host,
    endpoint = null,
    fetch: fetchImpl = null,
    now = () => Date.now(),
    isOnline = () => true,
    timers = null,
    options = null,
    onChange = null,
    onApplied = null,
    stand = null,
    key = null,
  } = {}) {
    this.host = host;
    this.endpoint = endpoint;
    this.stand = stand;
    //: Общий ключ обмена, если сервер закрыт им. Хранится у устройства, а не
    //: в сборке: сборка одна на всех, и ключ в ней раздавался бы вместе с
    //: приложением. Ставится через `localStorage.oneframeworkSyncKey`.
    this.key = key;
    this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this._now = now;
    this._isOnline = isOnline;
    this._timers = timers || {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (id) => clearTimeout(id),
    };
    this.options = { ...DEFAULTS, ...(options || {}) };
    this._onChange = onChange || (() => {});
    this._onApplied = onApplied || (() => {});

    this.state = {
      endpoint,
      phase: endpoint ? PHASE.IDLE : PHASE.OFF,
      pending: 0,       // сколько changeset'ов ждёт отправки
      lastAt: null,     // когда последний круг завершился успехом
      lastError: null,
      applied: 0,       // сколько чужих changeset'ов принято последним кругом
      rounds: 0,
      failures: 0,
    };
    this._timer = null;
    this._running = null;
    this._started = false;
  }

  // -- состояние ---------------------------------------------------------
  _set(patch) {
    this.state = { ...this.state, ...patch };
    this._onChange(this.state);
    return this.state;
  }

  /** Пересчитать «неотправленное» по самой базе. */
  async refresh() {
    try {
      const status = await this.host.syncStatus();
      return this._set({ pending: Number(status?.pending || 0) });
    } catch {
      return this.state;                 // рантайм ещё не поднялся -- не беда
    }
  }

  // -- расписание --------------------------------------------------------
  start() {
    if (this._started) return this;
    this._started = true;
    if (!this.endpoint) {
      this._set({ phase: PHASE.OFF });
      return this;
    }
    this.run("start");
    return this;
  }

  stop() {
    this._started = false;
    this._timers.clear(this._timer);
    this._timer = null;
  }

  /** Что-то записали: обменяться скоро, но не в ту же миллисекунду. */
  nudge() {
    this.refresh();
    this._schedule(this.options.debounce);
  }

  /** Сеть вернулась или окно снова на виду -- повод не ждать таймера. */
  wake() {
    if (!this._started || !this.endpoint) return Promise.resolve(this.state);
    return this.run("wake");
  }

  /** Сеть пропала. Ждать теперь нечего -- следующий круг заведёт `online`. */
  sleep() {
    if (!this.endpoint) return Promise.resolve(this.state);
    this._timers.clear(this._timer);
    this._timer = null;
    return this.refresh().then(() => this._set({ phase: PHASE.OFFLINE }));
  }

  _schedule(delay = null) {
    if (!this._started || !this.endpoint) return;
    this._timers.clear(this._timer);
    let wait = delay;
    if (wait === null) {
      const { backoff, interval } = this.options;
      wait = this.state.failures
        ? backoff[Math.min(this.state.failures - 1, backoff.length - 1)]
        : interval;
    }
    this._timer = this._timers.set(() => {
      this._timer = null;
      this.run("timer");
    }, wait);
  }

  // -- круг --------------------------------------------------------------
  /**
   * Один круг обмена. Повторный вызов на идущем круге возвращает тот же
   * круг, а не заводит второй.
   */
  run(reason = "manual") {
    if (this._running) return this._running;
    this._running = this._round(reason).finally(() => {
      this._running = null;
    });
    return this._running;
  }

  async _round(reason) {
    if (!this.endpoint) return this._set({ phase: PHASE.OFF });
    if (!this._isOnline()) {
      await this.refresh();
      this._set({ phase: PHASE.OFFLINE });
      // Расписания не заводим: возвращение сети -- это событие, а не срок.
      return this.state;
    }
    this._set({ phase: PHASE.SYNCING });

    let envelope;
    try {
      envelope = await this.host.pendingChanges();
    } catch (err) {
      return this._failed(err);
    }
    // Сколько уезжает -- уже известно, и знать это надо *до* ответа: если
    // круг не удастся, показать придётся именно это число.
    this._set({ pending: (envelope.changes || []).length });

    let response;
    try {
      response = await this._post(envelope);
    } catch (err) {
      // Сеть могла отвалиться ровно между проверкой и запросом.
      if (!this._isOnline()) return this._set({ phase: PHASE.OFFLINE });
      return this._failed(err);
    }

    if (response && response.error) {
      // Сервер ответил и отказал -- обычно разошлись схемы. Быстрое повторение
      // ничего не изменит, поэтому это отказ, а не сбой связи.
      return this._failed(new Error(String(response.error)), true);
    }

    let report;
    try {
      report = await this.host.applyChanges(response);
    } catch (err) {
      return this._failed(err, true);
    }

    const applied = Number(report?.sync?.applied || 0);
    // Чужие строки уже в базе; кадр про них ещё не знает.
    if (applied) this._onApplied(report);

    this._set({
      phase: PHASE.IDLE,
      lastAt: this._now(),
      lastError: null,
      failures: 0,
      applied,
      rounds: this.state.rounds + 1,
      reason,
    });
    await this.refresh();
    this._schedule();
    return this.state;
  }

  async _post(envelope) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? this._timers.set(() => controller.abort(), this.options.timeout)
      : null;
    try {
      const response = await this._fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
        },
        body: JSON.stringify(envelope),
        cache: "no-store",
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) throw new Error(`сервер ответил ${response.status}`);
      return await response.json();
    } finally {
      if (timer !== null) this._timers.clear(timer);
    }
  }

  _failed(err, fatal = false) {
    const message = String((err && err.message) || err);
    this._set({
      phase: PHASE.ERROR,
      lastError: message,
      // Отказ по существу (схемы разошлись) не приближает следующую попытку --
      // он сразу ставит нас на самую длинную ступень отступления.
      failures: fatal ? this.options.backoff.length : this.state.failures + 1,
    });
    this._schedule();
    return this.state;
  }
}

/**
 * Обвязка вокруг браузера: события, от которых круг заводится сам.
 * Отдельно от класса -- чтобы сам класс проверялся без окна и без сети.
 */
export function bindBrowser(transport, target = globalThis) {
  target.addEventListener?.("online", () => transport.wake());
  target.addEventListener?.("offline", () => transport.sleep());
  target.document?.addEventListener?.("visibilitychange", () => {
    if (target.document.visibilityState === "visible") transport.wake();
  });
  return transport;
}

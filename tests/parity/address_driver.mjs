/**
 * Адресная строка под Node: ни браузера, ни рантайма.
 *
 * Проверяется тот же файл, который поедет в браузер (`web/src/address.js`), а
 * не его пересказ. Снаружи ему нужны окно, склад и -- в нативной сборке --
 * плагин `@capacitor/app`; все три подделаны здесь и рядом
 * (`capacitor_app.mjs`, `capacitor_hooks.mjs`).
 *
 * Окно подделано с настоящей историей: список записей и указатель в нём, потому
 * что весь спор в этом файле про историю и есть -- «добавить запись», «заменить
 * запись» и «уйти на запись назад» ведут себя одинаково ровно до тех пор, пока
 * никто не нажал «назад». `popstate` приходит микрозадачей, как в браузере:
 * `history.back()` возвращает управление раньше события.
 *
 * Рантайм подделан по-крупному: `goto` собирает стек из пути, а совпавшее
 * начало не бережёт -- это правило проверяется на настоящем рантайме
 * (`tests/test_screens.py`), и повторять его здесь значило бы проверять
 * подделку.
 */

import { readFileSync } from "node:fs";
import { register } from "node:module";

//: Дверь нативной сборки ходит в `@capacitor/app`, а его в Node нет.
//: Переходник ставится до всякого импорта -- разбираются только те, что
//: после него.
register("./capacitor_hooks.mjs", import.meta.url);

const input = JSON.parse(readFileSync(process.argv[2], "utf-8"));

/** Окно с историей. `log` -- то, ради чего всё: чем именно её двигали. */
function fakeWindow(hash = "") {
  const log = [];
  let entries = [{ url: hash, state: null }];
  let index = 0;
  const listeners = new Set();
  const win = {
    location: { get hash() { return entries[index].url; } },
    history: {
      get state() { return entries[index].state; },
      pushState(state, _title, url) {
        log.push(`push ${url}`);
        entries = entries.slice(0, index + 1);
        entries.push({ url, state });
        index += 1;
      },
      replaceState(state, _title, url) {
        log.push(`replace ${url}`);
        entries[index] = { url, state };
      },
      back() {
        this.go(-1);
      },
      //: Настоящая история умеет шаг любой длины, и это не мелочь: возврат
      //: сразу через несколько уровней (крошки шлют `back_to`) обязан снять
      //: столько же своих записей, сколько уровней сняли. Один шаг оставил бы
      //: браузер на промежуточном адресе, а тот развернулся бы обратно в стек.
      go(delta) {
        log.push(`go ${delta}`);
        const to = Math.min(Math.max(index + delta, 0), entries.length - 1);
        if (to === index) return;
        index = to;
        queueMicrotask(() => { for (const fn of [...listeners]) fn(); });
      },
      forward() {
        log.push("forward");
        if (index + 1 >= entries.length) return;
        index += 1;
        queueMicrotask(() => { for (const fn of [...listeners]) fn(); });
      },
    },
    addEventListener: (name, fn) => { if (name === "popstate") listeners.add(fn); },
    removeEventListener: (name, fn) => { if (name === "popstate") listeners.delete(fn); },
    log,
    entries: () => entries.map((e) => e.url),
  };
  return win;
}

/** Кадр так, как его видит адрес: вид, запись, черновик, способ появления. */
const frame = (view, record_id = null, extra = {}) =>
  ({ view, record_id, draft: false, target: "page", ...extra });

/** Склад: снимок и подписка на его смену -- больше адресу ничего не нужно. */
function fakeStore(snapshot) {
  const subs = new Set();
  return {
    state: { snapshot },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    set(next) {
      this.state = { snapshot: next };
      for (const fn of [...subs]) fn();
    },
  };
}

const snapshot = (stack, active = "Tasks", screens = ["Tasks", "Notes"]) => ({
  active, screens: screens.map((key) => ({ key })), stacks: { [active]: stack },
});

const wait = () => new Promise((done) => setTimeout(done, 0));

const CASES = {
  /** Форма адреса: что в него попадает и что из него читается обратно. */
  async form(_win, address) {
    const of = (stack) => address.addressUrl("Tasks", stack);
    return {
      root: of([frame("Tasks")]),
      record: of([frame("Tasks"), frame("TaskCard", "t1")]),
      deep: of([frame("Tasks"), frame("TaskCard", "t1"), frame("Sub", "t4")]),
      // Кадр без записи -- законный: вид-раздел в глубине стека.
      bare: of([frame("Tasks"), frame("Settings")]),
      // Карточка и черновик местом не считаются: адрес обрывается на них.
      sheet: of([frame("Tasks"), frame("Draft", null, { target: "sheet" })]),
      draft: of([frame("Tasks"), frame("Draft", null, { draft: true })]),
      afterSheet: of([frame("Tasks"), frame("Draft", null, { target: "sheet" }),
                      frame("TaskCard", "t1")]),
      // Прочерк обязан читаться обратно, а не только писаться: кадр без
      // записи -- законное место, и ссылка на него ведёт именно туда.
      dash: address.parseAddress(of([frame("Tasks"), frame("Settings")])),
      // Ключ записи бывает каким угодно -- в адресе он обязан пережить дорогу.
      odd: address.parseAddress(of([frame("Tasks"), frame("Card", "a/b?c d")])),
      typed: address.parseAddress("#!/Tasks"),
      full: address.parseAddress("myapp://open/#!/Tasks/TaskCard/t1/"),
      noHash: address.parseAddress("capacitor://localhost"),
      empty: address.parseAddress("#!/"),
      broken: address.parseAddress("#!/%E0%A4%A/"),
    };
  },

  /** Обычный ход: корень, запись, назад, снова запись. */
  async write(win, address) {
    const store = fakeStore(snapshot([frame("Tasks")]));
    address.bindAddress({ store, dispatch: () => {} });
    store.set(snapshot([frame("Tasks")]));
    store.set(snapshot([frame("Tasks"), frame("TaskCard", "t1")]));
    await wait();
    store.set(snapshot([frame("Tasks")]));
    await wait();
    store.set(snapshot([frame("Tasks"), frame("TaskCard", "t4")]));
    await wait();
    return { log: win.log, hash: win.location.hash, entries: win.entries() };
  },

  /**
   * Крошка: стек укоротился сразу на два уровня.
   *
   * Отдельным случаем от `write`, потому что спор здесь ровно один -- на
   * сколько записей отходит история. Пока кадры снимались по одному, разницы
   * между «на одну» и «на столько, сколько сняли» не было видно.
   */
  async crumb(win, address) {
    const store = fakeStore(snapshot([frame("Tasks")]));
    const events = [];
    address.bindAddress({ store, dispatch: (ev) => events.push(ev) });
    // Первое место -- корень: с него человек и начинает, и заменой оно встаёт в
    // ту запись истории, на которую он пришёл.
    store.set(snapshot([frame("Tasks")]));
    store.set(snapshot([frame("Tasks"), frame("TaskCard", "t1")]));
    await wait();
    store.set(snapshot([frame("Tasks"), frame("TaskCard", "t1"), frame("TaskCard", "t4")]));
    await wait();
    // `back_to` на корень: рантайм снял оба кадра разом и отдал новый стек.
    store.set(snapshot([frame("Tasks")]));
    await wait();
    return { events, log: win.log, hash: win.location.hash, entries: win.entries() };
  },

  /** Кнопка «назад» браузера: адрес ведёт стек, а не наоборот. */
  async back(win, address) {
    const store = fakeStore(snapshot([frame("Tasks")]));
    const events = [];
    const dispatch = (ev) => {
      events.push(ev);
      if (ev.type !== "goto") return;
      store.set(snapshot(
        [frame("Tasks"), ...ev.path.map((s) => frame(s.view, s.record_id))], ev.screen));
    };
    address.bindAddress({ store, dispatch });
    store.set(snapshot([frame("Tasks")]));
    store.set(snapshot([frame("Tasks"), frame("TaskCard", "t1")]));
    await wait();
    win.history.back();
    await wait();
    win.history.forward();
    await wait();
    return { events, log: win.log, hash: win.location.hash };
  },

  /**
   * Глубокая ссылка: пришли по адресу -- оказались в записи.
   *
   * Рантайм отвечает не в тот же такт -- событие едет в воркер и обратно, -- а
   * склад за это время успевает смениться по своему поводу: в приложении этим
   * же тактом приходит состояние обмена (`main.jsx`, `store.set({sync})`).
   * Подделано это здесь нарочно: стек в тот миг ещё корневой, и подписка,
   * заведённая раньше ответа, «поправила» бы строку по нему -- адрес мигнул бы
   * корнем раздела, а вместо одной записи истории вышло бы две.
   */
  async link(win, address) {
    const store = fakeStore(snapshot([frame("Tasks")]));
    const events = [];
    const dispatch = (ev) => {
      events.push(ev);
      return wait().then(() => store.set(snapshot(
        [frame("Tasks"), ...ev.path.map((s) => frame(s.view, s.record_id))], ev.screen)));
    };
    address.bindAddress({ store, dispatch });
    store.set(snapshot([frame("Tasks")]));
    await wait();
    await wait();
    return { events, log: win.log, hash: win.location.hash, entries: win.entries() };
  },

  /** Ссылка в раздел, которого в приложении нет. */
  async stranger(win, address) {
    const store = fakeStore(snapshot([frame("Tasks")]));
    const events = [];
    address.bindAddress({ store, dispatch: (ev) => events.push(ev) });
    store.set(snapshot([frame("Tasks")]));
    return { events, log: win.log, hash: win.location.hash };
  },

  /**
   * Нативная сборка: адресной строки нет, ссылка приходит в дверь.
   *
   * Дверей две, и обе обязательны. `getLaunchUrl()` -- та ссылка, которой
   * приложение запустили: при холодном старте `appUrlOpen` выстреливает
   * раньше, чем рантайм готов его принять, и одной подпиской она теряется.
   * Подделка это и изображает -- ссылку запуска она в подписку не отдаёт
   * вовсе, только ответом.
   *
   * Второе, ради чего случай заведён: история здесь не двигается ни разу.
   * `pushState` в Capacitor идёт на путь, которого нет (приложение загружено
   * файлом), и ломает перезапуск webview -- значит `log` обязан остаться
   * пустым, что бы со стеком ни делали.
   */
  async native(win, address) {
    const app = (globalThis.__capacitorApp = { listeners: {}, launch: null, removed: 0 });
    app.launch = "myapp://open/#!/Tasks/TaskCard/t1/";
    const store = fakeStore(snapshot([frame("Tasks")]));
    const events = [];
    const dispatch = (ev) => events.push(ev);
    const off = address.bindAddress({ store, dispatch, native: true });
    // Ожиданием, а не счётом тактов: привязка идёт через `import()`, и сколько
    // тактов займёт чтение модуля с диска -- не наше дело.
    for (let i = 0; i < 200 && !app.listeners.appUrlOpen; i += 1) await wait();
    await wait();

    const fire = (url) => { for (const fn of app.listeners.appUrlOpen || []) fn({ url }); };
    // Ссылка при живом приложении -- вторая дверь.
    fire("myapp://open/#!/Tasks/TaskCard/t4/");
    // Своя же схема без `#` -- не адрес: так выглядит обычный запуск.
    fire("capacitor://localhost");
    // Раздел, которого в приложении нет.
    fire("myapp://open/#!/Nope/TaskCard/t1/");

    off();
    // После отвязки дверь закрыта -- слушателя больше нет.
    fire("myapp://open/#!/Tasks/TaskCard/t9/");
    // И стек, сменившийся когда угодно, истории не касается.
    store.set(snapshot([frame("Tasks"), frame("TaskCard", "t4")]));
    await wait();
    const left = (app.listeners.appUrlOpen || []).length;
    return { events, log: win.log, removed: app.removed, left };
  },

  /** Ссылка привела туда, где записи уже нет: строка обязана сказать правду. */
  async stale(win, address) {
    const store = fakeStore(snapshot([frame("Tasks")]));
    const events = [];
    // Рантайм обрывает путь на снесённой записи и возвращает стек как есть --
    // тем же порядком, что и в `link`: ответом, а не в такт события.
    const dispatch = (ev) => {
      events.push(ev);
      return wait().then(() => store.set(snapshot([frame("Tasks")])));
    };
    address.bindAddress({ store, dispatch });
    // Тот же посторонний такт, что и в `link`: строку он не двигает.
    store.set(snapshot([frame("Tasks")]));
    await wait();
    await wait();
    return { events, log: win.log, hash: win.location.hash };
  },
};

const win = fakeWindow(input.hash || "");
globalThis.window = win;
const address = await import("../../web/src/address.js");
const out = await CASES[input.case](win, address);
process.stdout.write(JSON.stringify(out));

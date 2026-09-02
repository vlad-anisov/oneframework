/**
 * Адресная строка: форма адреса, запись в историю и дорога обратно.
 *
 * Проверяется тот же файл, который поедет в браузер (`web/src/address.js`), --
 * ввозом, а не сборкой. Рантайм не участвует вовсе: здесь спор не о том, что
 * делает `goto`, а о том, когда он рождается и что в это время происходит с
 * историей браузера. Про сам `goto` -- `tests/test_screens.py`: там он
 * спрашивается у того рантайма, что стоит на устройстве.
 *
 * Снаружи адресу нужны окно, склад и -- в нативной сборке -- плагин
 * `@capacitor/app`; все три подделаны здесь и рядом (`capacitor_app.mjs`,
 * `capacitor_hooks.mjs`).
 *
 * Окно подделано с настоящей историей: список записей и указатель в нём, потому
 * что весь спор здесь про историю и есть -- «добавить запись», «заменить
 * запись» и «уйти на запись назад» ведут себя одинаково ровно до тех пор, пока
 * никто не нажал «назад». `popstate` приходит микрозадачей, как в браузере:
 * `history.back()` возвращает управление раньше события.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Дверь нативной сборки ходит в `@capacitor/app`, а его в Node нет. Переходник
// ставится до всякого ввоза -- разбираются только те, что после него, поэтому
// сам адрес ввозится ниже и через `import()`.
register("../parity/capacitor_hooks.mjs", import.meta.url);

const address = await import("../../web/src/address.js");

/** Окно с историей. `log` -- то, ради чего всё: чем именно её двигали. */
function окно(hash = "") {
  const log = [];
  let записи = [{ url: hash, state: null }];
  let где = 0;
  const слушатели = new Set();
  const дёрнуть = () => queueMicrotask(() => { for (const fn of [...слушатели]) fn(); });
  return {
    location: { get hash() { return записи[где].url; } },
    history: {
      get state() { return записи[где].state; },
      pushState(state, _title, url) {
        log.push(`push ${url}`);
        записи = записи.slice(0, где + 1);
        записи.push({ url, state });
        где += 1;
      },
      replaceState(state, _title, url) {
        log.push(`replace ${url}`);
        записи[где] = { url, state };
      },
      back() { this.go(-1); },
      // Настоящая история умеет шаг любой длины, и это не мелочь: возврат сразу
      // через несколько уровней (крошки шлют `back_to`) обязан снять столько же
      // своих записей, сколько уровней сняли. Один шаг оставил бы браузер на
      // промежуточном адресе, а тот развернулся бы обратно в стек.
      go(delta) {
        log.push(`go ${delta}`);
        const куда = Math.min(Math.max(где + delta, 0), записи.length - 1);
        if (куда === где) return;
        где = куда;
        дёрнуть();
      },
      forward() {
        log.push("forward");
        if (где + 1 >= записи.length) return;
        где += 1;
        дёрнуть();
      },
    },
    addEventListener: (имя, fn) => { if (имя === "popstate") слушатели.add(fn); },
    removeEventListener: (имя, fn) => { if (имя === "popstate") слушатели.delete(fn); },
    log,
    entries: () => записи.map((з) => з.url),
  };
}

/** Поставить окно и вернуть его: адрес читает `window` каждый раз заново. */
function поставить(hash = "") {
  const w = окно(hash);
  globalThis.window = w;
  return w;
}

/** Кадр так, как его видит адрес: вид, запись, черновик, способ появления. */
const кадр = (view, record_id = null, ещё = {}) =>
  ({ view, record_id, draft: false, target: "page", ...ещё });

/** Склад: снимок и подписка на его смену -- больше адресу ничего не нужно. */
function склад(снимок) {
  const подписки = new Set();
  return {
    state: { snapshot: снимок },
    subscribe(fn) { подписки.add(fn); return () => подписки.delete(fn); },
    set(следующий) {
      this.state = { snapshot: следующий };
      for (const fn of [...подписки]) fn();
    },
  };
}

const снимок = (стек, активный = "Tasks", разделы = ["Tasks", "Notes"]) => ({
  active: активный,
  screens: разделы.map((key) => ({ key })),
  stacks: { [активный]: стек },
});

const такт = () => new Promise((готово) => setTimeout(готово, 0));

// --------------------------------------------------------------------------
// Форма адреса: что в него попадает и что из него читается обратно.
// --------------------------------------------------------------------------
const адрес = (стек) => address.addressUrl("Tasks", стек);

test("адрес несёт весь стек, а не его вершину", () => {
  // Иначе по ссылке восстанавливается место, но не путь возврата.
  assert.equal(адрес([кадр("Tasks")]), "#!/Tasks/");
  assert.equal(адрес([кадр("Tasks"), кадр("TaskCard", "t1")]), "#!/Tasks/TaskCard/t1/");
  assert.equal(адрес([кадр("Tasks"), кадр("TaskCard", "t1"), кадр("Sub", "t4")]),
               "#!/Tasks/TaskCard/t1/Sub/t4/");
  // Кадр без записи -- вид-раздел в глубине стека. Прочерк, чтобы пары не съехали.
  assert.equal(адрес([кадр("Tasks"), кадр("Settings")]), "#!/Tasks/Settings/-/");
});

test("карточка и черновик -- не места", () => {
  // Карточка -- состояние поверх места, черновик -- запись, которой ещё нет.
  assert.equal(адрес([кадр("Tasks"), кадр("Draft", null, { target: "sheet" })]), "#!/Tasks/");
  assert.equal(адрес([кадр("Tasks"), кадр("Draft", null, { draft: true })]), "#!/Tasks/");
  // И хвост за ними не приклеивается к корню: склеенный через пропуск путь
  // описывал бы стек, которого не было.
  assert.equal(адрес([кадр("Tasks"), кадр("Draft", null, { target: "sheet" }),
                      кадр("TaskCard", "t1")]), "#!/Tasks/");
});

test("прочитанный адрес -- тот же, что записанный", () => {
  // Прочерк читается отсутствием записи, а не записью с ключом «-»: такую
  // `goto` пошёл бы искать в базе, не нашёл бы и молча оборвал путь -- ссылка
  // на вид-раздел приводила бы на корень.
  assert.deepEqual(address.parseAddress(адрес([кадр("Tasks"), кадр("Settings")])),
                   { screen: "Tasks", path: [{ view: "Settings", record_id: null }] });
  // Ключ записи бывает каким угодно -- в адресе он обязан пережить дорогу.
  assert.deepEqual(address.parseAddress(адрес([кадр("Tasks"), кадр("Card", "a/b?c d")])),
                   { screen: "Tasks", path: [{ view: "Card", record_id: "a/b?c d" }] });
  // Набранный руками -- без завершающей косой черты.
  assert.deepEqual(address.parseAddress("#!/Tasks"), { screen: "Tasks", path: [] });
  // В нативе приезжает целая ссылка со схемой, разбирается та же часть.
  assert.deepEqual(address.parseAddress("myapp://open/#!/Tasks/TaskCard/t1/"),
                   { screen: "Tasks", path: [{ view: "TaskCard", record_id: "t1" }] });
});

test("что не адрес -- то ничто", () => {
  // Адрес -- ввод снаружи: набран руками, обрезан почтой, сохранён до
  // переименования.
  assert.equal(address.parseAddress("capacitor://localhost"), null,
               "`capacitor://localhost` -- не раздел `capacitor:`");
  assert.equal(address.parseAddress("#!/"), null);
  assert.equal(address.parseAddress("#!/%E0%A4%A/"), null,
               "процент без пары цифр -- исключение в decodeURI");
});

// --------------------------------------------------------------------------
// История: она обязана вести себя как история, иначе «назад» браузера ведёт
// вперёд.
// --------------------------------------------------------------------------
test("вперёд прибавляет место, назад -- убавляет", async () => {
  const win = поставить();
  const хранилище = склад(снимок([кадр("Tasks")]));
  const off = address.bindAddress({ store: хранилище, dispatch: () => {} });
  хранилище.set(снимок([кадр("Tasks")]));
  хранилище.set(снимок([кадр("Tasks"), кадр("TaskCard", "t1")]));
  await такт();
  хранилище.set(снимок([кадр("Tasks")]));
  await такт();
  хранилище.set(снимок([кадр("Tasks"), кадр("TaskCard", "t4")]));
  await такт();
  off();

  assert.deepEqual(win.log, [
    // Первое место -- то, на которое человек пришёл: замена, а не запись.
    "replace #!/Tasks/",
    "push #!/Tasks/TaskCard/t1/",
    // Возврат снимает свою же запись, а не кладёт ещё одну.
    "go -1",
    "push #!/Tasks/TaskCard/t4/",
  ]);
  assert.deepEqual(win.entries(), ["#!/Tasks/", "#!/Tasks/TaskCard/t4/"]);
  assert.equal(win.location.hash, "#!/Tasks/TaskCard/t4/");
});

test("крошка разматывает столько записей, сколько уровней", async () => {
  // Крошки шлют `back_to`, и стек укорачивается не на кадр, а на сколько
  // придётся. Пока история отходила ровно на одну запись, браузер оставался на
  // промежуточном адресе -- и тот немедленно разворачивался обратно в стек:
  // нажатие на крошку читалось как «вернулся и снова провалился». Событие в
  // ответе тому и свидетель: его быть не должно.
  const win = поставить();
  const хранилище = склад(снимок([кадр("Tasks")]));
  const события = [];
  const off = address.bindAddress({ store: хранилище, dispatch: (е) => события.push(е) });
  // Первое место -- корень: с него человек и начинает, и заменой оно встаёт в
  // ту запись истории, на которую он пришёл.
  хранилище.set(снимок([кадр("Tasks")]));
  хранилище.set(снимок([кадр("Tasks"), кадр("TaskCard", "t1")]));
  await такт();
  хранилище.set(снимок([кадр("Tasks"), кадр("TaskCard", "t1"), кадр("TaskCard", "t4")]));
  await такт();
  // `back_to` на корень: рантайм снял оба кадра разом и отдал новый стек.
  хранилище.set(снимок([кадр("Tasks")]));
  await такт();
  off();

  assert.deepEqual(win.log, [
    "replace #!/Tasks/",
    "push #!/Tasks/TaskCard/t1/",
    "push #!/Tasks/TaskCard/t1/TaskCard/t4/",
    "go -2",
  ]);
  assert.deepEqual(события, []);
  assert.equal(win.location.hash, "#!/Tasks/");
});

test("кнопка браузера становится событием", async () => {
  // Стек -- единственный вход в навигацию: `popstate` разворачивается в
  // событие рантайма, а не в движение маршрутизатора.
  const win = поставить();
  const хранилище = склад(снимок([кадр("Tasks")]));
  const события = [];
  const dispatch = (е) => {
    события.push(е);
    if (е.type !== "goto") return;
    хранилище.set(снимок(
      [кадр("Tasks"), ...е.path.map((с) => кадр(с.view, с.record_id))], е.screen));
  };
  const off = address.bindAddress({ store: хранилище, dispatch });
  хранилище.set(снимок([кадр("Tasks")]));
  хранилище.set(снимок([кадр("Tasks"), кадр("TaskCard", "t1")]));
  await такт();
  win.history.back();
  await такт();
  win.history.forward();
  await такт();
  off();

  assert.deepEqual(события, [
    { type: "goto", screen: "Tasks", path: [] },
    { type: "goto", screen: "Tasks", path: [{ view: "TaskCard", record_id: "t1" }] },
  ]);
  // Ответный стек адрес уже описывает -- значит история от него не двигается.
  assert.deepEqual(win.log, ["replace #!/Tasks/", "push #!/Tasks/TaskCard/t1/",
                             "go -1", "forward"]);
  assert.equal(win.location.hash, "#!/Tasks/TaskCard/t1/");
});

test("ссылка открывает названную запись, не мигая корнем", async () => {
  // Ответ рантайма приходит не в тот же такт -- событие едет в воркер и
  // обратно, -- а склад за это время меняется по своему поводу: в приложении
  // этим тактом приходит состояние обмена (`main.jsx`, `store.set({sync})`).
  // Пока подписка заводилась раньше ответа, тот посторонний такт читался как
  // «стек стал корнем», и адрес правился по нему: строка мигала корнем, а под
  // ссылкой заводилась вторая запись истории. Посторонний такт подан нарочно,
  // поэтому проверка его и видит.
  const win = поставить("#!/Tasks/TaskCard/t1");
  const хранилище = склад(снимок([кадр("Tasks")]));
  const события = [];
  const dispatch = (е) => {
    события.push(е);
    return такт().then(() => хранилище.set(снимок(
      [кадр("Tasks"), ...е.path.map((с) => кадр(с.view, с.record_id))], е.screen)));
  };
  const off = address.bindAddress({ store: хранилище, dispatch });
  хранилище.set(снимок([кадр("Tasks")]));
  await такт();
  await такт();
  off();

  assert.deepEqual(события, [
    { type: "goto", screen: "Tasks", path: [{ view: "TaskCard", record_id: "t1" }] },
  ]);
  // Канон сразу: дальше адрес сравнивается строкой.
  assert.deepEqual(win.log, ["replace #!/Tasks/TaskCard/t1/"]);
  assert.deepEqual(win.entries(), ["#!/Tasks/TaskCard/t1/"]);
  assert.equal(win.location.hash, "#!/Tasks/TaskCard/t1/");
});

test("ссылка в исчезнувший раздел не двигает ничего", async () => {
  // Ссылка живёт в закладке дольше, чем раздел с таким именем.
  const win = поставить("#!/Nope/TaskCard/t1/");
  const хранилище = склад(снимок([кадр("Tasks")]));
  const события = [];
  const off = address.bindAddress({ store: хранилище, dispatch: (е) => события.push(е) });
  хранилище.set(снимок([кадр("Tasks")]));
  off();

  assert.deepEqual(события, []);
  // Рантайм об этом адресе не слышал, а строка поправлена по стеку.
  assert.deepEqual(win.log, ["replace #!/Tasks/"]);
  assert.equal(win.location.hash, "#!/Tasks/");
});

test("ссылка, которую рантайм не смог выполнить, поправлена", async () => {
  // Записи по ссылке уже нет: рантайм оборвал путь, строка обязана сказать
  // правду.
  const win = поставить("#!/Tasks/TaskCard/gone/");
  const хранилище = склад(снимок([кадр("Tasks")]));
  const события = [];
  // Рантайм обрывает путь на снесённой записи и возвращает стек как есть --
  // тем же порядком, что и по живой ссылке: ответом, а не в такт события.
  const off = address.bindAddress({
    store: хранилище,
    dispatch: (е) => { события.push(е); return такт().then(() => хранилище.set(снимок([кадр("Tasks")]))); },
  });
  // Тот же посторонний такт: строку он не двигает.
  хранилище.set(снимок([кадр("Tasks")]));
  await такт();
  await такт();
  off();

  assert.equal(события[0].type, "goto");
  assert.deepEqual(win.log, ["replace #!/Tasks/"]);
  assert.equal(win.location.hash, "#!/Tasks/");
});

test("в нативной сборке ссылка входит обеими дверями", async () => {
  // Адресной строки нет, и ссылка входит событием. `getLaunchUrl()` -- не
  // роскошь рядом с подпиской: при холодном старте `appUrlOpen` выстреливает
  // раньше, чем рантайм готов его принять, и одной подпиской ссылка запуска
  // теряется молча. Подделка плагина (`tests/parity/capacitor_app.mjs`) это и
  // изображает: ссылку запуска она в подписку не отдаёт вовсе.
  //
  // Второе обещание -- история не двигается ни разу. `pushState` в Capacitor
  // идёт на путь, которого нет (приложение загружено файлом `index.html`), и
  // ломает перезапуск webview.
  const win = поставить();
  const плагин = (globalThis.__capacitorApp =
    { listeners: {}, launch: "myapp://open/#!/Tasks/TaskCard/t1/", removed: 0 });
  const хранилище = склад(снимок([кадр("Tasks")]));
  const события = [];
  const off = address.bindAddress({ store: хранилище, dispatch: (е) => события.push(е),
                                    native: true });
  // Ожиданием, а не счётом тактов: привязка идёт через `import()`, и сколько
  // тактов займёт чтение модуля с диска -- не наше дело.
  for (let i = 0; i < 200 && !плагин.listeners.appUrlOpen; i += 1) await такт();
  await такт();

  const дёрнуть = (url) => { for (const fn of плагин.listeners.appUrlOpen || []) fn({ url }); };
  дёрнуть("myapp://open/#!/Tasks/TaskCard/t4/");   // при живом приложении -- вторая дверь
  дёрнуть("capacitor://localhost");                // обычный запуск, а не ссылка
  дёрнуть("myapp://open/#!/Nope/TaskCard/t1/");    // раздела нет -- и события нет

  off();
  дёрнуть("myapp://open/#!/Tasks/TaskCard/t9/");   // дверь закрыта
  // И стек, сменившийся когда угодно, истории не касается.
  хранилище.set(снимок([кадр("Tasks"), кадр("TaskCard", "t4")]));
  await такт();

  assert.deepEqual(события, [
    // Первой -- та, которой приложение запустили.
    { type: "goto", screen: "Tasks", path: [{ view: "TaskCard", record_id: "t1" }] },
    // Второй -- открытая при живом приложении.
    { type: "goto", screen: "Tasks", path: [{ view: "TaskCard", record_id: "t4" }] },
  ]);
  assert.deepEqual(win.log, []);
  // Отвязка закрывает дверь, а не только перестаёт слушать.
  assert.equal(плагин.removed, 1);
  assert.equal((плагин.listeners.appUrlOpen || []).length, 0);
});

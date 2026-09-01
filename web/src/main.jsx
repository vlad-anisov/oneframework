/**
 * Оболочка приложения.
 *
 * Показывает настоящую рамку приложения сразу, заводит рантайм в стороне, а
 * дальше всякий кадр отдаёт истолкователю.
 *
 * Framework7 здесь больше не собирается вручную: его заводит `<App>` из
 * framework7-react, а до того нужно ровно две вещи -- полный набор его
 * составляющих и подключённый переходник маршрутизатора, без которого страницы
 * React маршрутизатору некуда положить. Обе -- ниже, обе один раз.
 */

import Framework7, { getDevice } from "framework7/bundle";
import Framework7React, { f7ready } from "framework7-react";
import React from "react";
import { createRoot } from "react-dom/client";
import "framework7/css/bundle";
// Framework7's TextEditor (and any component using `.material-icons`) renders
// its toolbar from the Material Icons font. Imported from npm and bundled, so
// it is served from our own origin and stays available offline.
import "material-icons/iconfont/filled.css";
// Framework7's Material theme asks for `Roboto, system-ui, ...` and never ships
// it: Android has it, and nothing else does. On a desktop PWA -- and in the
// headless Chromium the comparison shots are taken in -- the first name misses
// and the text is set in system-ui instead, which is a different face at a
// different width. Same treatment as the icon font: from npm, bundled, served
// from our own origin, so it is there offline and on every platform.
//
// Three weights, not the ten Roboto ships: Framework7 asks for 400, 500, 600
// and 700, and 600 resolves to 700 by the CSS weight-matching rule, so these
// three are every face the stylesheet can reach -- and a missing one would be
// synthesized, which is the drift this import is here to remove. Each file is
// one script's subset behind a `unicode-range`, so a page downloads only the
// alphabets it actually sets.
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";

import { bindAddress } from "./address.js";
import { JsHost } from "./js-host.js";
import { detectLocale } from "./i18n.js";
import { preformatted } from "./text.js";
import { Shell } from "./react/shell.jsx";
import { Store } from "./react/store.js";
import { registerWidget } from "./react/widgets.jsx";
import {
  bindBrowser, describe, resolveEndpoint, sinceText, SyncTransport,
} from "./runtime/transport.js";

/** The wire this renderer speaks -- see protocol/wire.json. */
const PROTOCOL = "1.0";

// Переходник маршрутизатора: без него `component:` в маршруте некому
// смонтировать, а `f7ready` некому позвать -- очередь событий заводится тем же
// вызовом.
Framework7.use(Framework7React);

/** The status bar follows the page, whatever theme and colour the app chose. */
function paintStatusBar() {
  const bg = getComputedStyle(document.body).getPropertyValue("--f7-page-bg-color").trim();
  if (bg) document.querySelector('meta[name="theme-color"]').setAttribute("content", bg);
}

// Inlined by Vite from .oneframework-build.json, which `oneframework dev`/`oneframework build`
// write from App(theme=..., color=...). Both are needed to construct
// Framework7, which happens before the runtime has booted.
const THEME = __PYAPP_THEME__;
const SEED = __PYAPP_COLOR__;
const СИСТЕМНЫЙ_ЦВЕТ = __PYAPP_DYNAMIC_COLOR__;

/**
 * `auto` -- шире, чем у Framework7.
 *
 * Его правило -- `device.ios ? 'ios' : 'md'`, а `device.ios` читается из строки
 * агента и означает сам iPhone или iPad. Мы добавляем к этому движок: там, где
 * рисует WebKit, родная тема -- iOS, и Safari на маке должен получить её же.
 * Отличается движок по `navigator.vendor`: у WebKit это Apple, у Chromium
 * `Google Inc.`, у Firefox пустая строка. Строка агента при этом остаётся
 * первой -- иначе подменённый агент (так гоняется проверка под айфоном) не
 * доехал бы до темы.
 */
const THEME_РЕШЁН = THEME !== "auto"
  ? THEME
  : (getDevice().ios || /apple/i.test(navigator.vendor || "") ? "ios" : "md");

const F7_PARAMS = {
  name: "oneframework",
  // Framework7 9 selects its theme from the `md`/`ios` class on <html>;
  // switching that one class is all an iOS build needs here.
  //
  // `colors` is what turns the Material 3 theme on: Framework7 derives the
  // whole MD3 tonal palette (surface/primary/secondary-container/outline, light
  // and dark) from this seed and injects it as CSS variables. Without it every
  // `--f7-md-*` token is undefined, and the component defaults that reference
  // them -- app bar, chips, FAB -- fall back to unstyled.
  colors: { primary: SEED },
  mdColorScheme: "default",
  darkMode: "auto",
  // Framework7 9 has exactly two themes, `md` and `ios` (aurora and windows
  // were removed). `auto` is `device.ios ? 'ios' : 'md'` -- measured in
  // `framework7-bundle.js`, `getTheme()` -- and `device.ios` means an actual
  // iPhone or iPad, not any Apple machine: a Mac browser resolves to `md`
  // (проверено на живом стенде). Framework7 puts the matching class on <html>
  // itself, so nothing else has to know.
  // The stylesheet uses only theme-neutral Framework7 variables, so both
  // render correctly. An app can pin one with App(theme="md"|"ios").
  theme: THEME_РЕШЁН,
  view: {
    browserHistory: false,
    // Android edge-swipe back, matching the platform gesture.
    mdSwipeBack: true,
    // Per-view: the renderer turns the split off for a screen whose list asked
    // to be a table (see Screen.master_detail).
    masterDetailResizable: true,
  },
  // `touchRipple` is on by default and already covers `button`, `.link` and
  // `.actions-button`; adding the `ripple` class to a row opts it in too.
  touch: { tapHold: true, touchRipple: true },
  dialog: { closeByBackdropClick: true },
};


/**
 * Цвет системы вместо объявленного -- там, где платформа его правда даёт.
 *
 * Из веба его не достать: замерено и записано в `docs/probe-system-color.md`.
 * Живой Safari при красном акценте отдаёт постоянное «яблочное синее», а
 * Chrome не знает ключа `AccentColor` вовсе. Material You выставлен только
 * родному коду -- палитрой ресурсов `system_accent1_*` с Android 12, -- и
 * достаётся оттуда крошечным плагином Capacitor.
 *
 * Спрашивается ПОСЛЕ сборки Framework7, а не до: тогда ответу позволено быть
 * небыстрым, и никакой гонки с загрузкой страницы нет. Семя меняется его же
 * приёмом -- `setColorTheme`, который пересобирает всю тональную палитру.
 *
 * Молчание платформы -- обычный случай, а не отказ: в браузере плагина нет
 * вовсе, на Android до 12 нет самой палитры. Тогда остаётся объявленный цвет,
 * и это не запасной путь, а лицо приложения.
 */
async function взять_цвет_системы(f7) {
  if (!СИСТЕМНЫЙ_ЦВЕТ) return;
  try {
    const { registerPlugin } = await import("@capacitor/core");
    const плагин = registerPlugin("SystemColor");
    const { color } = await плагин.get();
    if (color) f7.setColorTheme(color);
  } catch {
    // не внутри Capacitor -- значит и системного цвета здесь нет
  }
}

/**
 * Что показать, когда нажали на значок обмена.
 *
 * Framework7's own action sheet, with nothing but labels and one button: the
 * three things worth knowing (state, when the last round was, where it goes),
 * and a way to ask for a round now. The stand's note is here too -- an
 * unauthenticated server has to say so where the user actually looks.
 */
function syncSheet(f7, transport) {
  const state = transport.state;
  const lines = [
    describe(state),
    `Последний обмен: ${sinceText(state)}`,
    transport.endpoint
      ? `Сервер: ${transport.endpoint}`
      : "Адрес сервера не задан — обмена нет",
  ];
  if (transport.stand?.note) lines.push(transport.stand.note);
  return f7.actions
    .create({
      buttons: [
        [
          { text: "Обмен с сервером", label: true, bold: true },
          ...lines.map((text) => ({ text, label: true })),
        ],
        transport.endpoint
          ? [{ text: "Обменяться сейчас", bold: true,
               onClick: () => transport.run("tap") }]
          : [],
        [{ text: "Закрыть", color: "red" }],
      ].filter((group) => group.length),
      closeByBackdropClick: true,
      destroyOnClose: true,
    })
    .open();
}

// -- склад и оболочка ------------------------------------------------------
// Оболочка рисуется до всякого рантайма: рамка приложения должна стоять уже к
// первому кадру, а кадра ещё нет. Пока склад пуст, `<Shell>` рисует только
// корень Framework7 -- виды появляются вместе с первым снимком.
const store = new Store();
//: Отправка и нажатие на значок обмена переживают собственное появление:
//: оболочка держит их с первой отрисовки, а рантайм и обмен заводятся позже.
let host = null;
let transport = null;
const dispatch = (event) => sendEvent(event);
const onSyncTap = () => transport && syncSheet(f7ref.f7, transport);
const f7ref = {};

createRoot(document.getElementById("app")).render(
  <Shell store={store} dispatch={dispatch} f7params={F7_PARAMS} onSyncTap={onSyncTap} />,
);

/** Одно событие интерфейса -- следующий кадр. */
async function sendEvent(event) {
  if (!host) return;
  try {
    const next = await host.dispatch(event);
    if (next.error) {
      console.error("[oneframework]", next.error.message, next.error.traceback);
      f7ref.f7.toast.create({ text: next.error.message, closeTimeout: 4000 }).open();
      return;
    }
    store.set({ snapshot: next.snapshot });
    // Событие интерфейса -- почти всегда запись. Обмен заводится по нему, а не
    // только по таймеру: иначе чужой экран узнаёт о правке через минуту.
    transport?.nudge();
  } catch (err) {
    console.error("[oneframework] dispatch failed", err);
  }
}

async function main() {
  const f7 = await new Promise((ready) => f7ready(ready));
  f7ref.f7 = f7;

  await взять_цвет_системы(f7);

  // Framework7 injects its palette during construction and swaps it when the
  // system theme flips; the status bar follows the same variable both times.
  paintStatusBar();
  f7.on("darkModeChange", paintStatusBar);

  /**
   * Starting up, as Framework7 shows it.
   *
   * `dialog.preloader` is its own modal spinner with a title, so the boot screen
   * is not markup here at all -- only when the start proves slow enough to be
   * worth interrupting for. A warm start opens the database in well under
   * 200ms, and a flash of "loading" looks worse than showing nothing.
   */
  let booting = null;
  const bootTimer = setTimeout(() => {
    booting = f7.dialog.preloader("Запуск…");
  }, 300);

  const bootDone = () => {
    clearTimeout(bootTimer);
    const dialog = booting;
    booting = null;
    if (!dialog) return;
    // Framework7 keeps the element in the document after closing, and its
    // `closed` event does not fire for a preloader dialog -- so the boot screen
    // is taken out on `close`, which also means the app appears at once instead
    // of fading in behind it.
    dialog.once("close", () => dialog.el?.remove());
    dialog.close();
  };

  /** A start that cannot finish: Framework7's own dialog states why. */
  const fail = (message, detail) => {
    bootDone();
    console.error("[oneframework]", message, detail);
    f7.dialog
      .create({
        title: message,
        text: detail ? preformatted(detail) : "",
        buttons: [{ text: "Закрыть" }],
        destroyOnClose: true,
      })
      .open();
  };

  host = new JsHost({ onStep: (step) => booting?.setTitle(step) });

  try {
    const payload = await host.start();
    if (payload.error) {
      fail("Не удалось запустить приложение", payload.error.traceback || payload.error.message);
      return;
    }

    detectLocale(payload.meta?.locale);
    document.title = payload.meta?.title || "oneframework";
    store.set({ title: document.title });
    // The palette is already correct from the first frame; only re-apply if the
    // running app disagrees with what was inlined (stale build directory).
    if (payload.meta?.color && payload.meta.color !== SEED) {
      f7.setColorTheme(payload.meta.color);
    }
    if (payload.meta?.theme && payload.meta.theme !== THEME) {
      console.warn(
        `[oneframework] App(theme="${payload.meta.theme}") does not match the inlined ` +
          `"${THEME}". Restart 'oneframework dev' (or rebuild) to pick it up.`,
      );
    }

    // Styles shipped by modules, applied before the first render so a module's
    // own widget is never seen unstyled.
    for (const sheet of host.moduleStyles()) {
      if (sheet.error) {
        console.warn("[oneframework] module stylesheet unreadable", sheet.name, sheet.error);
        continue;
      }
      const style = document.createElement("style");
      style.dataset.module = sheet.name;
      style.textContent = sheet.source;
      document.head.appendChild(style);
    }

    // Custom widgets shipped by modules, evaluated before the first render so
    // a module's own widget is available the moment its fields appear.
    const api = { registerWidget, f7 };
    for (const script of host.moduleScripts()) {
      if (script.error) {
        console.warn("[oneframework] module asset unreadable", script.name, script.error);
        continue;
      }
      try {
        new Function("oneframework", script.source)(api);
        console.info("[oneframework] loaded module widget file", script.name);
      } catch (err) {
        console.error("[oneframework] module script failed", script.name, err);
      }
    }

    // Первый кадр. Оболочка ждала его, чтобы завести виды: сколько их и какие
    // -- знает рантайм, а не сборка.
    store.set({ snapshot: payload.snapshot });
    // Виды создаются той же отрисовкой React, которую только что попросили, --
    // и до её конца стека сводить некуда. Один кадр браузера, а не таймер:
    // ровно столько занимает отрисовка, которую мы вызвали.
    await new Promise((done) => requestAnimationFrame(done));
    bootDone();

    // Адрес привязывается сразу за первым кадром и до всего остального: он
    // читает адресную строку **до** того, как первая же запись стека её
    // перепишет, и пришедшая ссылка иначе была бы потеряна. Стек к этому
    // времени уже есть -- значит есть куда её разворачивать.
    bindAddress({ store, dispatch, native: isNative });

    // -- обмен ---------------------------------------------------------
    // `localStorage` в приватном окне и внутри iframe бросает -- обмен из-за
    // этого падать не должен.
    // Адрес: подстановка в окне, потом сборка, потом сам адрес страницы.
    // Последнее и есть «веб-клиент, отданный сервером обмена, работает без
    // настройки»; внутри Capacitor его нет, там адрес задаётся на сборке.
    transport = new SyncTransport({
      host,
      endpoint: resolveEndpoint({
        meta: payload.meta,
        base: document.baseURI,
        native: isNative,
        override: globalThis.PYAPP_SYNC_URL,
      }),
      stand: globalThis.__PYAPP_STAND__ || null,
      // Ключ обмена -- у устройства, а не в сборке: сборка одна на всех, и
      // ключ в ней раздавался бы вместе с приложением. Ставится вручную:
      // `localStorage.oneframeworkSyncKey = "…"`.
      key: safeLocal("oneframeworkSyncKey") || globalThis.PYAPP_SYNC_KEY || null,
      isOnline: () => navigator.onLine !== false,
      onChange: (state) => store.set({ sync: state }),
      // Чужие строки уже легли в базу -- кадр про них ещё не знает.
      onApplied: (report) => store.set({ snapshot: report.snapshot }),
    });
    store.set({ sync: transport.state });
    bindBrowser(transport);
    transport.start();

    // Expose a tiny surface for E2E tests and debugging.
    window.oneframework = {
      protocol: PROTOCOL,
      host,
      f7,
      // Кадр, который сейчас на экране. Проверка спрашивает его отсюда, а не у
      // рантайма: событие «покажи, что у тебя есть» существовало бы только
      // ради неё, и отвечало бы не то, что нарисовано, а то, что рантайм
      // посчитал бы заново.
      snapshot: () => store.state.snapshot,
      renderer: {
        get lastSnapshot() { return store.state.snapshot; },
        get active() { return store.state.snapshot?.active ?? ""; },
      },
      // Снятые кадры, которые оболочка ещё держит (`store.outgoing`). Снаружи
      // они не видны вовсе -- в том и смысл, они живут один переход, -- а
      // «отпустили ли» иначе непроверяемо: утечка выглядит точно так же, как
      // порядок.
      outgoing: () => [...store.outgoing.keys()],
      readRecord: (model, id) => host.readRecord(model, id),
      countRecords: (model) => host.countRecords(model),
      dispatch,
      sync: transport,
      flush: () => host.flushNow(),
      timings: host.timings,
      persistent: host.persistent,
      ready: true,
    };

    // Native splash: held open deliberately (launchAutoHide: false) so the
    // first launch shows the app icon rather than a blank window, and is
    // dismissed the moment there is real content behind it.
    try {
      const { SplashScreen } = await import("@capacitor/splash-screen");
      await SplashScreen.hide();
    } catch {
      // not running inside Capacitor
    }
  } catch (err) {
    // Сообщение впереди стека: `err.stack` у ошибки из воркера бывает без
    // текста вовсе -- остаётся `_receive@…:232`, по которому не понять ничего.
    fail("Ошибка запуска", [err?.message, err?.stack].filter(Boolean).join("\n") || String(err));
    return;
  }

  // -- durability -------------------------------------------------------
  const flush = () => host.flushNow();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  // Уход со страницы -- не то же, что уход во вкладку: там достаточно записать,
  // здесь надо ещё и отпустить файлы, иначе следующая загрузка ждёт, пока
  // браузер отберёт их сам. Поэтому `release` висит только на этих двух.
  const leave = () => {
    flush();
    host.releaseStorage?.();
  };
  window.addEventListener("pagehide", leave);
  window.addEventListener("beforeunload", leave);

  // -- Android hardware back + lifecycle --------------------------------
  try {
    const { App } = await import("@capacitor/app");
    // Дожидаемся привязки, а не просто просим её. Подкладку плагина Capacitor
    // заводит первым же вызовом и запоминает -- но проверку `!jsImplementation`
    // делает *до* ожидания (`@capacitor/core/dist/index.js:73-79`). Значит два
    // вызова, начатых до её загрузки, соберут по своей подкладке, и слушатель
    // окажется на одной, а событие придёт на другую. Ожидание здесь и делает
    // подкладку одной на всех -- в том числе для нажатия, поданного прогоном.
    await App.addListener("backButton", () => {
      // Глубину спрашиваем у стека, а не у маршрутизатора: стек первичен, а у
      // маршрутизатора страниц бывает больше. В широком окне корень раздела
      // тянет за собой пустую половину (`/empty/`), то есть на корне история
      // уже двухстраничная -- и кнопка, судящая по ней, не закрыла бы
      // приложение на планшете, а молча ничего не сделала. Заодно в стеке
      // лежит и карточка, которой в истории нет вовсе.
      const snapshot = store.state.snapshot;
      const stack = snapshot?.stacks?.[snapshot.active];
      if (stack && stack.length > 1) dispatch({ type: "back" });
      else App.exitApp();
    });
    await App.addListener("pause", flush);
  } catch {
    // not running inside Capacitor -- nothing to bind
  }

  // Метка «собран» -- последней строкой, а не сразу после рантайма: привязка
  // аппаратной кнопки идёт через `await import(...)`, то есть заканчивается
  // позже всего остального, а нажатие, пришедшее до неё, пропадает молча --
  // слушателя ещё нет. Пока метка стояла раньше, прогон нажимал в эту щель и
  // краснел через раз.
  document.documentElement.dataset.oneframeworkReady = "1";
}

// The service worker precaches the whole runtime for the PWA. Inside Capacitor
// every asset already ships in the APK, so caching them a second time would
// only waste storage.
function safeLocal(name) {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(name) : null;
  } catch {
    return null;
  }
}

const isNative = !!globalThis.Capacitor?.isNativePlatform?.();
if (import.meta.env.PROD && !isNative && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(new URL("sw.js", document.baseURI).href, { scope: "./" })
      .then((reg) => console.info("[oneframework] service worker ready", reg.scope))
      .catch((err) => console.warn("[oneframework] service worker failed", err));
  });
}

main();

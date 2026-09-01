/**
 * Оболочка: по виду на раздел, панель, полоса разделов, карточка.
 *
 * Приложение ничего из этого не описывает. Один раздел -- и никакой навигации
 * вообще, простой `.view-main`. От двух и выше виды становятся вкладками
 * Framework7 и получают обе подачи, которых требуют платформы: полосу внизу на
 * телефоне и постоянную панель слева, как только окно достаточно широко. Какая
 * из них показана -- чистый CSS, приложение не выбирает.
 *
 * Стек принадлежит рантайму, а не маршрутизатору: маршрутизатор двигают под
 * него. Это единственное место, где зависимость смотрит в обратную сторону, и
 * причина одна -- «назад» приходит с трёх сторон (жест, кнопка телефона,
 * действие приложения), а сойтись все три обязаны в одном стеке.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  App, BlockTitle, f7, Link, Page, Panel, Sheet, Toolbar, View, Views,
} from "framework7-react";

import { t } from "../i18n.js";
import { AppContext, ScreenContext } from "./context.js";
import { Glyph } from "./glyph.jsx";
import { useWide, WIDE_BREAKPOINT } from "./layout.js";
import { commonPrefix, EMPTY_URL, frameOf, rootUrl, stackUrls } from "./route.js";
import { ScreenPage, SheetScreen } from "./screen.jsx";
import { useStore } from "./store.js";

/** В ключе раздела бывают точки, а в селекторе по id они недопустимы. */
const cssId = (id) => String(id).replace(/[^\w-]/g, "_");
const viewId = (screen) => `pa-view-${cssId(screen.key)}`;

/**
 * Делится ли раздел на список и карточку.
 *
 * Отказывается от разделения экран сам, объявлением (`master_detail: false`):
 * таблице нужна вся ширина, и запись открывается в ней обычной страницей.
 * Спрашивают это в двух местах -- границу выдают виду, а проекцию стека решают
 * по ширине окна, -- и описание у правила одно, чтобы два места не разошлись.
 */
const splits = (screen) => screen?.master_detail !== false;

/**
 * Маршруты. Один набор на все виды: какому разделу принадлежит страница, она
 * узнаёт у контекста, а какой это кадр -- из адреса (`route.js`).
 *
 * `master: true` -- то, чем включается разделение на список и карточку: в окне
 * не уже `masterDetailBreakpoint` корневая страница остаётся на месте, а
 * открытая запись рисуется рядом с ней, как это делают обе платформы на
 * планшете. Ниже границы тот же маршрут -- обычный переход. Приложение не
 * описывает ни того, ни другого: оно говорит только `List(open=...)`.
 *
 * Корень раздела -- отдельная запись, а не первый случай общей: `master`
 * спрашивают у маршрута, и функция `master(app, router)` (`navigate.js:36`)
 * параметров цели не видит -- «мастер, если это корень» ей не вернуть.
 */
const ROUTES = [
  { path: "/s/:screen/", master: true, component: ScreenPage },
  { path: "/s/:screen/:view/:record/", component: ScreenPage },
  { path: EMPTY_URL, component: DetailEmpty },
];

/** Пропущенное событие перехода не должно запирать очередь навсегда. */
const TRANSITION_TIMEOUT_MS = 900;

/**
 * Дождаться, пока Framework7 доиграет переход.
 *
 * Слушается роутер вида, а не приложение: `f7` -- общая шина, и `pageAfterOut`
 * соседнего раздела разрешил бы наше обещание чужим переходом. `once:` в
 * опциях перехода не годится: `attachEvents()` (`router-class.js:652-666`)
 * выходит сразу, если события страницы уже привязаны, -- то есть на возврате,
 * где уходящая страница живёт давно, обработчик просто не встанет.
 */
function transition(router, event, action) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      router.off(event, done);
      clearTimeout(timer);
      resolve();
    };
    router.on(event, done);
    const timer = setTimeout(done, TRANSITION_TIMEOUT_MS);
    action();
  });
}

/**
 * Ключи кадров, чьи страницы ещё стоят в маршрутизаторах.
 *
 * Это и есть ответ на «кому уходящий кадр ещё нужен»: страницу рисуют по кадру
 * из её адреса, и пока адрес лежит в истории, спросить дерево могут. Истории, а
 * не DOM: страница живёт в документе на такт дольше, чем в истории, и сведение
 * ждёт как раз того мига, когда история уже сошлась.
 */
function shownFrames(frames) {
  const ids = new Set();
  for (const { router } of frames.values()) {
    for (const url of router.history) {
      const id = frameOf(url);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Сколько шагов сведения делать, прежде чем признать, что мы ходим по кругу. */
const SYNC_GUARD = 20;

/**
 * Свести историю маршрутизатора с проекцией стека.
 *
 * Сравниваются два массива адресов, а не две длины: при равной длине стеки
 * могут быть разными (в разделённом окне запись сменяется пустой половиной, и
 * наоборот), и счёт длин такой случай молча пропускал.
 *
 * Три шага, по одному на вид расхождения:
 *
 *   лишнее в конце  -> `back()`;
 *   недостаёт       -> `navigate()` следующего адреса;
 *   разошёлся хвост -> `navigate(..., {reloadCurrent: true})`, замена страницы.
 *
 * Последнее -- не оптимизация, а единственный работающий путь в разделённом
 * окне: с карточки на мастера Framework7 назад не идёт вовсе (`back.js:490-505,548-550`
 * -- `skipMaster`, и переход просто не состоится), а замена карточки -- его
 * собственный способ показать другую запись рядом с тем же списком.
 *
 * Корень раздела не снимается никогда, поэтому общее начало не короче одного
 * адреса: если разошлось и оно, значит стек сменили целиком, и пересобирать
 * надо вид, а не историю.
 */
async function sync(router, target) {
  for (let guard = 0; guard < SYNC_GUARD; guard += 1) {
    const history = [...router.history];
    const same = commonPrefix(history, target);
    if (same === target.length && history.length === target.length) return;
    const before = history.join("\n");
    if (history.length > same + 1 || same === target.length) {
      // Лишнее сверху -- снять. Пока лишнего больше одной страницы, снимается
      // именно оно, а не подменяется: подменять имеет смысл только последнюю.
      await transition(router, "pageAfterOut", () => router.back());
    } else if (history.length === same) {
      await transition(router, "pageAfterIn", () => router.navigate(target[same]));
    } else {
      await transition(router, "pageAfterIn",
                       () => router.navigate(target[same], { reloadCurrent: true }));
    }
    // Переход, который не состоялся, -- это не «подожди ещё»: повторять его
    // значило бы ждать `TRANSITION_TIMEOUT_MS` двадцать раз подряд. Отказы у
    // маршрутизатора молчаливые (`navigate.js:417`, `back.js:319-321,548-550`), и виден
    // отказ только по тому, что история не двинулась.
    if (router.history.join("\n") === before) {
      console.warn("[oneframework] маршрутизатор отказал в переходе",
                   { history: router.history, target });
      return;
    }
  }
  console.warn("[oneframework] стек не сошёлся за отведённые шаги",
               { history: router.history, target });
}

/**
 * Панель разделов -- та же навигация, что и полоса внизу, только для широкого
 * окна. `no-chevron`: это назначения, а не углубления. Framework7 сам решает,
 * когда её прикрепить открытой, а когда вернуть в выдвижной ящик.
 */
function ScreensPanel({ screens, active, onPick, title }) {
  return (
    <Panel left cover visibleBreakpoint={WIDE_BREAKPOINT}>
      <Page>
        <div className="navbar">
          <div className="navbar-bg" />
          <div className="navbar-inner"><div className="title">{title}</div></div>
        </div>
        <div className="page-content">
          <div className="list list-strong no-chevron">
            <ul>
              {screens.map((s) => (
                <li key={s.key}>
                  <a
                    className={`item-link item-content${s.key === active ? " item-selected" : ""}`}
                    href="#" data-screen={s.key}
                    onClick={(e) => { e.preventDefault(); onPick(s.key); }}
                  >
                    <div className="item-media"><Glyph name={s.icon || "circle"} size={24} /></div>
                    <div className="item-inner">
                      <div className="item-title">{s.label || s.key}</div>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Page>
    </Panel>
  );
}

/**
 * Пустая половина разделённого экрана.
 *
 * Framework7 раскладывает список и карточку сам, но понятия «ещё ничего не
 * выбрано» у него нет -- значит заполнить пустую половину наше дело. Раньше это
 * был элемент, собранный руками и вставленный в вид мимо React: маршрутизатор
 * считает своими все `.page` внутри вида, находил заглушку перебором и убирал
 * сам, посреди перехода, -- а React, попробовав убрать её следом, падал на
 * `removeChild` по узлу, которого в родителе уже нет, и уносил всё дерево.
 *
 * Теперь это обычный маршрут. Класс `page-master-detail` ставит сам Framework7
 * (`navigate.js:133`): страница, приехавшая в вид с мастером, и есть карточка.
 * Убирает он её тоже сам -- но уже через React (`setPages`,
 * `framework7-react/shared/components-router.js`), потому что теперь эта
 * страница ему известна. Причина «синего экрана» исчезла вместе с элементом
 * вне дерева.
 */
function DetailEmpty() {
  return (
    <Page className="pa-detail-empty">
      <div className="block padding-vertical text-align-center">
        <BlockTitle>{t("pickRecord")}</BlockTitle>
        <div className="block-footer">{t("pickRecordHint")}</div>
      </div>
    </Page>
  );
}

export function Shell({ store, dispatch, f7params, onSyncTap }) {
  const { snapshot, title } = useStore(store);
  const screens = snapshot?.screens?.length ? snapshot.screens : null;
  const multi = !!screens && screens.length > 1;
  const active = snapshot?.active ?? screens?.[0]?.key ?? "";
  //: Виды создаёт Framework7, а не React: здесь только их учёт, чтобы стек
  //: рантайма было куда сводить. Лежит на складе, а не в компоненте: до того
  //: же учёта нужно дотянуться кнопке «назад» телефона, а она снаружи дерева.
  const frames = { current: store.frames };
  //: Кадры сводятся один за другим: переход занимает время, и второй, начатый
  //: посреди первого, увёл бы маршрутизатор не туда.
  const queue = useRef(Promise.resolve());
  //: Мы сами двигаем маршрутизатор и вкладки -- и не должны принимать
  //: собственное движение за пользовательское.
  const syncing = useRef(false);
  const activeRef = useRef(null);
  const tabbarRef = useRef(null);
  const [sheet, setSheet] = useState(null);

  //: `f7` -- живая привязка модуля: на первой отрисовке её ещё нет, а к
  //: моменту, когда обработчик или эффект её спросит, уже есть. Поэтому она
  //: читается через свойство, а не запоминается значением.
  const app = useMemo(
    () => ({ get f7() { return f7; }, dispatch, store, onSyncTap }),
    [dispatch, store, onSyncTap],
  );

  // -- события Framework7, живущие дольше кадра ---------------------------
  useEffect(() => {
    // `<li>` Framework7 нам не переставляет -- ему это запрещено
    // (`data-sortable-move-elements` в `nodes.jsx`), -- и спрашивать документ
    // не о чем: жест целиком описан самим событием.
    const onSort = (itemEl, indexes, listEl) => {
      const list = listEl.closest("[data-list-id]");
      if (!list) return;
      // Номер Framework7 считает среди ВСЕХ соседей `<ul>`
      // (`sortable.js`: `indexFrom = $sortingEl.index()`), а первым там лежит
      // не строка: шапка отборов идёт `li.list-group-title`. Рантайм же
      // считает по одним строкам (`on_reorder`, `ids.index(record_id)`), и без
      // пересчёта запись вставала на одну ниже пальца, а у нижнего края это
      // пряталось за обрезкой в `min(len - 1, to)`.
      //
      // Пересчёт -- сколько строк лежит выше соседа, у которого Framework7
      // взял номер. В списке без чужих `li` это то же самое число, поэтому
      // правка ничего не меняет там, где и не было беды.
      // Соседи самой строки, а не потомки `listEl`: событие приносит
      // вместилище с классом `sortable`, у нас это внешний `div.list`, а
      // номер Framework7 считал среди детей `<ul>`.
      const выше = [...itemEl.parentElement.children]
        .slice(0, indexes.to)
        .filter((el) => el.dataset.id !== undefined).length;
      dispatch({
        type: "reorder",
        list_id: list.dataset.listId,
        record_id: itemEl.dataset.id,
        to: выше,
      });
    };
    // Вкладку показывает Framework7 сам; рантайму нужно лишь узнать, какую --
    // чтобы кадр и кнопка «назад» шли по правильному стеку.
    const onTabShow = (tabEl) => {
      if (syncing.current) return;
      for (const [key, frame] of frames.current) {
        if (frame.el === tabEl && key !== activeRef.current) {
          dispatch({ type: "switch_screen", key });
          return;
        }
      }
    };
    f7.on("sortableSort", onSort);
    f7.on("tabShow", onTabShow);
    return () => {
      f7.off("sortableSort", onSort);
      f7.off("tabShow", onTabShow);
    };
  }, [dispatch]);

  // -- одна граница на обе подачи -----------------------------------------
  // Ниже неё телефон (полоса разделов, строки списка), выше -- рабочий стол
  // (панель сбоку, таблицы, крошки). Смена ширины пересобирает кадр целиком:
  // то, чем список себя рисует, зависит от ширины его собственной коробки.
  const wide = useWide();

  // -- стек рантайма -> маршрутизатор Framework7 --------------------------
  useEffect(() => {
    if (!snapshot || !frames.current.size) return;
    queue.current = queue.current
      .then(async () => {
        const key = frames.current.has(snapshot.active)
          ? snapshot.active
          : [...frames.current.keys()][0];
        // Рисуется только видимый раздел: у скрытой вкладки нет раскладки, а
        // окну длинного списка нужны настоящие измерения. Её собственный стек
        // сойдётся, как только она выйдет вперёд.
        if (key !== activeRef.current) {
          activeRef.current = key;
          if (multi) {
            syncing.current = true;
            try {
              if (tabbarRef.current?.el) f7.toolbar.setHighlight(tabbarRef.current.el);
              f7.panel.close("left");
            } finally {
              syncing.current = false;
            }
          }
        }
        const stack = snapshot.stacks?.[key] || [];
        if (!stack.length) return;
        const frame = frames.current.get(key);
        // Карточка поднимается над стеком, а не встаёт в него: страница под ней
        // остаётся где была, и маршрутизатор о карточке не слышит. Карточкой
        // может быть только верхний экран -- всё, что положили бы поверх,
        // стояло бы уже ни на чём.
        const top = stack[stack.length - 1];
        const asSheet = top?.target === "sheet" ? top : null;
        const pages = asSheet ? stack.slice(0, -1) : stack;
        // Разделено ли окно -- вопрос ширины, а не того, что сейчас на экране.
        // Событие `viewMasterDetailBreakpoint` отвечает на другой вопрос («что
        // изменилось»), и мерка у него та же самая: `app.width` против
        // `masterDetailBreakpoint`, который мы виду и выдали. Поэтому спрошено
        // здесь, у той же границы, и пересчитывается вместе с `wide`.
        const def = screens?.find((s) => s.key === key);
        const target = stackUrls(key, pages, wide && splits(def));
        frame.depth = target.length;

        syncing.current = true;
        try {
          await sync(frame.router, target);
        } finally {
          syncing.current = false;
        }

        // Сведение кончилось -- значит кончилась и надобность в снятых кадрах,
        // чьи страницы оно убрало. Спрашиваются все виды разом, а не тот,
        // который сводили: стек скрытого раздела мог укоротиться, пока раздел
        // не показывали, и его страница честно стоит в его истории до тех пор,
        // пока он не выйдет вперёд и не сведётся сам.
        store.releaseOutgoing(shownFrames(frames.current));

        setSheet(asSheet);
      })
      .catch((err) => console.error("[oneframework] сведение стека не удалось", err));
  }, [snapshot, multi, wide]);

  const view = (screen, i) => (
    <ScreenContext.Provider key={screen.key} value={screen.key}>
      <View
        id={viewId(screen)}
        main={i === 0}
        tab={multi}
        tabActive={multi && screen.key === active}
        url={rootUrl(screen.key)}
        routes={ROUTES}
        // Единственный вход в навигацию -- рантайм, и сторож стережёт это со
        // стороны маршрутизатора: «назад», начатое не нами -- стрелка в чужой
        // разметке, которую Framework7 обрабатывает сам по классу `back`, или
        // просто чужой `router.back()`, -- отклоняется и уходит событием.
        //
        // Вперёд сторож пропускает, и это не недосмотр: развернуть такой
        // переход не во что. Кадра, которого в стеке нет, рантайм не знает, а
        // адрес маршрутизатора -- проекция кадра (`route.js`), не наоборот.
        // Своё же движение вперёд помечено `syncing`.
        //
        // Кнопки браузера здесь нет и не будет: `browserHistory: false`
        // (`main.jsx:90`), `popstate` до маршрутизатора не доходит вовсе. Её
        // дверь -- `web/src/address.js`, и входит она тем же порядком, событием
        // `goto` в рантайм; почему история не отдана Framework7, сказано там же
        // в шапке. Второго описания одного правила тут нет -- есть два входа,
        // и оба ведут в рантайм.
        //
        // `router.allowPageChange` возвращается руками, и это не перестраховка:
        // на «назад» отказ сторожа приходит в пустой обработчик
        // (`back.js:519,525`), а флаг перед опросом сторожей снят
        // (`process-route-queue.js:54`) -- вернуть его больше некому, и роутер
        // запирается навсегда. У `navigate` (`navigate.js:615`) и у второй
        // ветки `back` (`back.js:625`) отказ флаг возвращает, у этой -- нет.
        routesBeforeLeave={[
          ({ router, resolve, reject, direction }) => {
            if (syncing.current || direction !== "backward") {
              resolve();
              return;
            }
            reject();
            router.allowPageChange = true;
            dispatch({ type: "back" });
          },
        ]}
        className={multi ? undefined : "safe-areas"}
        // `masterDetailBreakpoint: 0` -- то, чем вид отказывается от разделения
        // (`splits`, выше): границы, которую окно не перешагнёт, у него всё
        // равно что нет.
        masterDetailBreakpoint={splits(screen) ? WIDE_BREAKPOINT : 0}
        onViewInit={(v) => {
          frames.current.set(screen.key, { el: v.el, router: v.router, depth: 1 });
          // Жест «назад» -- единственное исключение из «рантайм первый», и
          // исключение неустранимое: `swipe-back.js` не спрашивает маршрутных
          // сторожей ни разу, он проводит весь переход сам и сообщает о нём
          // после (`swipe-back.js:240-246`). Значит для него порядок обратный,
          // и флаг `syncing` живёт ровно ради него.
          v.router.on("routeChanged", () => {
            if (syncing.current || activeRef.current !== screen.key) return;
            if (v.router.history.length < frames.current.get(screen.key).depth) {
              dispatch({ type: "back" });
            }
          });
        }}
      />
    </ScreenContext.Provider>
  );

  return (
    <App {...f7params} routes={ROUTES}>
      <AppContext.Provider value={app}>
        {multi && (
          <ScreensPanel
            screens={screens} active={active} title={title}
            onPick={(key) => dispatch({ type: "switch_screen", key })}
          />
        )}
        {screens && (multi ? (
          <Views tabs className="safe-areas">
            <Toolbar tabbar icons bottom ref={tabbarRef}>
              {screens.map((s) => (
                <Link key={s.key} tabLink={`#${viewId(s)}`} tabLinkActive={s.key === active}>
                  <Glyph name={s.icon || "circle"} size={24} />
                  <span className="tabbar-label">{s.label || s.key}</span>
                </Link>
              ))}
            </Toolbar>
            {screens.map(view)}
          </Views>
        ) : view(screens[0], 0))}
        {/*
          Модальная карточка Framework7 -- это всё поведение целиком: она
          поднимается над страницей, гасит то, что за ней, встаёт над
          клавиатурой и закрывается движением вниз или касанием мимо. Высота у
          неё по умолчанию 260px, что верно для им же сделанного выбиральщика и
          неверно для формы: строки ниже сгиба были бы просто недостижимы. Его
          же переменная отдаёт это решение содержимому.
        */}
        <Sheet
          className="pa-sheet"
          style={{ "--f7-sheet-height": "auto" }}
          opened={!!sheet}
          backdrop closeByBackdropClick swipeToClose push={false}
          onSheetClosed={() => {
            // Закрытие -- ещё и собственный жест пользователя, поэтому наше
            // собственное закрытие не должно быть принято за него и снято со
            // стека вторично: к этому мигу экрана в состоянии уже нет.
            if (sheet) dispatch({ type: "back" });
          }}
        >
          <SheetScreen screen={sheet} />
        </Sheet>
      </AppContext.Provider>
    </App>
  );
}

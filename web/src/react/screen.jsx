/**
 * Экран: страница, её бар, её плавающее действие и её тело.
 *
 * До переезда всё это собиралось руками -- `.navbar-inner` принадлежит
 * Framework7, и дерево приложения до него не доставало, поэтому каждый слот
 * бара был отдельным компонентом, вставленным в чужую разметку, признак обмена
 * -- отдельным элементом рядом с ним, а плавающая кнопка -- элементом, который
 * искали в странице и по месту меняли. В React бар и кнопка просто часть
 * страницы: три метода синхронизации исчезли как задача, а не переехали.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Breadcrumbs, BreadcrumbsItem, BreadcrumbsSeparator,
  Fab, Navbar, NavLeft, NavRight, NavTitle, Page, PageContent, Subnavbar,
} from "framework7-react";

import { BarNodes, ScreenNodes } from "./nodes.jsx";
import { fabButton, findList, isRecordScreen, navbarCtx, pageCtx } from "./ctx.js";
import { Glyph } from "./glyph.jsx";
import { useWide } from "./layout.js";
import { frameOf } from "./route.js";
import { useApp, useScreenKey } from "./context.js";
import { useStore } from "./store.js";

/**
 * Как выглядит каждое состояние обмена. Глифы -- из Material Icons, той же
 * лигатурой, что и любая иконка приложения: своего набора здесь нет.
 */
const SYNC_LOOK = {
  off: { glyph: "cloud_off", hint: "Обмен не настроен" },
  idle: { glyph: "cloud_done", hint: "Всё отправлено" },
  syncing: { glyph: "sync", hint: "Идёт обмен" },
  offline: { glyph: "cloud_off", hint: "Нет сети" },
  error: { glyph: "sync_problem", hint: "Обмен не удался" },
};

/**
 * Что показывает бар над страницей, которая сама себе поверхность.
 *
 * У материального верхнего бара своей коробки в покое нет: поверхность страницы
 * уходит под него, и приподнятый тон он берёт только когда под ним что-то
 * прокрутили. Отдельной остаётся вставка строки состояния над баром -- она
 * держит тон баров. И то, и другое -- одно значение переменной, которой
 * Framework7 заливает бар, со сменой тона на той единственной величине, что
 * говорит, где вставка кончается.
 */
const PAGE_SURFACE_BAR =
  "linear-gradient(var(--f7-bars-bg-color) var(--f7-safe-area-top),"
  + "var(--f7-list-strong-bg-color) var(--f7-safe-area-top))";

/**
 * Своя ли у экрана поверхность?
 *
 * `Group(surface="sheet")` говорит, что секция не лежит на странице, а *и есть*
 * она. К экрану, приехавшему карточкой, вопрос не относится: там поверхность
 * уже своя.
 */
const isPageSurface = (screen) =>
  screen.target !== "sheet"
  && (screen.children || []).some((c) => c.type === "group" && c.surface === "sheet");

/** Сколько ждать, прежде чем спросить следующую страницу ещё раз. */
const INFINITE_COOLDOWN_MS = 300;

/**
 * Признак состояния обмена -- один значок в правом углу бара.
 *
 * Значок один, а сказать надо три вещи: идёт ли обмен, есть ли неотправленное и
 * когда был последний. Первое и второе читаются с самого значка (глиф и
 * счётчик на нём), третье -- в карточке, которая открывается по нажатию:
 * «когда был последний» это вопрос, который задают, а не держат перед глазами.
 */
function SyncChip() {
  const { store, onSyncTap } = useApp();
  const { sync } = useStore(store);
  if (!sync) return null;

  let { glyph, hint } = SYNC_LOOK[sync.phase] || SYNC_LOOK.idle;
  const count = Number(sync.pending || 0);
  // «Всё отправлено» и «отправить есть что» -- разные вещи, и разница видна
  // без счёта: стрелка вверх против галочки.
  if (sync.phase === "idle" && count) {
    glyph = "cloud_upload";
    hint = "Есть неотправленное";
  }
  return (
    <a
      className="link icon-only pa-syncchip" href="#" title={hint} aria-label={hint}
      data-phase={sync.phase || "idle"} data-pending={String(count)}
      onClick={(e) => { e.preventDefault(); onSyncTap?.(); }}
    >
      <Glyph name={glyph} size={22}>
        {count > 0 && sync.phase !== "syncing"
          && <span className="badge color-orange">{count > 99 ? "99+" : count}</span>}
      </Glyph>
    </a>
  );
}

/**
 * Назад или закрыть.
 *
 * Экран, правящий черновик, -- не шаг пути, с которого возвращаются: это
 * работа, которую или заканчивают, или бросают. Обе платформы помечают это
 * крестиком, а не стрелкой -- и ссылка та же самая, потому что уход с экрана
 * делает одно и то же.
 *
 * Уходит она в рантайм, а не в маршрутизатор. Раньше нажатие ловил Framework7
 * сам, по классу `back`, -- и в разделённом окне не делало ничего: с карточки
 * на мастера он назад не идёт вовсе. `back.js:490-505` ставит `skipMaster`,
 * когда мастер стоит прямо перед текущей страницей и окно шире границы, а
 * `back.js:548-550` на этом и кончает: `return router`, ни перехода, ни
 * события, ни отказа -- сторож `routesBeforeLeave` тоже не спрашивается.
 * Класс оставлен: он ничего не красит, но по нему ссылку находят проверки.
 * `prevent-router` -- собственная дверь Framework7 для «нажатие моё,
 * маршрутизатор не трогай» (`modules/clicks/clicks.js:53`).
 */
function BackLink({ screen }) {
  const { dispatch } = useApp();
  const close = screen.dismiss === "close" || (screen.dismiss !== "back" && !!screen.draft);
  return (
    <a
      className="link back prevent-router icon-only" data-close={String(close)}
      onClick={(e) => { e.preventDefault(); dispatch({ type: "back" }); }}
    >
      {close ? <Glyph name="close" size={24} /> : <i className="icon icon-back" />}
    </a>
  );
}

/**
 * Хлебные крошки -- проекция стека, и ничего кроме.
 *
 * Framework7 даёт разметку и обёртки (`Breadcrumbs`, `BreadcrumbsItem`,
 * `BreadcrumbsSeparator`), но ни строчки поведения: `components/breadcrumbs/`
 * -- восемь строк регистрации пустого объекта, с маршрутизатором крошки не
 * связаны никак, содержимое пишет тот, кто их ставит. Написать надо ровно одно
 * -- откуда берётся цепочка, -- и ответ у нас уже есть: это стек. Так же
 * устроено у Odoo (`action_service.js:480-490`, `_getBreadcrumbs` разбирает
 * `controllerStack`); догружать имена, как там, не приходится -- все кадры живы
 * в памяти, и имя каждого приехало в снимке (`frame.name`).
 *
 * Объявлением крошки не включаются и не выключаются, и это не упущение, а суть:
 * они не украшение раздела, а его вложенность, сказанная вслух. Пока стек
 * глубиной в один кадр, показывать нечего; как только он глубже, цепочка
 * *существует* независимо от того, спросили о ней или нет. Признака в DSL для
 * этого не может быть по той же причине, по какой его нет у стрелки «назад».
 *
 * Последнее звено -- то, где человек стоит: у него нет ссылки, есть класс
 * `breadcrumbs-item-active`. Нажимать на «здесь» некуда, и Framework7 это уже
 * знает -- красит его иначе.
 */
function ScreenCrumbs({ trail }) {
  const { dispatch } = useApp();
  return (
    <Subnavbar className="pa-crumbs">
      <Breadcrumbs>
        {trail.map((frame, at) => {
          const here = at === trail.length - 1;
          return (
            <React.Fragment key={frame.id}>
              {at > 0 && <BreadcrumbsSeparator />}
              <BreadcrumbsItem active={here} data-index={at}>
                {/* `name`, а не `title`: пустой заголовок -- это отказ бара
                    (запись и есть страница), а не отказ кадра от имени, и
                    звено без слова было бы дырой в цепочке. */}
                {here ? frame.name : (
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      dispatch({ type: "back_to", screen_id: frame.id });
                    }}
                  >
                    {frame.name}
                  </a>
                )}
              </BreadcrumbsItem>
            </React.Fragment>
          );
        })}
      </Breadcrumbs>
    </Subnavbar>
  );
}

/**
 * Плавающее действие экрана.
 *
 * С подписью это расширенная кнопка Framework7 -- то единственное, ради чего
 * экран существует, сказанное словом. Без подписи -- круглая. Никогда обе
 * сразу, поэтому лишняя не прячется, а просто не рисуется.
 */
function ScreenFab({ button, dispatch }) {
  const run = (event) => {
    event.preventDefault();
    dispatch({ type: "action", button_id: button.id, context: button.context });
  };
  if (button.label) {
    return (
      <Fab
        extended
        className="pa-pinned"
        color={button.style === "destructive" ? "red" : undefined}
        text={button.label}
        href="#"
        // `width:auto`, потому что страница -- колонка flex и растянула бы её:
        // пилюля шириной со свою подпись.
        style={{ width: "auto", alignSelf: "flex-end" }}
        data-button-id={button.id}
        onClick={run}
      />
    );
  }
  // Своя плавающая кнопка Framework7: размер, скругление 16dp, цвета
  // primary-container, тень, размещение с оглядкой на безопасную область и
  // отклик на нажатие -- всё её.
  return (
    <Fab className="pa-fab" href="#" aria-label="create" onClick={run}>
      <Glyph name={button.icon || "add"} size={26} />
    </Fab>
  );
}

/**
 * Тело экрана -- одно и то же и на странице, и в карточке.
 *
 * Здесь решается, чем `.page-content` является: обычным прокручиваемым телом,
 * телом карточки высотой по содержимому или полосой вкладок, забравшей
 * страницу себе.
 */
function ScreenBody({ screen, ctx, contentRef, infinite, onInfinite }) {
  useTooltips(contentRef, ctx.f7);
  const kids = screen.children || [];
  // Листаемые вкладки Framework7 *и есть* страница: её панель размещена
  // отдельным слоем, её `swiper-container.tabs` во всю высоту, и у каждой
  // страницы внутри свой `.page-content`. Поэтому экран, который весь -- одни
  // вкладки, отдаёт им страницу вместо того, чтобы прокручиваться целиком.
  //
  // `page="auto"` -- та же форма, что была всегда: вкладки, которыми экран
  // исчерпывается, забирают его себе, вкладки внутри формы остаются в потоке.
  // Приложение, которое имеет в виду одно или другое, говорит это и слушается.
  const tabsNode = kids.length === 1 && kids[0].type === "tabs" ? kids[0] : null;
  const ownsPage = !screen.error && !!tabsNode
    && (tabsNode.page === true || (tabsNode.page !== false && !isRecordScreen(screen)));
  // Карточка высотой со своё содержимое, а не с несуществующую страницу.
  const onSheet = screen.target === "sheet";
  // `Group(surface="sheet")` говорит, что секция *и есть* поверхность страницы,
  // а поверхность, кончающаяся под последней строкой, -- всё ещё карточка:
  // значит заливку, которую отдала группа, берёт тело. Названа, а не выбрана:
  // `--f7-list-strong-bg-color` -- то, чем заливается секция, и разойтись эти
  // двое не могут. Не в экране, приехавшем карточкой: там поверхность уже есть,
  // и вторая заливка поверх неё только погасила бы её тон.
  const asPage = !onSheet && kids.some((c) => c.type === "group" && c.surface === "sheet");

  ctx.pageTabs = ownsPage;
  ctx.onSheet = onSheet;

  return (
    <PageContent
      className={`pa-body${ownsPage ? " pa-tabs-page" : ""}`}
      // Названо, а не опущено: один и тот же элемент служит обеим веткам, и
      // значение, оставшееся от другой, останавливает прокрутку страницы.
      style={ownsPage
        ? { overflow: "hidden" }
        : {
            overflow: "auto",
            ...(onSheet ? { height: "auto" } : null),
            ...(asPage ? { background: "var(--f7-list-strong-bg-color)" } : null),
          }}
      ref={contentRef}
      // Подкачка страниц -- вопрос запроса, поэтому событие уходит в рантайм
      // как есть. Свой ползунок ожидания, а не тот, что рисует Framework7:
      // разметка у них разная, а место одно.
      infinite={!!infinite}
      infinitePreloader={false}
      onInfinite={onInfinite}
    >
      <ScreenNodes screen={screen} ctx={ctx} />
      {infinite?.hasMore
        && <div className="infinite-scroll-preloader"><div className="preloader" /></div>}
    </PageContent>
  );
}

/**
 * Обстановка страницы и обстановка её бара -- пересобираются на каждый кадр.
 *
 * Дёшево (два объекта из замыканий) и честно: обстановка держит сам экран, и
 * запомнить её означало бы рисовать следующий кадр с прошлыми узлами.
 */
function useScreenCtx(screen, contentRef) {
  const { f7, dispatch, store } = useApp();
  const el = () => contentRef.current?.el ?? null;
  const page = pageCtx({
    f7, dispatch, store,
    screen: screen || { children: [] },
    measure: el,
    bodyWidth: () => el()?.clientWidth ?? 0,
  });
  return { page, navbar: navbarCtx({ f7, dispatch, store }) };
}

/**
 * Подсказки `help=` -- проходом по телу, а не узлом дерева.
 *
 * Подсказка Framework7 не рисует ничего своего: она привязывается к чужой цели
 * и живёт рядом с ней. Узла для неё в дереве нет, и родитель не знает, какой
 * элемент DOM принадлежит какому полю, -- поэтому истолкователь помечает цель
 * классом и атрибутом, а заводит подсказки тот, кто владеет телом. Убираются
 * они вместе с ним: живая подсказка держит слушателей на цели, которой к тому
 * времени уже нет в документе.
 */
function useTooltips(contentRef, f7) {
  //: Цель -> подсказка. Ключ -- элемент, потому что уходит именно он: экран
  //: снимается кадром, а страницу маршрутизатор убирает после, и к тому мигу
  //: поля на ней уже нет.
  const live = useRef(new Map());
  useEffect(() => {
    const root = contentRef.current?.el;
    if (!root) return;
    // Ушедшие -- первыми. Framework7 заводит подсказки и сам, на `pageInit`, и
    // сам же убирает их на `pageBeforeRemove` -- но ищет он их *в странице*, а
    // страница к тому времени пуста: кадр без экрана приходит раньше, чем
    // маршрутизатор доигрывает переход, и React успевает снять поле. Поэтому
    // заведённое Framework7 берётся под тот же учёт: чья бы подсказка ни была,
    // уходит она вместе со своей целью.
    for (const [el, tip] of live.current) {
      if (el.isConnected) continue;
      tip.destroy();
      live.current.delete(el);
    }
    for (const el of root.querySelectorAll(".tooltip-init[data-tooltip]")) {
      if (el.f7Tooltip) {
        el.f7Tooltip.setText(el.dataset.tooltip);
        live.current.set(el, el.f7Tooltip);
      } else {
        live.current.set(el, f7.tooltip.create({ targetEl: el, text: el.dataset.tooltip }));
      }
    }
  });
  useEffect(() => {
    const created = live.current;
    return () => {
      for (const tip of created.values()) tip.destroy();
      created.clear();
    };
  }, []);
}

/**
 * Окно длинного списка зависит от того, докуда долистали, -- значит листание
 * тоже перерисовывает тело.
 *
 * Слушается на странице и на перехвате: `scroll` не всплывает, а с листаемыми
 * вкладками прокручиваемых элементов несколько, по одному на страницу.
 */
function useScrollTick(pageRef) {
  const [, tick] = useState(0);
  useEffect(() => {
    const page = pageRef.current?.el;
    if (!page) return undefined;
    let queued = false;
    const listener = (event) => {
      // Полоса вкладок листается сама по себе, и перерисовывать ради неё
      // значило бы бороться с пальцем.
      if (event.target.closest?.(".pa-tabs__bar")) return;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        tick((n) => n + 1);
      });
    };
    page.addEventListener("scroll", listener, { capture: true, passive: true });
    return () => page.removeEventListener("scroll", listener, { capture: true });
  }, [pageRef]);
}

/** Событие подкачки, с двумя условиями: есть что качать и прошлое доехало. */
function useInfinite(listId, hasMore, dispatch) {
  const busy = useRef(false);
  return () => {
    if (!hasMore || busy.current) return;
    busy.current = true;
    dispatch({ type: "load_more", list_id: listId });
    setTimeout(() => { busy.current = false; }, INFINITE_COOLDOWN_MS);
  };
}

/**
 * Одна страница стека.
 *
 * Приезжает параметром маршрута: страницу создаёт маршрутизатор Framework7,
 * рисует её React. Какой это раздел -- из контекста (родителя у страницы в её
 * собственном коде нет), какой кадр -- из адреса, по ключу самого кадра.
 *
 * По ключу, а не по счёту, потому что счёт врёт дважды: два кадра одной глубины
 * неразличимы для маршрутизатора (а он молча отменяет переход на тот же адрес),
 * и снятый кадр под этим номером мгновенно становится следующим -- страница,
 * которую ещё анимируют, показала бы чужое содержимое.
 */
export function ScreenPage({ f7route }) {
  const app = useApp();
  const key = useScreenKey();
  const state = useStore(app.store);
  const stack = state.snapshot?.stacks?.[key] || [];
  //: Корень раздела -- отдельный маршрут, и кадра в адресе у него нет: он
  //: единственный, кто стоит в стеке всегда и на одном месте.
  const frameId = frameOf(f7route?.url);
  let index = frameId ? stack.findIndex((f) => f.id === frameId) : 0;
  let screen = index < 0 ? undefined : stack[index];
  //: Кадра в снимке уже нет, а страница ещё на экране: рантайм снял его, а
  //: маршрутизатор только начинает возврат. Показывается снятое дерево -- иначе
  //: возврат анимировался бы пустой страницей.
  if (!screen && frameId) {
    const gone = app.store.outgoing.get(frameId);
    if (gone) ({ tree: screen, index } = gone);
  }
  if (index < 0) index = stack.length;
  const contentRef = useRef(null);
  const navbarRef = useRef(null);
  const pageRef = useRef(null);
  const ctx = useScreenCtx(screen, contentRef);
  useScrollTick(pageRef);
  //: Крошки -- подача широкого окна: на телефоне их не показывает никто из
  //: платформ, там цепочку заменяет стрелка «назад», и ярус в 64 пикселя
  //: (замерено на живом экране) съел бы содержимое ради того, что и так стоит
  //: слева в баре. Экран вправе сказать иначе -- `crumbs` в объявлении.
  const wide = useWide();
  const tabOf = (id) => state.tabs[id];
  const list = screen ? findList(screen.children, tabOf) : null;
  const onInfinite = useInfinite(list?.id, !!list?.has_more, app.dispatch);

  // Заголовок по центру меряется относительно ссылок по бокам, и мерить его
  // должен тот кадр, который эти ссылки поставил: до переезда это делалось
  // после каждой заплатки, здесь -- после каждой отрисовки.
  useLayoutEffect(() => {
    if (navbarRef.current?.el) app.f7.navbar.size(navbarRef.current.el);
  });

  // Страница ещё в документе, а рантайм её уже снял: маршрутизатор уберёт её
  // следующим шагом, и до тех пор рисовать нечего.
  if (!screen) return <Page className="pa-page" pageContent={false} data-index={index} ref={pageRef} />;

  const lifted = screen.navbar_buttons || [];
  // Плавающее действие едет тем же списком, но принадлежит углу, а не бару.
  const side = (name) => lifted.filter(
    (b) => b.place !== "fab" && (b.place === "navbar-left") === (name === "left"),
  );
  const fab = fabButton(screen, tabOf);
  // Цепочка кончается на самой странице, а не на вершине стека: страница,
  // которую маршрутизатор ещё доигрывает, кадром в стеке уже не стоит
  // (`store.outgoing`), и `stack.slice(0, index + 1)` укоротил бы ей крошки
  // прямо посреди возврата. Для живой страницы это ровно тот же срез: она и
  // есть `stack[index]`.
  //
  // Слово экрана сильнее правила, но только там, где есть о чём говорить: ниже
  // двух кадров цепочки не существует вовсе, и `crumbs: true` её не выдумает.
  // Отвечает за это тот кадр, чьи крошки рисуются, -- сама страница, а не
  // корень раздела: крошки принадлежат месту, где стоит человек.
  const says = screen?.crumbs;
  const chain = index > 0 && (says === true || (says !== false && wide));
  const trail = chain ? [...stack.slice(0, index), screen] : null;

  return (
    <Page
      // Класс страницы с подстрокой бара Framework7 ставит сам, но один раз --
      // на `pageInit` (`components/subnavbar/subnavbar.js:7`). Крошки же
      // появляются и от того, что окно растянули, и тогда ставить его было бы
      // уже некому: отступ сверху не вырос бы, и первая строка ушла бы под
      // крошки. Свой класс тому же элементу -- то же самое значение, только
      // сказанное на каждой отрисовке.
      className={`pa-page${trail ? " page-with-subnavbar" : ""}`}
      pageContent={false}
      ref={pageRef}
      // Какая страница стека -- видно с самой страницы: до переезда номер
      // ставил образец разметки, из которого маршрутизатор её собирал.
      data-index={index}
      // Ставится на страницу, под которой висит бар: экран, который сам себе
      // поверхность, проносит её через бар, а всякому другому достаётся
      // собственная заливка Framework7.
      style={isPageSurface(screen) ? { "--f7-navbar-bg-color": PAGE_SURFACE_BAR } : undefined}
    >
      <Navbar
        ref={navbarRef}
        // Заголовок по центру -- только у корня раздела: в странице, в которую
        // вошли, слева стоит стрелка назад.
        innerClass={index > 0 ? undefined : "navbar-inner-centered-title"}
      >
        {/* Слота нет, когда класть в него нечего. Пустой он не безобиден:
            тема iOS красит группы бара стеклом -- `.ios .navbar .left`
            получает `backdrop-filter: blur(16px)` и белый фон, -- и пустой
            слот висел в баре белым кружком 44x44. Под `md` стекла нет, и
            это не было видно, пока Safari не начал получать тему iOS. */}
        {(index > 0 || side("left").length > 0) && (
          <NavLeft>
            {index > 0 && <BackLink screen={screen} />}
            <BarNodes nodes={side("left")} ctx={ctx.navbar} />
          </NavLeft>
        )}
        <NavTitle>{screen.title || ""}</NavTitle>
        <NavRight>
          {/* Первым в слоте: кнопки экрана остаются у самого края, где их и
              ищут. */}
          <SyncChip />
          <BarNodes nodes={side("right")} ctx={ctx.navbar} />
        </NavRight>
        {/* `after-inner` -- слот Framework7 *после* `.navbar-inner`
            (`f7r/components/navbar.js:180`), и стоит он на прямом ребёнке
            навбара, потому что слоты разбираются по детям (`getSlots`).
            Обычным ребёнком крошки попали бы внутрь строки бара, к заголовку и
            кнопкам, а подстрока бара -- отдельный ярус под ним:
            `.navbar .subnavbar { top: 100% }`. */}
        {trail && <ScreenCrumbs slot="after-inner" trail={trail} />}
      </Navbar>
      <ScreenBody
        screen={screen}
        ctx={ctx.page}
        contentRef={contentRef}
        infinite={list ? { hasMore: !!list.has_more } : null}
        onInfinite={onInfinite}
      />
      {fab && <ScreenFab button={fab} dispatch={app.dispatch} />}
    </Page>
  );
}

/**
 * Экран, приехавший карточкой.
 *
 * Карточка поднимается *над* стеком, а не встаёт в него: страница под ней
 * остаётся где была, и маршрутизатор о карточке не знает вовсе. Внутри --
 * обычный экран, нарисованный тем же кодом, что рисует страницу, поэтому
 * всякий виджет, список и черновик работают в ней, не зная, где находятся.
 */
export function SheetScreen({ screen }) {
  const contentRef = useRef(null);
  const ctx = useScreenCtx(screen, contentRef);
  if (!screen) return null;
  return (
    // Framework7 размещает `.page` абсолютно, во весь вид, которому она
    // принадлежит; здесь она принадлежит карточке высотой со своё содержимое.
    // Оба отступа -- его собственные переменные, обнулены потому, что у
    // карточки нет баров, из-под которых странице надо начинаться.
    //
    // `.page` красится цветом страницы, и здесь она лежит поверх карточки --
    // значит собственный тон карточки не был бы виден никогда. Одна переменная
    // Framework7, указывающая на другую, оставляет решение о виде карточки
    // самой карточке.
    <div
      className="page"
      style={{
        position: "relative",
        height: "auto",
        "--f7-page-navbar-offset": "0px",
        "--f7-page-toolbar-top-offset": "0px",
        "--f7-page-bg-color": "var(--f7-sheet-bg-color)",
        // Поля на карточке лежат на самой карточке: ни подложки под ними, ни
        // черты под ними -- поверхность уже есть, и высотой она в несколько
        // строк. Переменные Framework7, поэтому больше на экране ничего не
        // затронуто.
        "--f7-list-strong-bg-color": "transparent",
        "--f7-block-strong-bg-color": "transparent",
        "--f7-list-item-border-color": "transparent",
        "--f7-input-item-bg-color": "transparent",
        "--f7-input-outline-border-color": "transparent",
      }}
    >
      <ScreenBody screen={screen} ctx={ctx.page} contentRef={contentRef} infinite={null} />
    </div>
  );
}

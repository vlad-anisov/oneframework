/**
 * Разборщик типов узлов: документ вида -> дерево React.
 *
 * Здесь ничего не знают ни про модель, ни про имя поля: каждое решение
 * выводится из типа узла и сведений о поле. Виджеты живут рядом, в
 * `widgets.jsx`, и вызываются одной строчкой -- разбор типов и таблица отрисовок
 * это два разных вопроса.
 *
 * Одно место, где React заставил переставить вопрос, а не переписать ответ:
 * классы, которые *строка* ставит своим ячейкам (`item-after`,
 * `margin-left-half`, отступ между двумя иконками). Раньше строка дописывала их
 * прямо в свойства уже построенного узла ребёнка -- со snabbdom это законно.
 * React не даёт родителю ни дописать класс на корень ребёнка, ни узнать этот
 * корень: между ними стоит компонент. Поэтому строка ставит их на свои
 * собственные элементы DOM, после отрисовки, и заодно продолжает читать «это
 * ячейка в один глиф?» с разметки -- как и раньше, а не с типа узла: кнопка с
 * иконкой и флажок, нарисованный иконкой, приходят сюда разными узлами и
 * уходят одним и тем же органом управления.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AccordionContent, BlockTitle, List, ListIndex, ListItem, Searchbar, Tab, Tabs, Toolbar,
} from "framework7-react";

import { bindRow } from "./bindrow.js";
export { bindRow };
import { Glyph } from "./glyph.jsx";
import {
  assertEveryTypeIsDrawn, ErrorBox, node, registerNode, РИСУЕТ_РОДИТЕЛЬ,
} from "./render.jsx";
import { ImperativeWidget, imperativeWidget, reactWidget } from "./widgets.jsx";
import { t } from "../i18n.js";

/** Ключ узла содержит точки, а в селекторе по id они недопустимы. */
const cssId = (id) => String(id).replace(/[^\w-]/g, "_");

/**
 * Типы узлов, которые рисует этот истолкователь -- его половина договора из
 * `protocol/wire.json`, которую `tests/js/wire.test.mjs` держит по схеме.
 */
/* -------------------------------------------------------------------- field */

function field(n, ctx) {
  // Объявлено, но для этой записи не рисуется. `display-none` у Framework7 --
  // `!important`, поэтому он побеждает орган управления с собственным `display`
  // (`.chip`, например, атрибутом `hidden` не спрятать). Проверяется до выбора
  // виджета, так что поле ничего не монтирует и ничего не стоит.
  if (!n.visible) return <span className="display-none" />;

  const widget = reactWidget(n);
  if (widget) return withHelp(n, widget(n, ctx));

  const impl = imperativeWidget(n);
  // Орган управления, который Framework7 строит только против настоящего
  // элемента -- и та же дверь, в которую входит собственный виджет модуля.
  if (impl) return withHelp(n, <ImperativeWidget node={n} ctx={ctx} impl={impl} />);

  return <div className="pa-readonly">{String(n.value ?? "")}</div>;
}

/**
 * `help="..."` из DSL становится подсказкой Framework7 на органе управления.
 *
 * Класс и атрибут дописываются на корень того, что вернул виджет -- ровно то
 * же, что делалось со свойствами узла snabbdom, и с той же оговоркой: если
 * корень не элемент DOM, а составляющая, дописывать некуда, и подсказки не
 * будет. Заводит же её проход по телу экрана: живая подсказка Framework7
 * привязана к цели, а не к элементу, и уборка ей нужна отдельная.
 */
function withHelp(n, el) {
  const text = n.options?.help;
  if (!text || !el) return el;
  // Класс дописывается, а не заменяется: `cloneElement` свойства перекрывает.
  // У составляющей собственного `className` в свойствах нет -- она подмешивает
  // пришедший к своему уже внутри себя, по договору из `widgets.jsx`.
  return React.cloneElement(el, {
    className: [el.props.className, "tooltip-init"].filter(Boolean).join(" "),
    "data-tooltip": text,
  });
}

/* ---------------------------------------------------------------------- row */

/** Ячейка в один глиф -- вопрос к разметке, а не к типу узла. */
const isGlyph = (el) => el.classList.contains("icon-only");

function RowNode({ n, ctx }) {
  const cols = n.children.filter((c) => c.type === "col").length;
  const grid = cols > 0 && cols === n.children.length;
  // Строка формы -- это линия органов управления на странице, а не ячейка
  // таблицы: она берёт тот же горизонтальный отступ, что и всякая другая строка
  // экрана, либо стоит вплотную к краю. Собственный отступ блока Framework7 --
  // это 16dp экранного поля из Material 2, а строки рядом стоят на 24 из
  // Material 3, -- поэтому блок берёт ту величину, которую строки уже несут, а
  // не вторую собственную. Карточка создания у Google ставит свою линию иконок
  // ровно на левый край полей над ней.
  const inset = ctx.screenMode === "form" && !grid;
  const ref = useRef(null);

  // Отступы ячеек ставятся на элементы, а не на узлы: см. заголовок файла.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || grid) return;
    let previousWasGlyph = false;
    [...el.children].forEach((cell, i) => {
      const child = n.children[i];
      cell.style.marginLeft = "";
      // `place="after"` в обычной строке значит то же, что и в строке списка:
      // прижато к концу. Утилиты автоматических полей у Framework7 нет, поэтому
      // это сказано -- одно объявление на одну попросившую ячейку.
      if (child?.place === "after") cell.style.marginLeft = "auto";
      // Две иконочные кнопки рядом стоят в 24dp друг от друга в собственной
      // материальной теме Framework7 -- так глиф в 24dp попадает на сетку в
      // 48dp, которую материал даёт иконочной кнопке, и это же меряет линия
      // таких кнопок у Google. Framework7 называет эту величину только внутри
      // таблицы данных, куда его селектор до строки на странице не достаёт.
      const glyph = isGlyph(cell);
      if (glyph && previousWasGlyph && child?.place !== "after") {
        cell.style.marginLeft = "24px";
      }
      previousWasGlyph = glyph;
    });
  });

  return (
    <div
      ref={ref}
      className={grid
        ? `grid grid-cols-1 medium-grid-cols-${cols} grid-gap pa-row pa-row--grid`
        : "pa-row display-flex align-items-center" + (inset ? " block" : "")}
      style={inset
        ? { "--f7-block-padding-horizontal": "var(--f7-list-item-padding-horizontal)" }
        : undefined}
    >
      {n.children.map((c) => node(c, grid ? ctx : { ...ctx, mode: "row" }))}
    </div>
  );
}

/* -------------------------------------------------------------------- group */

function GroupNode({ n, ctx }) {
  // Одна карточка, а не по карточке на поле. Группа -- секция формы, и обе
  // платформы рисуют секцию одной поверхностью со строками внутри неё; ровно
  // это же значит `<group>` в Odoo. Полям это сказано, и каждое даёт строку, а
  // не собственную карточку.
  const inner = { ...ctx, inGroup: (n.cols || 1) === 1 };
  const kids = n.children.map((c) => node(c, inner));
  // `surface="sheet"`: секция не лежит на странице, она *и есть* её
  // поверхность -- поэтому не берёт ни одного из двух классов, делающих из неё
  // карточку. `inset` -- это поля по бокам и скругление; `list-strong` --
  // заливка, а секция, которая и есть страница, заливать не должна, иначе
  // проводит по тому, на чём стоит, полосу карточного тона. Заливку даёт то, на
  // чём она стоит: страница под ней, которая берёт
  // `--f7-list-strong-bg-color` там, где начинается эта отрисовка, или
  // карточка-модалка, которая и так поверхность.
  const sheet = n.surface === "sheet";
  // Где начинается строка, меряют от экрана, а не от секции: карточка держит
  // свои строки в 24dp от собственного края и стоит в 8dp от экрана, значит
  // строка начинается в 32dp. У секции, которая *и есть* страница, своего края
  // нет, и её строки берут отступ, который даёт им экран, -- 20dp на экране
  // записи у Google против 24 + 8 у списка, из которого её открыли.
  // Карточка-модалка -- не этот случай: край она принесла свой, и её строки
  // держат строчный отступ, куда их и ставит карточка создания у Google.
  const pageSurface = sheet && !ctx.onSheet;
  return (
    <div>
      {n.label && <BlockTitle>{n.label}</BlockTitle>}
      {inner.inGroup ? (
        <div
          className={`list pa-group${sheet ? "" : " list-strong inset"}`}
          style={pageSurface ? { "--f7-list-item-padding-horizontal": "20px" } : undefined}
        >
          <ul>{kids}</ul>
        </div>
      ) : (
        <div className={`grid grid-cols-1 medium-grid-cols-${n.cols}`}>{kids}</div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- tabs */

/**
 * Одна часть заголовка вкладки.
 *
 * Полоса рисует то, что вкладке дали, и ничего сверх. Единственное, что она
 * знает, а приложение не может, -- какая вкладка открыта, и это единственное,
 * что она решает: `Pill(when="closed")` уступает на открытой вкладке, потому
 * что страница под ней и так говорит, сколько там. Нужно ли это счётчику --
 * решает приложение, там, где вкладка написана.
 */
/**
 * Значок в углу опоры -- так, как это описано обоими гайдлайнами.
 *
 * Material (`BadgeDrawable`): по умолчанию `TOP_END` -- «badge aligns with the
 * top and end edges of the anchor (with some offsets)», и прямо про
 * `TabLayout`. Числа взяты из исходника его же составляющей: значок с текстом
 * смещён на 12dp по горизонтали от верхнего-конечного угла опоры и на 14dp по
 * вертикали.
 *
 * Apple говорит о значке на элементе панели вкладок -- красный овал с белым
 * текстом, и только для того, что требует внимания. Это про нижнюю панель, а
 * не про листающуюся полосу вверху страницы: такой полосы в их гайдлайне нет
 * вовсе. Поэтому цвет остаётся тем, что даёт Framework7, а не выдуман нами.
 *
 * Framework7 своё размещение даёт только значку **внутри иконки**
 * (`.icon .badge`), и на слово оно не переносится: правило считает от
 * `left: 100%` с возвратом, а вкладка у нас ровно по ширине слова -- значок
 * уезжал за её край на 20 пикселей и пропадал из виду (замерено). Поэтому
 * опора получает запас, а значок кладётся от правого края внутрь него.
 */
/**
 * Заголовок вкладки: части по порядку, а значок -- в углу предыдущей.
 *
 * Значок не самостоятельная часть строки: он говорит о том, за чем написан.
 * Поэтому пара «часть + значок» сворачивается в одну опору, и уже она стоит в
 * ряду. Значок без предшествующей части -- вкладка, названная одним счётом, --
 * остаётся сам собой: приколоть его не к чему.
 */
function tabTitle(parts, open) {
  const ряд = [];
  for (const part of parts) {
    const нарисован = titlePart(part, open);
    if (part.type === "pill") {
      if (!нарисован) continue;
      const опора = ряд.pop();
      ряд.push(опора
        ? withBadge(опора, нарисован, `${part.id}-badged`)
        : нарисован);
      continue;
    }
    ряд.push(нарисован);
  }
  return ряд;
}

function withBadge(опора, значок, ключ) {
  if (!значок) return опора;
  return (
    <span
      key={ключ}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      {опора}
      {/* Значок остаётся в потоке, и место под него считает раскладка -- по
          его настоящей ширине. Отведённый запас в одно `--f7-badge-size` этого
          не умел: двузначный счёт шире, и «Переезд 10» наезжал на «д» ровно на
          6 пикселей (замерено), а однозначные стояли к букве впритык, без
          просвета.

          Угол при этом остаётся углом: значок приподнят над строкой, как и
          велит `TOP_END` у Material. Просвет в 4 пикселя -- тот же, что был
          измерен по Google Tasks: у них на этом экране 12 и 14 пикселей при
          своей плотности, то есть 4.2 и 4.9dp. */}
      <span style={{ position: "relative", top: "-6px", marginLeft: "4px", lineHeight: 0 }}>
        {значок}
      </span>
    </span>
  );
}

function titlePart(part, open) {
  if (part.type === "pill") {
    if (part.value == null || (part.when === "closed" && open)) return null;
    // Само тельце значка -- составляющая Framework7 (`badge`). Куда оно
    // ложится, решает `withBadge` ниже: значок принадлежит углу своей опоры,
    // а не потоку строки.
    return <span key={part.id} className="badge">{part.value}</span>;
  }
  // Глиф того же размера, каким нарисована всякая другая иконка экрана, чтобы
  // вкладка, названная картинкой, стояла на той же сетке, что и названная
  // словом.
  if (part.type === "icon") return <Glyph key={part.id} name={part.name} size={24} />;
  return <span key={part.id}>{part.value}</span>;
}

/**
 * Страницы, показываемые по одной. Какая открыта -- состояние оболочки: полоса
 * это один орган управления, и от того, где её оставили, на стороне рантайма
 * ничего не зависит.
 */
function TabsNode({ n, ctx }) {
  // Кнопка среди страниц -- не страница: она едет в конце полосы, где «+
  // создать» и место.
  const pages = n.children.filter((c) => c.type === "tab");
  const extras = n.children.filter((c) => c.type === "button");
  const active = ctx.tabOf(n.id) ?? pages[0]?.id;
  // Framework7 выносит свою полосу из потока, чтобы `swiper-container.tabs`
  // могла быть во всю высоту. Здесь полоса в потоке, поэтому высоту делит
  // колонка: полоса берёт своё, страницы -- остальное.
  //
  // Только когда вкладки *и есть* страница. Внутри формы они орган управления
  // среди прочих: полоса, забравшая себе слой, встала бы над полями под ней, а
  // страницы с собственной высотой сломали бы прокрутку.
  const owns = ctx.pageTabs;
  const barRef = useRef(null);
  const swiperRef = useRef(null);

  // Скользящая подчёркивающая полоса: Framework7 ставит её только тому бару,
  // который считает подшитым под навбар (`.md .toolbar-top .tab-link-highlight`).
  // Наш бар стоит вверху страницы, так что класс подходит -- `top:auto` в
  // разметке лишь снимает отступ, который он иначе добавил бы.
  useLayoutEffect(() => {
    // Составляющая кладёт в ссылку не сам элемент, а `{ el, hide, show }` --
    // так у неё устроен `setRef`. Тот же приём уже в `shell.jsx`.
    const el = barRef.current?.el;
    if (!el) return;
    ctx.f7.toolbar.init(el);
    ctx.f7.toolbar.setHighlight(el);
    // Полоса шире экрана обязана следовать за открытой страницей, иначе
    // вкладка, до которой долистали, остаётся вне поля зрения. Только когда
    // открытая вкладка сменилась: делать это на каждой отрисовке значило бы
    // отменять листание полосы прямо под пальцем.
    const open = el.querySelector(".tab-link-active");
    if (open && el.dataset.followed !== open.textContent) {
      el.dataset.followed = open.textContent;
      // Мгновенно, а не плавно: плавная прокрутка, начатая пока листалка ещё
      // движется, отбрасывается.
      open.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });

  // То, что Framework7 делает в `pageInit` для `swiper-container.tabs`: указать
  // листалке открытую страницу и сделать листание тем, что меняет вкладку.
  useLayoutEffect(() => {
    // `{ el }`, а не сам элемент: `setRef` у обёртки всегда заворачивает.
    const el = swiperRef.current?.el;
    if (!el || !el.swiper) return undefined;
    const slides = [...el.children].filter((c) => c.dataset.paTab);
    const want = Math.max(0, slides.findIndex((c) => c.classList.contains("tab-active")));
    const onSlide = () => {
      const slide = slides[el.swiper.activeIndex];
      if (slide) ctx.setTab(n.id, slide.dataset.paTab);
    };
    el.swiper.on("slideChange", onSlide);
    if (el.swiper.activeIndex !== want) el.swiper.slideTo(want, 0);
    return () => el.swiper?.off("slideChange", onSlide);
  });

  const bar = (
    <Toolbar
      tabbar
      scrollable
      // `toolbar-top` -- то, чем Framework7 узнаёт бар, подшитый под навбар:
      // только такому он рисует скользящее подчёркивание открытой вкладки.
      top={owns}
      className="pa-tabs__bar"
      // `top: auto` снимает отступ, который он иначе добавил бы: наш бар стоит
      // в потоке страницы, а не слоем над ней.
      //
      // Пилюля под значком гасится по той же причине, по какой ставится
      // `toolbar-top`: одним классом `tabbar` Framework7 рисует две разные
      // вещи Material. Правило `.md .tabbar i.icon::before` -- 64x32 со
      // скруглением 32 -- это индикатор *нижней навигации* (в Material 56x32,
      // «50% rounded»), и он приезжает к любому бару со значком, хоть сверху.
      // А у вкладок сверху индикатор по Material -- линия под вкладкой, и её
      // Framework7 рисует тут же. Выходило два указателя на одно состояние,
      // причём пилюля -- только у той вкладки, у которой есть значок.
      // Гасим его же переменной, а не своим правилом: снизу пилюля верна и
      // остаётся.
      style={owns
        ? { top: "auto", "--f7-tabbar-link-active-icon-bg-color": "transparent" }
        : undefined}
      ref={barRef}
    >
      {pages.map((tab) => (
        <a
          key={tab.id} onClick={() => ctx.setTab(n.id, tab.id)}
          className={"tab-link display-flex flex-direction-row align-items-center"
            + (tab.id === active ? " tab-link-active" : "")}
          // Framework7 меряет подчёркивание по ссылке, а указатель вкладки у
          // материала шириной с подпись. Чтобы не спорить с его измерением,
          // ссылка *и есть* подпись: промежуток между вкладками -- поле
          // снаружи неё, а не отступ внутри.
          //
          // 16dp -- тот же шаг, которым разнесено всё остальное на экране:
          // две соседние вкладки тогда стоят в 32dp, что и меряет полоса у
          // Google.
          //
          // `min-width` по той же причине: ссылку с одним глифом Framework7
          // читает как иконочную кнопку бара и ставит в коробку 48dp, что
          // вернуло бы 12dp отступа внутрь ссылки, -- а подчёркивание это и
          // есть ссылка. Вкладка, названная глифом, шириной 24dp, как глиф.
          style={{
            paddingLeft: 0, paddingRight: 0, marginLeft: "16px", marginRight: "16px",
            minWidth: 0, flexShrink: 0,
          }}
        >
          {/* Заголовок -- то, что вкладке дали, по порядку. Значок не часть
              этого порядка: он принадлежит углу той части, за которой
              написан, поэтому пара сворачивается в одну опору. */}
          {tabTitle(tab.title || [], tab.id === active)}
        </a>
      ))}
      {/* Подпись как написана. «+» перед ней был бы фреймворком, который
          переписывает собственную кнопку приложения. */}
      {extras.map((b) => (
        <a key={b.id} className="tab-link" onClick={() => ctx.action(b)}>{b.label}</a>
      ))}
      {/* Framework7 рисует подчёркивание так, как это делал Material 2:
          линейка 2dp, прямоугольная, во всю ширину ссылки. Material 3 сделал
          её полосой 3dp со скруглёнными верхними углами, лежащей на
          разделителе под полосой, -- эти двое различимы с одного взгляда,
          почему полоса у Google и читается пилюлей, а наша -- волосяной
          линией. Изменены только высота и скругление; цвет, ширина и
          скольжение остаются Framework7. */}
      <span className="tab-link-highlight" style={{ height: "3px", borderRadius: "3px 3px 0 0" }} />
    </Toolbar>
  );

  if (!owns) {
    return (
      <div className="pa-tabs">
        {bar}
        {/* Высота по содержимому, а не по странице: вкладки внутри формы --
            часть того, что прокручивается, и коробка во всю высоту обрезала бы
            их. */}
        <Tabs className="pa-tabs__panes" style={{ height: "auto", overflow: "visible" }}>
          {pages.map((tab) => (
            <Tab key={tab.id} tabActive={tab.id === active}>
              {tab.children.map((c) => node(c, ctx))}
            </Tab>
          ))}
        </Tabs>
      </div>
    );
  }
  return (
    <div className="pa-tabs display-flex flex-direction-column" style={{ height: "100%" }}>
      {bar}
      {/* `<Tabs swipeable>` рисует ровно `swiper-container.tabs`, а `<Tab>`
          внутри неё -- `swiper-slide.tab` (`f7r/components/tab.js`: выбор
          между `swiper-slide` и `div` она делает по своему же контексту).
          Разметка та же до класса, но её больше не пишем мы. */}
      <Tabs
        swipeable ref={swiperRef} className="pa-tabs__panes" data-tabs={n.id}
        style={{
          flex: "1 1 auto", height: "auto", width: "100%",
          minWidth: 0, minHeight: 0, overflow: "hidden",
        }}
      >
        {pages.map((tab) => (
          <Tab
            // `data-pa-tab`, а не `data-tab`: последний -- **атрибут
            // Framework7**, и он берёт его значение селектором CSS у любого
            // элемента подряд. Наш идентификатор узла содержит `.` и `#`,
            // селектором не является, и при перерисовке вкладок разбор падал
            // с SyntaxError -- колонка списков сменялась красным блоком.
            //
            // Проходит насквозь не любое свойство: `getExtraAttrs` пропускает
            // только `data-*`, `aria-*` и `role`.
            key={tab.id} data-pa-tab={tab.id} tabActive={tab.id === active}
          >
            <div
              className="page-content"
              style={{ "--f7-page-navbar-offset": "0px", "--f7-page-toolbar-top-offset": "0px" }}
            >
              {tab.children.map((c) => node(c, ctx))}
            </div>
          </Tab>
        ))}
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------- button */

function ButtonNode({ n, ctx }) {
  // Вид предлагает, но не для этой записи -- удаление записи до того, как её
  // сохранили. Тот же приём, что и у поля, которое не рисуется.
  if (!n.visible) return <span className="display-none" />;
  const labelled = !!n.label;
  // В баре даже подписанное действие -- ссылка: залитая кнопка была бы там
  // второй поверхностью внутри его собственной. То же для действия, которое
  // приложение попросило вести себя тихо: слово, на которое нажимают, а не
  // залитая поверхность.
  const bar = ctx.mode === "navbar" || n.style === "plain";
  const props = {
    className: `${labelled && !bar ? "button button-large button-tonal" : "link"}`
      + `${labelled ? "" : " icon-only"}`
      + `${n.style === "destructive" ? " color-red" : ""} pa-btn pa-btn--${n.style}`
      + `${n.enabled === false ? " disabled" : ""}`,
    href: labelled ? undefined : "#",
    // Иконка сама по себе -- это *обычная* иконочная кнопка материала, а она
    // нарисована приглушённым тоном on-surface: акцент принадлежит залитому и
    // тональному вариантам, чем подписанное действие здесь уже и является.
    // Framework7 даёт акцент всякой ссылке, и это правило iOS. В баре
    // побеждает собственный цвет ссылок бара, поэтому это только для тела.
    "data-interactive": "1",
    "data-action": n.action.type,
    "aria-label": labelled ? undefined : n.action.type,
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (n.enabled === false) return;
      ctx.action(n);
    },
  };
  const body = (
    <>
      {n.icon && <Glyph name={n.icon} size={24} />}
      {labelled && <span>{n.label}</span>}
    </>
  );
  // Подписанное действие -- кнопка Framework7, иконочное -- его ссылка:
  // фреймворк оформляет `a.icon-only`, а не голый `button`.
  return labelled && !bar ? <button {...props}>{body}</button> : <a {...props}>{body}</a>;
}

/* -------------------------------------------------------------------- list */

/** Ниже этого числа строк весь список дешевле, чем окно по нему. */
const WINDOW_THRESHOLD = 40;
/**
 * Во сколько принимается одна строка, когда список не сказал.
 *
 * Сказать он не может: `row_height` -- обязательное поле провода, и умолчание
 * в нём то же самое, 52 (`ui/nodes.py:1087`, и так же в libs/js и libs/kotlin).
 * То есть эта величина -- запасная на случай кадра со старого рантайма, а
 * настоящая догадка лежит в объявлении и приезжает всегда.
 */
const ROW_HEIGHT = 52;
const OVERSCAN = 8;

/** Только те строки, которые читателю видны: срез и две распорки. */
function windowOf(rows, ctx, rowHeight) {
  if (rows.length < WINDOW_THRESHOLD) return { rows, before: 0, after: 0 };
  const top = ctx.scrollTop();
  const height = rowHeight || ROW_HEIGHT;
  const visible = Math.ceil(ctx.viewportHeight() / height) + OVERSCAN * 2;
  const first = Math.max(0, Math.floor(top / height) - OVERSCAN);
  const last = Math.min(rows.length, first + visible);
  return {
    rows: rows.slice(first, last),
    before: first * height,
    after: (rows.length - last) * height,
  };
}

/**
 * Что говорит пустой список: строка и строка под ней.
 *
 * Список даёт одну или обе. Только список знает, что у него за строки, поэтому
 * вторая строка -- его собственная или её нет вовсе: фреймворково «нажмите +»
 * указывало бы на кнопку, наличие которой решает экран, а не список. То, что
 * список дал, берётся как написано, включая пустую строку: так он просит одну
 * строку и ничего больше.
 */
const emptyLines = (n) => [(n.empty || [])[0] || t("empty"), (n.empty || [])[1] || ""];

const wantsTitleRow = (n) =>
  !!(n.label || n.menu || n.search?.filters?.length || n.search?.sorts?.length);

function ListNode({ n, ctx }) {
  // Строки несут свою шапку сами, первым элементом списка. Таблица и лента --
  // не `.list`, поэтому их шапка остаётся блоком над ними.
  const asRows = n.display !== "timeline" && !ctx.wantsTable(n);
  return (
    <div data-list-id={n.id}>
      {n.search?.fields.length > 0 && <SearchBar n={n} ctx={ctx} />}
      {!asRows && wantsTitleRow(n) && <TitleRow n={n} ctx={ctx} inList={false} />}
      {n.rows == null ? <Skeleton /> : <ListBody n={n} ctx={ctx} />}
    </div>
  );
}

const Skeleton = () => (
  <div className="list list-strong inset skeleton-text">
    <ul>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="item-content">
          <div className="item-inner"><div className="item-title">Placeholder title</div></div>
        </li>
      ))}
    </ul>
  </div>
);

const EmptyBlock = ({ n }) => (
  <div className="block padding-vertical text-align-center">
    <BlockTitle>{emptyLines(n)[0]}</BlockTitle>
    <div className="block-footer">{emptyLines(n)[1]}</div>
  </div>
);

function ListBody({ n, ctx }) {
  if (n.display === "timeline") return n.rows.length ? <Timeline n={n} ctx={ctx} /> : <EmptyBlock n={n} />;
  if (ctx.wantsTable(n)) return n.rows.length ? <Table n={n} ctx={ctx} /> : <EmptyBlock n={n} />;
  // Строки держат карточку и без единой строки в ней: там живёт шапка, а
  // опустевший список чаще фильтр, который надо отменить, чем список, который
  // надо наполнить.
  return <Rows n={n} ctx={ctx} />;
}

/** Строка нажимается, но нажатие на ячейку `data-interactive` -- её. */
const opener = (n, row, ctx) => (e) => {
  if (e.target.closest("[data-interactive]")) return;
  if (row.openable) ctx.open(n.id, row.id);
};

/** Ячейки вида элемента, обернул он их в Row или нет. */
const bodyCells = (row) =>
  row.children.length === 1 && row.children[0].type === "row"
    ? row.children[0].children
    : row.children;

/**
 * Ячейка, стоящая перед текстом строки, если она есть.
 *
 * У строки списка материала есть ведущий слот -- флажок, аватар, метка цвета,
 * -- и у Framework7 он тот же, `item-media`, с собственной величиной зазора за
 * ним. Какая это ячейка, читается так же, как уже читается хвост: текст строки
 * -- её заголовок, значит ячейка перед заголовком и есть то, что строку ведёт,
 * а строка, начинающаяся собственным заголовком, ведущего слота не имеет вовсе.
 */
const leadCell = (body) => {
  const title = body.findIndex((c) => c.widget === "title");
  return title > 0 && body[0].place !== "after" ? body[0] : null;
};

/**
 * Что-нибудь в этой ячейке уходит на вторую строку?
 *
 * Спрашивается и у ячейки, и у того, что в ней: две строки строки списка обычно
 * это `Col` вокруг заголовка и подзаголовка, поэтому переносится не ячейка
 * строки, а её внучка.
 */
const wraps = (c) => !!c && (!!c.options?.wrap || (c.children || []).some(wraps));

/**
 * Где у строки хвост.
 *
 * Ячейку, которую приложение прижало к концу, если оно её назвало. Иначе эту
 * работу держит та, что идёт за заголовком, -- такова форма строки на обеих
 * платформах: умолчание, а не единственная возможность.
 */
function afterIndex(body) {
  const claimed = body.findIndex((c) => c.place === "after");
  return claimed >= 0
    ? claimed
    : body.findIndex((c) => c.widget === "title") + 1 || 1;
}

/**
 * Отступы ячеек строки -- на элементах, а не на узлах.
 *
 * У Framework7 нет утилиты зазора, но есть поля: всякая ячейка, кроме первой,
 * отодвинута от предыдущей. Ячейка `item-after` -- исключение: её собственное
 * `margin-left: auto` и есть то, что прижимает хвост строки к дальнему краю, а
 * утилита полей достаточно `!important`, чтобы его убить.
 */
function useCellClasses(ref, after, offset = 0) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    [...el.children].forEach((cell, i) => {
      const at = i + offset;
      cell.classList.toggle("item-after", at === after);
      cell.classList.toggle("margin-left-half", at > 0 && at !== after);
    });
  });
}

function RowItem({ n, row, ctx }) {
  // Собственный элемент списка Framework7 -- это `item-content > item-inner`, и
  // ручка перетаскивания стоит *рядом* с телом: она размещена абсолютно
  // относительно элемента списка, поэтому, оставь её внутри `item-inner`
  // (который `position: relative`), она переякорилась бы на строку. Вынести её
  // -- это и есть то, что позволяет телу быть `item-inner`, а он уже даёт
  // ширину, сжатие и вертикальные поля.
  const all = bodyCells(row);
  const handle = all.find((c) => c.widget === "handle");
  // Какие у этой записи ячейки -- её собственный ответ (`visible=record.done`).
  // Раскладка ниже читается по ячейкам, поэтому нерисуемые убираются первыми:
  // нерисуемая ячейка, занявшая хвост строки, прижала бы к дальнему краю пустой
  // элемент и оставила бы настоящий орган управления болтаться.
  const cells = all.filter((c) => c.visible !== false || c === handle);
  const rowCtx = { ...ctx, mode: "row" };
  // Нерисуемая ручка всё равно значит «этот список переставляют», и у
  // Framework7 есть способ начать перестановку без ручки: долгое нажатие на
  // элемент с классом `sortable-tap-hold`. Ничего этим классом не оформлено --
  // ручкой становится сама строка.
  const rowClass = handle?.visible === false ? "sortable-tap-hold" : undefined;
  // Материал ставит ведущий элемент строки в 16dp от заголовка, и эта величина
  // -- `--f7-list-item-media-margin` у Framework7, который применяет её к
  // одному слоту, `item-media`, стоящему рядом с `item-inner`, а не внутри
  // него. Поэтому ведущая ячейка идёт в этот слот, а не остаётся ячейкой тела с
  // утилитой полей за спиной: зазор тогда берётся из собственной меры строки, а
  // не из типографской, и ячейки за ним держат тот меньший шаг, который у них и
  // был. Тот же слот, в который строки карточки уже кладут свой глиф.
  const lead = leadCell(cells.filter((c) => c !== handle));
  const wrapping = cells.some(wraps);
  const body = cells.filter((c) => c !== handle && c !== lead);
  const innerRef = useRef(null);
  const liRef = useRef(null);
  useCellClasses(innerRef, afterIndex(body));

  // Framework7 Swipeout: тело строки уезжает вбок и открывает действие.
  useDomEvent(liRef, "swipeout:deleted", () => {
    if (!n.swipe_delete) return;
    ctx.act({
      type: "action",
      button_id: n.swipe_delete,
      context: { model: n.model, record_id: row.id, in_row: true },
    });
  });

  const content = (
    // `item-link`, а не голый `ripple`. Класс `ripple` -- только метка для
    // обработчика касаний (`touchRippleElements`), и в таблице стилей
    // Framework7 правила на него нет ни одного: вместилище волны он раздаёт
    // своим формам строки -- `.list .item-link`, `.list label.item-content`,
    // `.list .list-button` получают `position: relative; overflow: hidden`.
    // Наша строка не была ни одной из трёх, и волну не обрезало ничем: при
    // высоте строки 48 пикселей Framework7 растит круг по диагонали короба --
    // 362 пикселя, -- и он расходился по всему листу (замерено).
    //
    // `no-chevron` рядом обязателен: `item-link` дорисовывает строке уголок
    // «дальше» и держит под него место. Класс гасит и то и другое одной
    // переменной (`--f7-list-chevron-icon-area: 0`), и поле справа у
    // внутренности остаётся прежним -- 24 пикселя до правки и после.
    <div className="item-content item-link no-chevron pa-rowitem" onClick={opener(n, row, ctx)}>
      {/* Строка, чей текст переносится, высотой в несколько строк, и её органы
          управления принадлежат первой из них: флажок, висящий сбоку от
          середины абзаца, читается как не принадлежащий ни одной. Собственная
          утилита выравнивания Framework7, только там, где что-то действительно
          переносится, -- и ведущий слот, будучи снаружи `item-inner`, берёт
          собственную её копию. */}
      {lead && (
        <div className={"item-media" + (wrapping ? " align-self-flex-start" : "")}>
          {node(lead, rowCtx)}
        </div>
      )}
      <div
        ref={innerRef}
        className={"item-inner pa-row" + (wrapping ? " align-items-flex-start" : "")}
      >
        {body.map((c) => node(c, rowCtx))}
      </div>
    </div>
  );

  if (n.swipe_delete) {
    return (
      <li
        ref={liRef} className={["swipeout", rowClass].filter(Boolean).join(" ")}
        data-id={String(row.id)}
      >
        {handle && node(handle, rowCtx)}
        <div className="swipeout-content">{content}</div>
        <div className="swipeout-actions-right">
          {/* Собственная формулировка кнопки, когда она есть: действие назвало
              приложение, и жест выполняет то же самое действие. */}
          {/* `swipeout-delete`, а не `swipeout-delete-trigger`: второго класса
              у Framework7 нет ни одного, и жест поэтому не срабатывал никогда.
              Проверено по его исходникам; e2e-проверки на свайп у нас не было,
              поэтому это молчало. */}
          <a className="swipeout-delete" href="#">{n.swipe_label || t("delete")}</a>
        </div>
      </li>
    );
  }
  return (
    <li ref={liRef} className={rowClass} data-id={String(row.id)}>
      {handle && node(handle, rowCtx)}{content}
    </li>
  );
}

/** Событие Framework7 на элементе: имена с двоеточием React не знает. */
function useDomEvent(ref, name, handler) {
  const latest = useRef(handler);
  latest.current = handler;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const listener = (event) => latest.current(event);
    el.addEventListener(name, listener);
    return () => el.removeEventListener(name, listener);
  }, [ref, name]);
}

function Rows({ n, ctx }) {
  const win = windowOf(n.rows, ctx, n.row_height);
  // Один и тот же узел списка рисуется на каждой странице Tabs с источником,
  // поэтому их элементы различает та страница, которой список принадлежит.
  const domId = `pa-rows-${cssId(n.pane == null ? n.id : `${n.id}:${n.pane}`)}`;
  const listRef = useRef(null);

  // Перетаскивание Framework7 разбирает на самом элементе списка, поэтому его
  // достаточно включить, когда список встал на место.
  useLayoutEffect(() => {
    if (listRef.current) ctx.f7.sortable[n.reorderable ? "enable" : "disable"](listRef.current);
  });

  const list = (
    <div
      ref={listRef} id={domId}
      data-reorder={n.reorderable ? "1" : undefined}
      // Переставляет строки рантайм, а не Framework7. По умолчанию тот сам
      // переносит `<li>` в документе на отпускании (`sortable.js:151-163`) --
      // за спиной React, который про этот перенос не знает и диффит против
      // своего дерева. Пока рантайм подтверждает перестановку новым кадром,
      // это сходится; но кадр, в котором порядок не изменился (правило
      // отказало, запись уехала из отбора), React проходит без единой правки
      // документа -- и документ навсегда остаётся в чужом порядке. Своя
      // React-обёртка списка у Framework7 выключает это тем же атрибутом
      // (`f7r/components/list.js:227`).
      //
      // Платим этим за то, что видит палец. Сдвиги строк Framework7 снимает
      // раньше и без всяких условий (`sortable.js:146`), в том числе с самой
      // захваченной, -- а перенос, который поставил бы её на новое место,
      // теперь пропущен. Значит брошенная строка отскакивает на прежнее место
      // и стоит там до кадра рантайма: на стенде это один-три кадра
      // отрисовки, на занятом устройстве -- сколько займёт воркер. Отскок
      // терпим, потому что лечение хуже: удержать строку можно только своим
      // сдвигом поверх, а снять его было бы нечем ровно в том случае, ради
      // которого всё и затевалось, -- когда перестановка не принята
      // (`session.js:on_reorder` выходит, не тронув записи), кадра не будет
      // вовсе, и строка осталась бы висеть сдвинутой навсегда.
      data-sortable-move-elements="false"
      // Framework7 прячет ручку, пока список не `sortable-enabled`, поэтому
      // классы несёт всякий список, и различается только включение.
      //
      // Framework7 сдвигает каждую строку включённого переставляемого списка,
      // освобождая место под захват, и это правило *заменяет* собственные
      // горизонтальные поля строки, а не добавляется к ним. При спрятанной
      // ручке захвата нет, поэтому ширина, которую он под неё резервирует, и
      // становится теми полями, которые были бы у обычной строки, -- и то, и
      // другое его собственные переменные, а не наше правило.
      style={n.handle_hidden
        ? { "--f7-sortable-handler-width": "var(--f7-list-item-padding-horizontal)" }
        : undefined}
      className="list list-strong inset pa-rows sortable sortable-opposite"
    >
      {win.before > 0 && <div style={{ height: `${win.before}px` }} />}
      <ul>
        <SectionRow n={n} />
        {n.rows.length
          ? win.rows.map((record) => {
              const row = bindRow(n.row, record);
              return <RowItem key={row.id} n={n} row={row} ctx={ctx} />;
            })
          : (
            <li className="item-content">
              <div className="item-inner display-block text-align-center">
                <div className="item-title">{emptyLines(n)[0]}</div>
                <div className="item-footer">{emptyLines(n)[1]}</div>
              </div>
            </li>
          )}
      </ul>
      {win.after > 0 && <div style={{ height: `${win.after}px` }} />}
    </div>
  );
  // Шапка стоит НАД карточкой, а не первой строкой в её `ul`.
  //
  // Так говорят оба гайдлайна, и оба проверены по первоисточнику. Material:
  // «subheaders are list tiles that delineate sections of a list», своей
  // заливки у них нет, цвет -- приглушённый серый либо основной цвет
  // приложения (m1.material.io/components/subheaders.html). Apple: у
  // сгруппированного стиля «headers, footers, and additional space separate
  // groups of data», а у inset grouped «continuous background color extends
  // *from* the section header ... *down to* the section footer» -- то есть
  // скруглённая заливка лежит между заголовком и подвалом, а не вокруг них.
  // Снятый на живом Android 13 экран настроек показывает ровно это: «Color»,
  // «Other display controls» -- акцентом, без заливки, над строками.
  //
  // Заодно уходит и беда, из-за которой всё вскрылось: `list-group-title`
  // красится по умолчанию, `.list.inset ul` несёт скругление без обрезки
  // (`overflow: visible`), и залитая первая строка срезала оба верхних угла
  // карточки.
  const шапка = wantsTitleRow(n) ? <TitleRow n={n} ctx={ctx} inList={false} /> : null;
  if (!n.index) {
    return шапка ? <>{шапка}{list}</> : list;
  }
  return (
    <div>
      {шапка}
      {/* Скребок читает сам список и рисует себя; его надо только на список
          навести. `label` сказан вслух: пузырёк с буквой под пальцем у
          Framework7 выключен по умолчанию, а у нас он был. Ключ по списку --
          потому что составляющая берёт `listEl` один раз, на монтировании: смени
          список под ней, и скребок остался бы наведён на прежний. */}
      <ListIndex key={domId} listEl={`#${domId}`} label />
      {list}
    </div>
  );
}

/**
 * Заголовок, который сортировка ставит над своими строками --
 * `Sort(..., section=True)`.
 *
 * Собственный внутрисписочный заголовок группы Framework7 с нетронутыми
 * умолчаниями: залит, тусклее строк и отбит чертой. Ровно для этого разделитель
 * секции и нужен, и в отличие от строки заголовка списка -- которая возглавляет
 * всю карточку и потому берёт её фон -- этот возглавляет пробег строк внутри
 * неё и должен читаться как разрыв.
 */
function SectionRow({ n }) {
  const sort = n.search?.sorts?.[n.state?.sort];
  if (!sort?.section || !n.rows.length) return null;
  return <li className="list-group-title no-sorting">{sort.label}</li>;
}

/**
 * Полоса поиска Framework7 с буфером набора.
 *
 * Составляющая была тут и раньше -- её заводил авто-инит по `searchbar-init`,
 * а разметку под неё мы писали руками; теперь её ставит `<Searchbar>`, и
 * разметка с параметрами едут одним объявлением. Обёртка остаётся ради
 * значения: оно живёт здесь, а не приезжает кадром, потому что между нажатием
 * клавиши и следующим кадром лежит воркер, и поле, ждущее оттуда каждую свою
 * букву, набирается рывками. Событие уходит той же клавишей -- список
 * отзывается сразу.
 *
 * Три умолчания сказаны вслух, потому что разошлись бы с тем, что было:
 * `form={false}` -- корень остаётся `<div>`, а не становится формой;
 * `disableButton={false}` -- кнопки «отмена» справа от поля у нас не было
 * (Framework7 и сам ставит `searchbar-enabled-no-disable-button`, когда её не
 * находит); `customSearch` -- отбор считает рантайм, а не селекторы по
 * документу. Затемнение (`backdrop`) НЕ выключено: авто-инит давал его и до
 * правки -- проверено на собранном приложении.
 */
function SearchBar({ n, ctx }) {
  const [text, setText] = useState(n.state.text ?? "");
  const shown = useRef(n.state.text);
  if (shown.current !== n.state.text) {
    shown.current = n.state.text;
    if (text !== (n.state.text ?? "")) setText(n.state.text ?? "");
  }
  return (
    <Searchbar
      className="pa-searchbar" customSearch form={false} disableButton={false}
      placeholder={n.search.placeholder || t("search")}
      value={text}
      onInput={(e) => { setText(e.target.value); ctx.search(n.id, e.target.value); }}
    />
  );
}

/**
 * Собственная шапка списка: его название слева, применяемые им отборы и
 * сортировка справа.
 *
 * `block-title` -- то, что заставляет её читаться частью списка, а не органом
 * управления, висящим над ним: Framework7 подтягивает следующий `.list` прямо к
 * ней (`.block-title + .list { margin-top: 0 }`). Полоса поиска остаётся
 * снаружи: поле поиска -- свой собственный бар, а не заголовок.
 */
/**
 * Выбор сортировки -- составляющая Framework7, а не наша разметка.
 *
 * `smart-select` -- его собственный «выбери одно из нескольких»: тем же в этом
 * приложении выбирается список задачи. Он сам поднимает нижний лист, сам
 * рисует строки `item-radio`, сам закрывается на выборе и сам держит
 * выравнивание в обеих темах. От нас -- обычный `<select>` и ни строки его
 * разметки.
 */
// Во что попадает палец. Размер иконочным ссылкам Framework7 задаёт только
// внутри своих баров (навбар, тулбар, действия таблицы), а шапка списка баром
// не является -- там ссылка ужимается до самого глифа, 24 пикселя. Оба
// гайдлайна требуют больше: Material 48dp, Apple 44pt.
//
// Число взято не наше, а его же: `--f7-list-item-min-height` -- это ровно «во
// что попадает палец в списке», и в каждой теме оно своё (48 в Material, 52 в
// iOS). Оба перекрывают требуемый минимум.
const ПАЛЕЦ = {
  minWidth: "var(--f7-list-item-min-height)",
  minHeight: "var(--f7-list-item-min-height)",
};

function SortPick({ n, ctx, icon }) {
  const ref = useRef(null);
  useEffect(() => {
    // Меню, а не лист: и Material, и HIG выбирают порядок всплывающим меню у
    // самой кнопки. Разница не только в виде -- лист Framework7 рисует поверх
    // себя полосу с крестиком (`smart-select.js`, `renderSheet`), и убрать её
    // параметром нельзя. Всплывающему меню полоса не нужна: оно уходит по
    // выбору и по нажатию мимо, как и все прочие наши меню на `f7.actions`.
    // `closeOnSelect` у него выключен по умолчанию -- он рассчитан и на выбор
    // нескольких. Сортировка одна, и меню обязано уйти сразу.
    const smart = ctx.f7.smartSelect.create({
      el: ref.current, openIn: "popover", closeOnSelect: true,
    });
    return () => smart.destroy();
  }, [ctx.f7]);
  return (
    <a href="#" className="link icon-only pa-sortbtn smart-select" ref={ref} style={ПАЛЕЦ}>
      <select
        name={`sort-${n.id}`} value={String(n.state.sort ?? 0)}
        onChange={(e) => ctx.dispatch({
          type: "set_sort", list_id: n.id, index: Number(e.target.value),
        })}
      >
        {(n.search?.sorts || []).map((sort, i) => (
          <option key={sort.label} value={String(i)}>{sort.label}</option>
        ))}
      </select>
      <Glyph name={icon} size={24} />
    </a>
  );
}

function TitleRow({ n, ctx, inList }) {
  const s = n.search || { filters: [], sorts: [] };
  const pickFilter = (i) => (e) => {
    e.preventDefault();
    ctx.filter(n.id, i === n.state.filter ? null : i);
  };
  // Якорь, а не `<Chip>` из framework7-react: та же причина, что у нажимаемой
  // фишки в `widgets.jsx`, -- составляющая рисует `div`, а `div` без курсора и
  // без места в обходе клавишей, и передать ей `tabIndex` нечем.
  const left = (
    <div className="pa-filters__chips display-flex align-items-center">
      {n.label && <span className="margin-right-half">{n.label}</span>}
      {s.filters.map((f, i) => (
        <a
          key={f.label} href="#" data-index={String(i)} onClick={pickFilter(i)}
          className={"chip pa-chip margin-right-half"
            + (i === n.state.filter ? " is-active" : " chip-outline")}
        >
          <div className="chip-label">{f.label}</div>
        </a>
      ))}
    </div>
  );
  // Иконки, а не подписанные ссылки: шапка -- строка списка, и лист, который
  // откроется, уже скажет, какая сортировка включена.
  //
  // Framework7 красит всякую ссылку цветом темы, и это iOS: там кнопка бара
  // *и есть* акцент. Обычная иконочная кнопка материала нарисована приглушённым
  // тоном on-surface и оставляет акцент тому единственному в строке, что несёт
  // состояние. В собственной материальной палитре Framework7 этот тон есть.
  const right = (
    <div
      className="display-flex align-items-center"
      // Правый край -- по краю карточки. Обёртка шапки идёт во всю ширину, а
      // карточка вставлена, и без этого кнопка упиралась бы в край экрана.
      // Величина его собственная, поэтому в каждой теме своё число.
      //
      // По содержимому строки (то есть ещё плюс её поле) не равняется
      // намеренно: тогда просвет справа у шапки становится вдвое шире, чем у
      // листа под ней, и это видно.
      style={{ marginRight: "var(--f7-list-inset-side-margin)" }}
    >
      {s.sorts.length > 0 && (
        <SortPick n={n} ctx={ctx} icon={s.icon || "swap_vert"} />
      )}
      {n.menu && (
        <a
          href="#" className="link icon-only pa-listmenu"
          // Зазора между кнопками нет: у каждой своя область нажатия, и они
          // встают рядом сами.
          style={ПАЛЕЦ}
          onClick={(e) => { e.preventDefault(); ctx.listMenu(n); }}
        >
          <Glyph name={n.menu.icon || "more_vert"} size={24} />
        </a>
      )}
    </div>
  );
  const cls = "pa-filters display-flex align-items-center justify-content-space-between";
  if (!inList) {
    // Кнопки НЕ внутри `block-title`: у него `overflow: hidden` (это его
    // собственное правило -- он рассчитан на длинный заголовок с многоточием),
    // и иконочная ссылка в 44 пикселя сжималась в нём до 24, а волна
    // прикосновения обрезалась на полпути. Заголовком остаётся только текст,
    // кнопки идут рядом.
    return (
      <div className={cls}>
        <BlockTitle>{left}</BlockTitle>
        {right}
      </div>
    );
  }
  // Внутри списка это `li` его `ul`, потому что карточку Framework7 кладёт
  // именно туда: `.list.inset ul` несёт скругление и заливку, поэтому шапка вне
  // `ul` оказалась бы вне карточки. Собственная её заливка снимается -- та
  // заливка рисует *iOS*-разделитель *между* карточками, а эта шапка *внутри*
  // одной, и потому берёт фон карточки.
  //
  // `no-sorting` -- то, чем Framework7 говорят, что элемент не из
  // переставляемых: он собирает `ul > li` для перетаскивания, а шапка в этом
  // `ul` лежит.
  return (
    <li
      className={`list-group-title no-sorting ${cls}`}
      // Собственная переменная Framework7, ни одного нашего правила. Заливка
      // у `list-group-title` есть по умолчанию, потому что он рассчитан на
      // липкий разделитель в обычном списке. Внутри вставной карточки она
      // портит дело: скругление несёт `ul`, обрезки у него нет
      // (`overflow: visible`), и залитая первая строка закрашивает оба
      // верхних угла. У самого Framework7 строки прозрачны -- поэтому у него
      // угол никто и не трогает.
      style={{ "--f7-list-group-title-bg-color": "transparent" }}
    >
      {left}{right}
    </li>
  );
}

/**
 * Те же строки лентой Framework7.
 *
 * Первая ячейка -- момент, остальное -- запись: то самое разделение, вокруг
 * которого построена сама составляющая.
 */
function Timeline({ n, ctx }) {
  const rowCtx = { ...ctx, mode: "row" };
  return (
    <div className="timeline">
      {n.rows.map((record) => {
        const row = bindRow(n.row, record);
        const cells = bodyCells(row).filter((c) => c.visible !== false);
        return (
          <div
            key={row.id} className="timeline-item" data-id={String(row.id)}
            onClick={opener(n, row, ctx)}
          >
            <div className="timeline-item-date">{cells[0] && node(cells[0], rowCtx)}</div>
            <div className="timeline-item-content">
              <TimelineCells cells={cells.slice(1)} ctx={rowCtx} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TimelineCells({ cells, ctx }) {
  const ref = useRef(null);
  // Ячейка времени осталась снаружи, а нумерация ведётся по всей строке:
  // хвост считается от неё целиком, как и в строке списка.
  useCellClasses(ref, afterIndex(cells), 1);
  return (
    <div ref={ref} className="timeline-item-inner display-flex align-items-center pa-row">
      {cells.map((c) => node(c, ctx))}
    </div>
  );
}

function Table({ n, ctx }) {
  const columns = n.columns || [];
  const cellsOf = (row) => {
    if (row.cells) return row.cells;
    const c = row.children;
    return c.length === 1 && c[0].type === "row" ? c[0].children : c;
  };
  // Framework7 помечает первую колонку и числовые; остальное -- данные.
  const cls = (i, col) =>
    `${i === 0 ? "label-cell" : ""}${col?.numeric ? " numeric-cell" : ""}`.trim();
  const rowCtx = { ...ctx, mode: "row" };
  return (
    <div className="data-table card pa-table">
      <table>
        <thead>
          <tr>
            {columns.map((col, i) => <th key={col.id} className={cls(i, col)}>{col.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {n.rows.map((record) => bindRow(n.row, record)).map((row) => (
            <tr key={row.id} data-id={String(row.id)} onClick={opener(n, row, ctx)}>
              {cellsOf(row).map((cell, i) => (
                <td key={columns[i]?.id ?? i} className={cls(i, columns[i])}>
                  {node(cell, rowCtx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------- точки входа */

/** Тело экрана: его ошибка, если она есть, и его узлы. */
export function ScreenNodes({ screen, ctx }) {
  return (
    <>
      {screen.error && <ErrorBox text={screen.error} />}
      {(screen.children || []).map((c) => node(c, ctx))}
    </>
  );
}

/** То, что экран положил в слот бара -- тем же истолкователем, что и тело. */
export function BarNodes({ nodes, ctx }) {
  if (!nodes.length) return null;
  return (
    <div className="pa-navslot display-flex align-items-center">
      {nodes.map((n) => node(n, ctx))}
    </div>
  );
}

/* ------------------------------------------------------------------ роспись -
 *
 * Что чем рисуется. Обход живёт в `render.jsx` и про эти составляющие не знает
 * -- знание одностороннее, поэтому круга ввоза нет.
 *
 * Четырёх типов здесь нет намеренно: `tab`, `pill`, `text` и `icon` рисует не
 * обход, а тот, кто их содержит, -- вкладку рисует `TabsNode`, значок и
 * подпись рисует строка. `view` -- корень, его разбирает `ScreenNodes`.
 */
registerNode("row", (n, ctx) => <RowNode n={n} ctx={ctx} />);
registerNode("col", (n, ctx) => (
  <div className="display-flex flex-direction-column">
    {n.children.map((c) => node(c, { ...ctx, mode: ctx.screenMode }))}
  </div>
));
registerNode("section", (n) => <BlockTitle className="text-color-primary">{n.title || ""}</BlockTitle>);
registerNode("group", (n, ctx) => <GroupNode n={n} ctx={ctx} />);
// Framework7 открывает и закрывает её сам: классы и есть поведение.
//
// `link="#"` -- не украшение: без него составляющая рисует `<a>` вовсе без
// `href`, а такой якорь выпадает из обхода клавишей, и блок перестаёт
// открываться с клавиатуры. Собственная разметка аккордеона у Framework7
// несёт тот же `href="#"`, и наша несла его же.
registerNode("accordion", (n, ctx) => (
  <List strong inset accordionList>
    <ListItem accordionItem link="#" accordionItemOpened={!!n.open} title={n.label || ""}>
      <AccordionContent>{n.children.map((c) => node(c, ctx))}</AccordionContent>
    </ListItem>
  </List>
));
registerNode("tabs", (n, ctx) => <TabsNode n={n} ctx={ctx} />);
registerNode("field", (n, ctx) => field(n, ctx));
registerNode("button", (n, ctx) => <ButtonNode n={n} ctx={ctx} />);
registerNode("list", (n, ctx) => <ListNode n={n} ctx={ctx} />);
// Меню, которому дали место, рисует ссылку, его открывающую; меню,
// принадлежащее списку, рисует шапка этого списка.
registerNode("menu", (n, ctx) => (n.place ? (
  <a
    href="#" className="link icon-only pa-menubtn" aria-label="menu"
    onClick={(e) => { e.preventDefault(); ctx.listMenu(n); }}
  >
    <Glyph name={n.icon || "more_vert"} size={24} />
  </a>
) : <span className="display-none" />));

["view", "tab", "pill", "text", "icon"].forEach((т) => registerNode(т, РИСУЕТ_РОДИТЕЛЬ));
assertEveryTypeIsDrawn();

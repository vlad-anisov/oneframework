/**
 * Навигация: где стек рантайма и маршрутизатор Framework7 расходятся.
 *
 * Три места разбор `docs/research-framework7-native.md` (раздел 1.3) вывел из
 * исходников и честно пометил «выведено, не проверено прогоном». Здесь они
 * проверены пальцем -- до починки, а не после: иначе после переделки навигации
 * не видно, что именно починили, и «стало лучше» приходится брать на слово.
 *
 * Проверка, помеченная `test.fail()`, падает нарочно и прогон от этого
 * остаётся зелёным. Починка снимает пометку -- и если поломка вернётся, пометка
 * вернуться уже не сможет незаметно, потому что «ожидали провал, а прошло» тоже
 * краснеет. Помеченных не осталось: с 32 пометка снята последней -- глубину
 * кнопка спрашивает у стека рантайма, а не у маршрутизатора (`main.jsx`), и
 * карточка в стеке стоит. Маршрутом она от этого не стала, это отдельная работа.
 *
 * С 30 пометка снята: снятый кадр держится до конца перехода
 * (`web/src/react/store.js`, `outgoing`).
 *
 * 31 зелёная и была зелёной: находка про прокрутку при проверке не
 * подтвердилась (почему -- сказано у неё в шапке). Сторожила она смену ключа
 * ячейки прокрутки, и та случилась -- адрес понёс запись.
 *
 * 33-35 добавлены вместе с проекцией стека в адрес: уникальность адреса,
 * пустая половина широкого окна и сторож, который не должен запирать
 * маршрутизатор.
 *
 * 36-39 -- адресная строка и глубокие ссылки (`web/src/address.js`): адрес
 * идёт за стеком, ссылка разворачивается в стек, кнопка браузера входит
 * событием, а карточка адреса не занимает.
 *
 * Крошек здесь нет: gtasks сказал `crumbs = False` обеими своими карточками --
 * глубже двух кадров он не ходит, и цепочка выходила бы парой, где первое звено
 * повторяет стрелку «назад». Мерить стало нечего, и проверки цепочки переехали
 * на витрину -- `kitchen.spec.js`, 41-44.
 *
 * 44 -- стрелка «назад» пальцем и в широком окне: единственное место, где видно
 * разницу между «нажатие ушло в рантайм» и «нажатие ушло в маршрутизатор».
 * Узкому окну эта разница не видна вовсе -- там работали оба порядка.
 *
 * 43 -- обратная сторона 30: снятое дерево доживает до конца перехода и там же
 * кончается. Жест проверяется по-настоящему, пальцем через CDP.
 *
 * 42 -- обратная сторона 32: у маршрутизатора страниц бывает больше, чем кадров
 * в стеке (пустая половина широкого окна), и на корне кнопка обязана выйти.
 *
 * 46 -- единственная ветка сведения, которую не задевала ни одна из прочих:
 * молчаливый отказ маршрутизатора. Найдена тем, что её удаление не красило
 * ничего, -- то есть тем самым приёмом, которым здесь проверяют все остальные.
 *
 * Прогон идёт против *gtasks*: только там есть обе подачи записи разом --
 * страницей и карточкой. `oneframework build web examples/gtasks/app.py`.
 */

import { expect, test } from "@playwright/test";

import { EMPTY_URL } from "../../web/src/react/route.js";
import { activeStack, bootApp, readRecord } from "./helpers.js";

const boot = (page) => bootApp(page, "Задачи");

/** Открыть вкладку списка -- так, как это делает палец. */
async function openBoard(page, label) {
  await page.locator(".pa-tabs__bar .tab-link", { hasText: label }).first().click();
  await page.waitForTimeout(500);
}

const rows = (page) =>
  page.locator(".pa-tabs__panes .tab-active .pa-rows li:not(.list-group-title)");

//: Строка открывается нажатием на название: `.pa-title` в строке несколько
//: (срок, дата выполнения), и первое из них -- то самое.
async function openRow(page, index = 0) {
  await rows(page).nth(index).locator(".pa-title").first().click();
  await page.waitForTimeout(800);
}

/** Страница стека по её номеру -- тому же, что стоит на ней атрибутом. */
const pageAt = (page, index) => page.locator(`.view > .page[data-index="${index}"]`);

const routerHistory = (page) =>
  page.evaluate(() => [...window.oneframework.f7.views.current.router.history]);

/**
 * Адрес корня раздела -- та же проекция, что у оболочки (`web/src/react/route.js`).
 *
 * Считается, а не переписан строкой: ключ раздела принадлежит приложению, и
 * проверка не должна ломаться от того, что пример переименовали.
 */
const rootUrl = (page) =>
  page.evaluate(() => `/s/${encodeURIComponent(window.oneframework.snapshot().active)}/`);

/** Адрес кадра: раздел, вид, запись -- и ключ самого кадра запросом. */
const FRAME_URL = /^\/s\/[^/]+\/[^/]+\/[^/?]+\/\?f=s\d+$/;

/**
 * Открыть запись событием, а не пальцем -- ту же самую, что уже открыта.
 *
 * Пальцем такое делается из карточки, где список повторён; здесь достаточно
 * события: рантайм ищет список по всем кадрам, и «открыть ещё раз» -- обычный
 * `push`.
 */
const openAgain = (page, index = 0) =>
  page.evaluate((i) => {
    const rows = document.querySelectorAll(
      ".pa-tabs__panes .tab-active .pa-rows li[data-id]");
    const li = rows[i];
    window.oneframework.dispatch({
      type: "open",
      list_id: li.closest("[data-list-id]").dataset.listId,
      record_id: li.dataset.id,
    });
  }, index);

/** Адресная строка -- то, что видно человеку и что он скопирует в письмо. */
const hash = (page) => page.evaluate(() => window.location.hash);

/** Ключ первой записи списка -- тот же, что поедет в адрес. */
const firstId = (page) => rows(page).first().getAttribute("data-id");

/** Снятые кадры, которые оболочка ещё держит (`store.outgoing`). */
const outgoing = (page) => page.evaluate(() => window.oneframework.outgoing());

/**
 * Жест «назад» -- пальцем от левого края, по-настоящему.
 *
 * Через CDP, а не `dispatchEvent`: `swipe-back.js:29` первой же строкой
 * отбрасывает недоверенное событие (`!e.isTrusted`), и нарисованный руками
 * `TouchEvent` до обработчика не доходит вовсе. `Input.dispatchTouchEvent`
 * приходит от браузера и доверен.
 *
 * Быстро и недалеко -- этого довольно: переход считается состоявшимся при
 * `timeDiff < 300 && touchesDiff > 10` (`swipe-back.js:168`). Начало -- в 5
 * пикселях от края, потому что дальше `mdSwipeBackActiveArea` (30) жест не
 * начинается.
 */
async function swipeBack(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x) =>
    cdp.send("Input.dispatchTouchEvent",
             { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: 500 }] });
  await touch("touchStart", 5);
  for (let x = 40; x <= 280; x += 60) await touch("touchMove", x);
  await touch("touchEnd", 280);
  await cdp.detach();
}

const stackDepth = (page) =>
  page.evaluate(() => {
    const snap = window.oneframework.snapshot();
    return snap.stacks[snap.active].length;
  });

/**
 * Прокрутка страницы стека -- та, которую помнит Framework7.
 *
 * Именно `.page-content`: `restoreScrollTopOnBack` снимает и ставит значение
 * только с него (`modules/router/router-class.js:656,683`), и спрашивать надо
 * ровно тот узел, о котором идёт спор.
 */
const scrollOf = (page, index) =>
  pageAt(page, index).locator(".page-content").first().evaluate((el) => el.scrollTop);

/**
 * Аппаратная кнопка «назад» Android.
 *
 * В браузере кнопку не нажать, но обработчик тот же самый: `web/src/main.jsx`
 * вешает его на событие `backButton` плагина `@capacitor/app`, а событие плагину
 * можно подать.
 */
async function androidBack(page) {
  await page.evaluate(() =>
    window.Capacitor.Plugins.App.notifyListeners("backButton", { canGoBack: false }));
}

/**
 * Ждать выхода из приложения -- поставить сторожа перед нажатием.
 *
 * «Вышло» -- это `App.exitApp()`, а в вебе он не реализован и отвергает
 * обещание, которое обработчик никуда не девает. Этот отказ и есть признак, и
 * ловится он глобально: подменить `exitApp` нечем -- `Capacitor.Plugins.App` это
 * `Proxy`, который своих же свойств не читает и всякий раз собирает метод заново
 * (`@capacitor/core/dist/index.js:157-172`).
 *
 * Перед сторожем плагин прогревается вызовом того же `exitApp`, и это не
 * лишнее: первый вызов подтягивает веб-подкладку плагина отдельным куском, и
 * пока тот едет, отказа нет вовсе -- проверка ждала его двадцать секунд и не
 * дожидалась. Прогретый отвечает в тот же такт, а сам прогрев заодно
 * доказывает, что признак работает: не отвергнись он здесь, ждать его после
 * нажатия было бы бессмысленно.
 */
async function watchExit(page) {
  await page.evaluate(async () => {
    if (!window.__exitWatched) {
      window.__exitWatched = true;
      window.addEventListener("unhandledrejection", (e) => {
        // Единственное неисполнимое, что приложение зовёт в вебе, -- выход.
        if (/not implemented on web/i.test(String(e.reason?.message || e.reason))) {
          window.__exited = true;
          e.preventDefault();
        }
      });
      await window.Capacitor.Plugins.App.exitApp().then(
        () => { throw new Error("exitApp в вебе не должен исполняться"); },
        () => {},
      );
    }
    // После прогрева, а не до: свой же отказ сторож бы и записал.
    window.__exited = false;
  });
}

const exited = (page) => page.evaluate(() => window.__exited === true);

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page error]", err.message));
});

test("30. возврат анимируется страницей с содержимым, а не опустевшей", async ({ page }) => {
  // Порядок был такой: рантайм снимает кадр -> React перерисовывает ->
  // `ScreenPage` не находит кадра и отдаёт пустую страницу -> и только потом
  // эффект зовёт `router.back()`. Framework7 анимировал честно, но анимировать
  // ему было уже нечего.
  //
  // Держит содержимое `store.outgoing` (`web/src/react/store.js`): снятое
  // дерево запоминается в тот же миг, когда подменяется снимок, и страница
  // рисуется им, пока маршрутизатор не отпустит её (`pageAfterOut`).
  //
  // Мерить надо в тот миг, когда переход начинается, а не после него: `после`
  // страницы уже нет в документе. Этот миг Framework7 называет `pageBeforeOut`.
  await boot(page);
  await openBoard(page, "Терминал");
  await openRow(page);

  const history = await routerHistory(page);
  expect(history).toEqual([await rootUrl(page), expect.stringMatching(FRAME_URL)]);
  const before = await pageAt(page, 1).innerText();
  expect(before.trim().length).toBeGreaterThan(0);

  await page.evaluate(() => {
    window.__outgoing = null;
    window.oneframework.f7.once("pageBeforeOut", (p) => {
      window.__outgoing = {
        url: p.route.url,
        text: p.el.textContent.trim().length,
        hasContent: !!p.el.querySelector(".page-content"),
      };
    });
  });
  await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
  await page.waitForTimeout(900);

  const outgoing = await page.evaluate(() => window.__outgoing);
  expect(outgoing).not.toBeNull();
  // Уходит именно запись, а не что-то ещё: без этого пустота ниже была бы
  // одинаково похожа и на поломку, и на промах селектором.
  expect(outgoing.url).toBe(history[1]);
  expect(outgoing.hasContent).toBe(true);
  expect(outgoing.text).toBeGreaterThan(0);
});

test("31. открытая запись показывается с начала, а не с прокрутки прошлой", async ({ page }) => {
  // Это тот самый прогон, которым находка «прокрутка не с той записи» была
  // опровергнута; почему так -- в `docs/research-framework7-native.md`, 1.3 (б).
  // Сторож сработал по назначению: адрес понёс запись, ключ ячейки
  // `scrollHistory` сменился с «эта глубина» на «этот кадр», и проверка
  // осталась зелёной уже на новом ключе.
  await page.setViewportSize({ width: 412, height: 320 }); // чтобы карточке было куда листаться
  await boot(page);
  await openBoard(page, "Терминал");

  await openRow(page, 0);
  await pageAt(page, 1).locator(".page-content").first()
    .evaluate((el) => { el.scrollTop = 120; });
  expect(await scrollOf(page, 1)).toBeGreaterThan(0);

  await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
  await page.waitForTimeout(900);
  await openRow(page, 1);

  expect(await routerHistory(page)).toEqual([
    await rootUrl(page), expect.stringMatching(FRAME_URL),
  ]);
  expect(await scrollOf(page, 1)).toBe(0);
});

test("33. одна и та же запись поверх себя -- разные адреса и оба перехода", async ({ page }) => {
  // `allowDuplicateUrls` у вида выключен (`components/view/view.js:55`), и
  // переход на адрес, равный текущему, Framework7 отменяет молча
  // (`navigate.js:417`). Пока адрес был номером глубины, совпасть он не мог
  // никогда; как только он понёс запись -- «открыть ту же запись поверх себя»
  // стало бы отменяемым переходом, а сведение стека ждало бы события, которого
  // не будет. Поэтому в адресе стоит ключ кадра, и вот чем это меряется.
  await boot(page);
  await openBoard(page, "Терминал");
  await openRow(page);
  await openAgain(page, 0);
  await page.waitForTimeout(900);

  expect(await stackDepth(page)).toBe(3);
  const history = await routerHistory(page);
  expect(history).toHaveLength(3);
  expect(new Set(history).size).toBe(3);
  // Путь у двух верхних один и тот же -- запись-то одна; различает их кадр.
  const path = (url) => url.split("?")[0];
  expect(path(history[2])).toBe(path(history[1]));
  // Переход не отменён, а состоялся: верхняя страница есть и она не пуста.
  await expect(pageAt(page, 2)).toBeVisible();
  expect((await pageAt(page, 2).innerText()).trim().length).toBeGreaterThan(0);
});

test("34. пустая половина широкого окна -- страница маршрутизатора", async ({ page }) => {
  // Заглушка была элементом, собранным руками и вставленным в вид мимо React
  // (`shell.jsx`, `detailPlaceholder`). Framework7 считает своими все `.page`
  // внутри вида -- и убирал её сам, посреди перехода; React, попробовав убрать
  // её следом, падал на `removeChild` и уносил всё дерево.
  //
  // Меряется не «есть ли текст», а чья это страница: узел появляется и
  // исчезает вместе с переходами, ошибок отрисовки нет, а мастер-страница
  // остаётся одна -- до починки возврат в широком окне оставлял в виде три
  // копии списка и мёртвую половину.
  const broken = [];
  page.on("pageerror", (err) => broken.push(err.message));
  await page.setViewportSize({ width: 1100, height: 900 });
  await boot(page);
  await openBoard(page, "Терминал");

  const empty = page.locator(".view-master-detail .pa-detail-empty");
  await expect(empty).toBeVisible();

  await openRow(page);
  await expect(empty).toHaveCount(0);
  await expect(pageAt(page, 1)).toBeVisible();

  await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
  await expect(empty).toBeVisible();
  expect(await page.locator(".view > .page.page-master").count()).toBe(1);
  expect(broken).toEqual([]);
});

test("35. отказ сторожа не оставляет маршрутизатор запертым", async ({ page }) => {
  // `routesBeforeLeave` -- то, чем перехватываются чужие входы в навигацию:
  // маршрутизатору отказывают, а «назад» уходит в рантайм. Но отказ на «назад»
  // Framework7 принимает в пустой обработчик (`back.js:519,525`), а флаг
  // `allowPageChange` перед опросом сторожей снят
  // (`process-route-queue.js:54`) -- вернуть его больше некому. Оболочка
  // возвращает его руками, и меряется это сразу после отказа.
  //
  // Сразу -- потому что дальше флаг поднимется сам: следующий переход опять
  // пройдёт через сторожа, а тот на согласии ставит флаг обратно
  // (`process-route-queue.js:56`). Проверка «нажать двадцать раз и посмотреть,
  // живо ли» такую поломку не увидела бы вовсе. Видно её тому, кто спрашивает
  // флаг до следующего перехода, -- например жесту «назад»: со снятым флагом
  // он просто не начинается (`swipe-back.js:32`).
  await boot(page);
  await openBoard(page, "Терминал");

  for (let i = 0; i < 3; i += 1) {
    await openRow(page, 0);
    expect(await stackDepth(page)).toBe(2);
    const ready = await page.evaluate(() => {
      const router = window.oneframework.f7.views.current.router;
      router.back();
      return router.allowPageChange;
    });
    expect(ready).toBe(true);
    await page.waitForTimeout(600);
    // Отказали маршрутизатору, а вернулись всё равно: «назад» ушло в рантайм,
    // и стек свёлся его порядком.
    expect(await stackDepth(page)).toBe(1);
    expect(await routerHistory(page)).toEqual([await rootUrl(page)]);
  }
});

test("36. адрес идёт за стеком: раздел, запись, возврат", async ({ page }) => {
  // Адрес -- проекция стека, а не его дубликат: пишется он на каждом снимке и
  // ровно из того, что в стеке стоит. Меряются оба конца -- и то, что запись
  // появилась в строке, и то, что возврат её оттуда убрал: односторонняя
  // проверка пропустила бы адрес, который растёт и не укорачивается.
  await boot(page);
  await openBoard(page, "Терминал");
  expect(await hash(page)).toBe("#!/Tasks/");

  const id = await firstId(page);
  await openRow(page);
  expect(await hash(page)).toBe(`#!/Tasks/TaskCard/${id}/`);

  await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
  await page.waitForTimeout(900);
  expect(await hash(page)).toBe("#!/Tasks/");
});

test("37. ссылка на запись открывает запись, а не список", async ({ page }) => {
  // Глубокая ссылка -- всегда холодная загрузка: рантайм поднимается с нуля,
  // корневые кадры разделов создаются заново, и достроить надо то, что глубже
  // корня. Именно это событие `goto` и делает.
  await boot(page);
  await openBoard(page, "Терминал");
  const id = await firstId(page);

  // Сначала адрес, потом перезагрузка -- и это не лишний шаг: переход на
  // адрес, отличающийся только частью после `#`, документа не меняет, и
  // разбирал бы его `popstate` (это проверка 38, не эта). Ссылка же приходит
  // на пустую вкладку, где ни рантайма, ни стека ещё нет.
  await page.goto(`./#!/Tasks/TaskCard/${id}/`);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.oneframeworkReady === "1",
                             { timeout: 90_000 });
  await page.waitForFunction(() => {
    const snap = window.oneframework.snapshot();
    return snap.stacks[snap.active].length === 2;
  }, { timeout: 20_000 });

  const stack = await activeStack(page);
  expect(stack.map((f) => f.view)).toEqual(["Tasks", "TaskCard"]);
  expect(stack[1].record_id).toBe(id);
  // Не только стек, но и экран: страница записи стоит и она не пуста.
  await expect(pageAt(page, 1)).toBeVisible();
  expect((await pageAt(page, 1)).innerText).not.toBe("");
  expect(await routerHistory(page)).toEqual([
    await rootUrl(page), expect.stringMatching(FRAME_URL),
  ]);
});

test("38. «назад» браузера снимает кадр, а «вперёд» возвращает", async ({ page }) => {
  // Кнопка браузера -- третий вход в навигацию, и он тоже разворачивается в
  // событие рантайма: `popstate` -> `goto`. Маршрутизатор при этом двигают не
  // из истории, а из стека -- как и всегда.
  await boot(page);
  await openBoard(page, "Терминал");
  await openRow(page);
  expect(await stackDepth(page)).toBe(2);

  await page.goBack();
  await page.waitForTimeout(900);
  expect(await stackDepth(page)).toBe(1);
  expect(await hash(page)).toBe("#!/Tasks/");
  expect(await routerHistory(page)).toEqual([await rootUrl(page)]);

  await page.goForward();
  await page.waitForTimeout(900);
  expect(await stackDepth(page)).toBe(2);
  expect(await routerHistory(page)).toHaveLength(2);
});

test("44. стрелка «назад» в разделённом окне возвращает, а не молчит", async ({ page }) => {
  // Стрелку рисуем мы, а нажатие ловил Framework7 сам, по классу `back` -- и в
  // разделённом окне оно не делало ничего: `router.back()` с карточки на
  // мастера не идёт вовсе (`skipMaster`, разобрано у `BackLink` в
  // `web/src/react/screen.jsx`). То есть на планшете стрелка была нарисована и
  // мертва, а ни одна проверка этого не видела: узкому окну разница между
  // «нажатие ушло в рантайм» и «нажатие ушло в маршрутизатор» не видна вовсе,
  // там работают оба порядка. Отсюда и ширина окна здесь, и палец: событием
  // `back` меряется другое (проверка 34), оно приходит уже после стрелки.
  await page.setViewportSize({ width: 1100, height: 900 });
  await boot(page);
  await openBoard(page, "Терминал");
  await openRow(page);
  expect(await stackDepth(page)).toBe(2);

  await pageAt(page, 1).locator(".link.back").click();
  await page.waitForTimeout(900);

  expect(await stackDepth(page)).toBe(1);
  // Вернулись на разделённый корень -- список слева и пустая половина справа, а
  // не «страница пропала»: у маршрутизатора на корне широкого окна две страницы.
  expect(await routerHistory(page)).toEqual([await rootUrl(page), EMPTY_URL]);
  await expect(page.locator(".view-master-detail .pa-detail-empty")).toBeVisible();
});

test("43. снятый кадр отпускается -- и после нажатия, и после жеста", async ({ page }) => {
  // Проверка 30 показывает, что снятое дерево доживает до конца перехода. Эта --
  // что оно там и кончается. Одного без другого мало: «держим» и «держим
  // навсегда» с экрана выглядят совершенно одинаково, а разница -- дерево целого
  // экрана в памяти на каждый возврат.
  //
  // Меряются оба порядка, и второй -- ради него всё. По нажатию оболочка водит
  // маршрутизатор сама и знает, когда страница ушла. По жесту -- наоборот:
  // `swipe-back.js:238-246` убирает страницу и только потом шлёт `routeChanged`,
  // которым мы о жесте узнаём и снимаем кадр. То есть ячейка заводится уже
  // после того, как страницы нет, и события, по которому её отпустить, больше
  // не будет. Поэтому отпускает не событие, а положение дел (`releaseOutgoing`).
  await boot(page);
  await openBoard(page, "Терминал");
  expect(await outgoing(page)).toEqual([]);

  await openRow(page);
  await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
  await page.waitForTimeout(900);
  expect(await stackDepth(page)).toBe(1);
  expect(await outgoing(page)).toEqual([]);

  await openRow(page);
  expect(await stackDepth(page)).toBe(2);
  await swipeBack(page);
  await page.waitForTimeout(900);
  // Жест дошёл до конца -- иначе пустая память ниже ничего бы не значила.
  expect(await stackDepth(page)).toBe(1);
  expect(await routerHistory(page)).toEqual([await rootUrl(page)]);
  expect(await outgoing(page)).toEqual([]);
});

test("32. аппаратная «назад» закрывает карточку, а не приложение", async ({ page }) => {
  // Карточка по-прежнему поднята над стеком `useState`'ом, а не маршрутом, --
  // и это здесь не мешает: кнопка спрашивает глубину у стека рантайма
  // (`main.jsx`), а в стеке карточка стоит. Пока спрашивали у маршрутизатора,
  // ответ был «одна страница» -- про карточку история не знает -- и кнопка
  // выходила из приложения.
  await boot(page);
  await openBoard(page, "Терминал");
  await page.locator(".pa-fab").first().click();

  const sheet = page.locator(".pa-sheet.modal-in");
  await expect(sheet).toBeVisible();
  // Две правды об одном и том же экране, и спрашивать надо ту, что глубже.
  expect(await stackDepth(page)).toBe(2);
  expect(await routerHistory(page)).toEqual([await rootUrl(page)]);
  // 39. Карточка -- состояние поверх места, а не место: адрес её не называет,
  // иначе ссылка звала бы в чужой наполовину заполненный черновик.
  expect(await hash(page)).toBe("#!/Tasks/");

  await watchExit(page);
  await androidBack(page);
  await expect(sheet).toBeHidden();
  expect(await stackDepth(page)).toBe(1);
  // Карточка закрылась -- и приложение при этом осталось: спрошено после того,
  // как переход уже состоялся, то есть отказу `exitApp` было где показаться.
  expect(await exited(page)).toBe(false);
});

test("42. аппаратная «назад» на корне разделённого экрана выходит", async ({ page }) => {
  // Обратная сторона той же правды. В широком окне корень раздела тянет за
  // собой пустую половину (`/empty/`), то есть у маршрутизатора на корне уже
  // две страницы -- и кнопка, судившая по его истории, снимала бы кадр,
  // которого нет: стек глубиной один, `pop` отказывает, и на планшете кнопка
  // просто перестала бы работать. Меряется поэтому в широком окне и на корне.
  await page.setViewportSize({ width: 1100, height: 900 });
  await boot(page);
  await openBoard(page, "Терминал");

  await expect(page.locator(".view-master-detail .pa-detail-empty")).toBeVisible();
  expect(await stackDepth(page)).toBe(1);
  expect(await routerHistory(page)).toEqual([await rootUrl(page), EMPTY_URL]);

  await watchExit(page);
  await androidBack(page);
  // Ожиданием, а не разовым вопросом: отказ `exitApp` приходит не в тот же
  // такт -- первый его вызов подтягивает веб-подкладку плагина.
  await expect.poll(() => exited(page), { timeout: 20_000 }).toBe(true);
  // И выход -- это выход, а не снятый кадр: стек остался прежним.
  expect(await stackDepth(page)).toBe(1);
});

test("46. отказ маршрутизатора прекращает сведение, а не досиживает двадцать ожиданий", async ({ page }) => {
  // Отказы у Framework7 молчаливые: и `navigate`, и `back` выходят на одной и
  // той же строке -- `if (!router.allowPageChange ...) return router`
  // (`navigate.js:380`, `back.js:308`), -- не бросив и не сказав ничего.
  // Сведение узнаёт об отказе единственным доступным способом: история не
  // двинулась, значит перехода не было, -- и прекращается. Не прекратись оно,
  // каждый следующий шаг досиживал бы свой сторожевой таймаут, и цикл занял бы
  // `SYNC_GUARD` * `TRANSITION_TIMEOUT_MS` -- около восемнадцати секунд.
  //
  // Меряется не время само по себе, а то, что от него зависит: очередь
  // сведения одна, и пока она занята отказом, приложение не показывает
  // следующего экрана вовсе. Поэтому вопрос задан экраном -- «карточка
  // открылась?», а не секундомером.
  //
  // Флаг заперт ровно так, как он запирается сам: разобрано у сторожа в
  // `web/src/react/shell.jsx` -- отказ на «назад» приходит в пустой обработчик
  // Framework7, и вернуть флаг оттуда некому.
  await boot(page);
  await openBoard(page, "Терминал");
  const before = await routerHistory(page);

  await page.evaluate(() => {
    const router = window.oneframework.f7.views.current.router;
    Object.defineProperty(router, "allowPageChange", {
      configurable: true, get: () => false, set: () => {},
    });
  });

  // Кадр рантайм положит, а маршрутизатор откажется его показать: стек и
  // история разойдутся, и это здесь не поломка, а условие опыта. Открывается
  // событием, а не пальцем: строка ведёт на страницу, которой теперь не быть,
  // и палец мерил бы заодно и это.
  await openAgain(page, 0);
  await expect.poll(() => stackDepth(page), { timeout: 5_000 }).toBe(2);
  expect(await routerHistory(page)).toEqual(before);

  // Следующее действие -- карточка: её показывает оболочка после того, как
  // сведение вернулось. Сведение, севшее на отказ, держало бы её невидимой все
  // восемнадцать секунд. Кнопка та же, что и в проверке 32, и лежит она на
  // корне -- страницы записи на экране так и не появилось.
  await page.locator(".page-current .pa-fab").first().click();
  await expect(page.locator(".pa-sheet.modal-in")).toBeVisible({ timeout: 6_000 });
});

/**
 * The multi-destination app: sections, per-section stacks, the two navigation
 * presentations, the table display and master detail.
 *
 * These run against a *kitchen sink* build. Whichever example is currently in
 * `dist/` is what the preview server serves, so the suite skips itself when a
 * different app is built -- `oneframework build web examples/kitchen/app.py` first.
 */

import { devices, expect, test } from "@playwright/test";

import { activeStack, APP_URL, bootApp, readRecord } from "./helpers.js";

const PHONE = { width: 412, height: 915 };
const DESKTOP = { width: 1280, height: 900 };

async function boot(page, size = PHONE) {
  await page.setViewportSize(size);
  // Своя копия этой проверки жила здесь прежде и отстала: общий помощник
  // научился отвечать «то ли это приложение» по манифесту, за секунды вместо
  // полутора минут, а копия продолжала ждать загрузки. Копия не устаревает
  // громко -- она просто перестаёт получать починки.
  await bootApp(page, "Kitchen");
  await expect(page.locator(".view.tab-active .pa-rows li:not(.list-group-title)").first()).toBeVisible();
}

/** Move to a destination the way a user does -- whichever control is showing. */
async function openScreen(page, label) {
  const panel = page.locator(`.panel-left .item-title:text-is("${label}")`);
  if (await panel.isVisible()) await panel.click();
  else await page.locator(`.tabbar .tab-link:has-text("${label}")`).click();
  await page.waitForTimeout(700);
}

const activeRows = (page) => page.locator(".view.tab-active .pa-rows li:not(.list-group-title)");
const activePages = (page) => page.locator(".view.tab-active .page");

/** Open the first record of the visible list, the way a user does. */
async function openFirstRecord(page) {
  await activeRows(page).first().click();
  await page.waitForTimeout(900);
}

test.beforeEach(({ page }) => {
  page.on("pageerror", (err) => console.error("[page error]", err.message));
});

test("1. every module contributes a destination to the tab bar", async ({ page }) => {
  await boot(page);
  const labels = await page.locator(".tabbar .tabbar-label").allTextContents();
  expect(labels).toEqual(["Задачи", "Каталог", "Связи", "Виджеты", "Данные"]);
});

test("2. each destination has its own view and its own stack", async ({ page }) => {
  await boot(page);
  // `.framework7-root` is the element framework7-react mounts on -- the app
  // frame Framework7 owns, and the parent every destination's view hangs from.
  await expect(page.locator(".framework7-root > .views > .view")).toHaveCount(5);
  const stacks = await page.evaluate(
    () => Object.keys(window.oneframework.snapshot().stacks).sort(),
  );
  expect(stacks).toEqual(["BigData", "Board", "Catalog", "Contacts", "Widgets"]);
});

test("3. switching sections leaves each one where the user left it", async ({ page }) => {
  await boot(page);
  await openFirstRecord(page);
  await expect(activePages(page)).toHaveCount(2);

  await openScreen(page, "Каталог");
  await expect(activePages(page)).toHaveCount(1);

  await openScreen(page, "Задачи");
  await expect(activePages(page)).toHaveCount(2);
});

test("4. back applies to the section on screen, not to the last one visited", async ({
  page,
}) => {
  await boot(page);
  await openFirstRecord(page);
  await expect(activePages(page)).toHaveCount(2);

  await openScreen(page, "Связи");
  await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
  await page.waitForTimeout(400);
  // Contacts was already at its root, so Tasks must be untouched.
  await openScreen(page, "Задачи");
  await expect(activePages(page)).toHaveCount(2);
});

test("5. the side panel pins itself open once the window is wide", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".views > .tabbar")).toBeVisible();
  await expect(page.locator(".panel-left")).not.toBeVisible();

  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(600);
  await expect(page.locator(".panel-left")).toBeVisible();
  await expect(page.locator(".panel-left [data-screen]")).toHaveCount(5);
  // Framework7 pins the panel but says nothing about the tab bar, and nothing
  // here overrides it, so both ways of switching sections stay on screen.
  await expect(page.locator(".views > .tabbar")).toBeVisible();
});

test("6. the panel switches sections too", async ({ page }) => {
  await boot(page, DESKTOP);
  await page.locator('.panel-left [data-screen="Contacts"]').click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.oneframework.renderer.active)).toBe("Contacts");
});

/**
 * Ожидание перехода знает свой маршрутизатор.
 *
 * Разделов несколько -- значит и маршрутизаторов несколько, а `f7` над ними
 * один: события страниц всплывают с роутера на вид и с вида на приложение
 * (`shared/events-class.js`, `eventsParents`). Ожидание, подписанное на
 * приложение, разрешило бы первое `pageAfterOut` откуда угодно и приняло бы
 * чужой переход за свой. Меряется от этого не подписка, а последствие: сведение
 * делает следующий шаг посреди играющей анимации, та обрывается, и страница,
 * которую Framework7 убирает по её концу (`back.js:263-265`, `removePage` в
 * `afterAnimation`), остаётся в виде. Стек говорит «один кадр», на экране две
 * страницы -- и вторая та, которую человек уже закрыл.
 *
 * Соседний раздел здесь не анимируется, а *говорит* то, что говорит по концу
 * своего перехода: у скрытой вкладки CSS-переходов нет, и настоящего
 * `transitionEnd` от неё не дождаться. Событие подано его собственным
 * роутером -- ровно то, что придёт от него в приложении.
 */
test("24. a neighbour section's page event is not our transition", async ({ page }) => {
  await boot(page);
  // Три кадра, а не два: проверяется второй шаг сведения -- тот, что попадает
  // на ещё играющую анимацию первого. На одном возврате второго шага нет.
  const target = await activeRows(page).first().evaluate((li) => ({
    type: "open",
    list_id: li.closest("[data-list-id]").dataset.listId,
    record_id: li.dataset.id,
  }));
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate((t) => window.oneframework.dispatch(t), target);
    await page.waitForTimeout(800);
  }
  expect((await activeStack(page)).length).toBe(3);
  await expect(activePages(page)).toHaveCount(3);

  // Сосед подаёт своё событие в тот миг, когда наш возврат только начался:
  // `pageBeforeOut` -- начало анимации ухода (`back.js:250`), её конец придёт
  // лишь через `pageAfterOut`, и всё это время ожидание уязвимо.
  await page.evaluate(() => {
    const here = document.querySelector(".view.tab-active").f7View;
    const other = window.oneframework.f7.views.find((v) => v !== here);
    here.router.once("pageBeforeOut", () => {
      other.router.emit("pageAfterOut", { el: null, route: { query: {} } });
    });
  });

  // Два «назад» подряд -- то же, что двойное нажатие пальцем: первое сведение
  // ещё анимируется, второе уже стоит в очереди.
  await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
  await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
  await page.waitForTimeout(2000);

  expect((await activeStack(page)).length).toBe(1);
  // Историю маршрутизатора сведение доводит до стека и в поломке -- расходится
  // документ. Поэтому судит здесь он, а история спрошена опорой: разойдись и
  // она, поломка была бы другая, и одной проверки на них двоих не хватило бы.
  expect(await page.evaluate(
    () => document.querySelector(".view.tab-active").f7View.router.history.length)).toBe(1);
  await expect(activePages(page)).toHaveCount(1);
});

test("7. a table list is rows on a phone and a table where the columns fit", async ({
  page,
}) => {
  await boot(page);
  await openScreen(page, "Каталог");
  await expect(page.locator(".view.tab-active .pa-table")).toBeHidden();
  await expect(activeRows(page).first()).toBeVisible();

  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(800);
  const table = page.locator(".view.tab-active .pa-table");
  await expect(table).toBeVisible();
  await expect(table.locator("thead th")).toHaveCount(8);
  await expect(table.locator("thead th").nth(0)).toHaveText("Товар");
  expect(await table.locator("tbody tr").count()).toBeGreaterThan(5);
});

test("8. a cell in the table edits the record", async ({ page }) => {
  await boot(page, DESKTOP);
  await openScreen(page, "Каталог");
  const row = page.locator(".view.tab-active .pa-table tbody tr").first();
  const id = await row.getAttribute("data-id");
  const before = await readRecord(page, "Product", id);
  // the stock column, by its heading -- a Rating renders as a stepper too
  const stock = await page.evaluate(() =>
    [...document.querySelectorAll(".view.tab-active .pa-table thead th")]
.findIndex((th) => th.textContent === "Остаток"),
  );
  await row.locator("td").nth(stock).locator(".stepper-button-plus").click();
  await page.waitForTimeout(700);
  const after = await readRecord(page, "Product", id);
  expect(after.stock).toBe(before.stock + 1);
});

test("9. a wide window opens a record beside the list, not over it", async ({ page }) => {
  await boot(page, DESKTOP);
  await activeRows(page).first().click();
  await page.waitForTimeout(900);
  await expect(page.locator(".view.tab-active")).toHaveClass(/view-master-detail/);
  // both halves on screen: the list is still there, the record is next to it
  await expect(page.locator(".view.tab-active .page-master")).toBeVisible();
  await expect(page.locator(".view.tab-active .page-master-detail")).toBeVisible();
});

test("10. with nothing selected the detail half says so", async ({ page }) => {
  await boot(page, DESKTOP);
  await expect(page.locator(".view.tab-active .pa-detail-empty")).toBeVisible();
  await activeRows(page).first().click();
  await page.waitForTimeout(900);
  await expect(page.locator(".view.tab-active .pa-detail-empty")).toHaveCount(0);
});

test("11. a table screen opts out of the split", async ({ page }) => {
  await boot(page, DESKTOP);
  await openScreen(page, "Каталог");
  await expect(page.locator(".view.tab-active")).not.toHaveClass(/view-master-detail/);
});

test("12. a module ships its own widget and its own stylesheet", async ({ page }) => {
  await boot(page);
  const pill = page.locator(".view.tab-active .tasks-pill").first();
  await expect(pill).toBeVisible();
  // the class comes from the module's JS, the colour from the module's CSS
  expect(await pill.getAttribute("data-state")).toBeTruthy();
  expect(
    await page.evaluate(() => !!document.querySelector('style[data-module*="widgets.css"]')),
  ).toBe(true);
});

test("13. tabs inside a record show one page at a time", async ({ page }) => {
  await boot(page);
  await openFirstRecord(page);
  const links = page.locator(".view.tab-active .page-current .pa-tabs__bar .tab-link");
  await expect(links).toHaveCount(3);
  await links.nth(1).click();
  await page.waitForTimeout(400);
  await expect(links.nth(1)).toHaveClass(/tab-link-active/);
  const visible = await page.evaluate(
    () =>
      [...document.querySelectorAll(".view.tab-active .page-current .pa-tabs__panes > .tab")]
.filter((el) => el.classList.contains("tab-active")).length,
  );
  expect(visible).toBe(1);
});

test("14. a Many2many links and unlinks and survives a reload", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Связи");
  await openFirstRecord(page);
  await page
.locator(".view.tab-active .page-current .pa-tabs__bar .tab-link")
.nth(1)
.click();
  await page.waitForTimeout(500);

  const CHIPS = ".view.tab-active .page-current .pa-field .pa-chips .pa-chip";
  const linked = page.locator(`${CHIPS}.is-active`);
  const before = await linked.count();
  await page.locator(`${CHIPS}:not(.is-active)`).first().click();
  await expect(linked).toHaveCount(before + 1);

  await page.evaluate(() => window.oneframework.flush());
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.oneframeworkReady === "1", {
    timeout: 90_000,
  });

  // Asked of the screen rather than of the link table underneath it: the join
  // has no record of its own to read by key, and what is being tested is that
  // the link came back -- which is exactly what the record on screen says.
  //
  // Открывать запись заново не нужно: адрес несёт раздел и запись
  // (`web/src/address.js`), и перезагрузка возвращает туда же, где были. Ждём
  // именно этого -- иначе вкладку ниже пришлось бы искать на списке.
  await page.waitForFunction(() => {
    const snap = window.oneframework.snapshot();
    return snap.stacks[snap.active].length === 2;
  }, { timeout: 20_000 });
  await page
.locator(".view.tab-active .page-current .pa-tabs__bar .tab-link")
.nth(1)
.click();
  await expect(linked).toHaveCount(before + 1);
});

test("15. a One2many counts the records that point back", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Связи");
  await openFirstRecord(page);
  await page
.locator(".view.tab-active .page-current .pa-tabs__bar .tab-link")
.nth(1)
.click();
  await page.waitForTimeout(500);
  // The inline related list is gone -- neither platform has one as a field
  // widget -- so the relation reports itself as a Framework7 badge.
  const badge = page.locator(".view.tab-active .page-current .badge").first();
  await expect(badge).toBeVisible();
  expect(Number(await badge.textContent())).toBeGreaterThan(0);
});

test("16. a long list virtualises and pages in more as it scrolls", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Данные");
  const content = page.locator(".view.tab-active .page-current .page-content");
  await content.evaluate((el) => el.scrollTo(0, 4000));
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => {
    const list = window.oneframework.renderer.lastSnapshot.stacks.BigData[0].children.find(
      (n) => n.type === "list",
    );
    return { loaded: list.count, dom: document.querySelectorAll(".view.tab-active .pa-rows li:not(.list-group-title)").length };
  });
  expect(state.loaded).toBeGreaterThan(60);
  expect(state.dom).toBeLessThan(state.loaded);
});

test("17. a warm start keeps the module's widget, its stylesheet and its data", async ({
  page,
}) => {
  // Only the first launch installs the database the build shipped; every one
  // after it finds it in place. What that distinction is guarding is the pair
  // of things that are not in the heap and never were: a module's own assets,
  // which travel in the build manifest, and the demo data, which is seeded once
  // and would be visible twice over if it ran again.
  await boot(page);
  expect(await page.evaluate(() => window.oneframework.host.fresh)).toBe(true);

  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.oneframeworkReady === "1", {
    timeout: 90_000,
  });
  expect(await page.evaluate(() => window.oneframework.host.fresh)).toBe(false);

  const state = await page.evaluate(() => ({
    scripts: window.oneframework.host.moduleScripts().length,
    styles: window.oneframework.host.moduleStyles().length,
    styleTags: document.querySelectorAll("style[data-module]").length,
  }));
  expect(state).toEqual({ scripts: 1, styles: 1, styleTags: 1 });
  // the widget the module registers, still rendering rather than falling back
  await expect(page.locator(".view.tab-active .tasks-pill").first()).toBeVisible();
});

/* ---------------------------------------------------------------------------
 * Framework7 components the DSL reaches for without any markup of its own.
 * ------------------------------------------------------------------------ */

test("18. Accordion folds a group away and Framework7 opens it back", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Виджеты");
  await openFirstRecord(page);
  await page.locator(".view.tab-active .pa-tabs__bar .tab-link:has-text('Время')").click();

  const item = page.locator(".view.tab-active .accordion-item").first();
  await expect(item).toBeVisible();
  // closed to begin with: the class Framework7 toggles is not there yet
  await expect(item).not.toHaveClass(/accordion-item-opened/);
  await item.locator(".item-link").click();
  await expect(item).toHaveClass(/accordion-item-opened/);
});

test("19. help= becomes a Framework7 Tooltip, created from the markup", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Виджеты");
  await openFirstRecord(page);
  await page.locator(".view.tab-active .pa-tabs__bar .tab-link:has-text('Время')").click();

  const tip = page.locator(".view.tab-active [data-tooltip]").first();
  await expect(tip).toHaveAttribute("data-tooltip", /Picker/);
  // the class is the request; the instance proves Framework7 answered it
  expect(await tip.evaluate((el) => !!el.f7Tooltip)).toBe(true);
});

test("20. a Time field asks for the Picker and gets Framework7's wheel", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Виджеты");
  await openFirstRecord(page);
  await page.locator(".view.tab-active .pa-tabs__bar .tab-link:has-text('Время')").click();

  // two fields ask for a Picker; the one on this tab is the visible one
  const input = page.locator(".view.tab-active input.pa-picker:visible").first();
  await input.click();
  await expect(page.locator(".sheet-modal.picker, .picker.picker-sheet, .picker").first()).toBeVisible();
  await expect(page.locator(".picker-column").first()).toBeVisible();
});

test("21. display=\"timeline\" renders Framework7's Timeline, one item per record", async ({
  page,
}) => {
  await boot(page);
  await openScreen(page, "Связи");
  const items = page.locator(".view.tab-active .timeline .timeline-item");
  await expect(items.first()).toBeVisible();
  expect(await items.count()).toBeGreaterThan(1);
  // the first cell is the moment, formatted by Intl rather than printed raw
  const when = await items.first().locator(".timeline-item-date").textContent();
  expect(when.trim()).not.toMatch(/T\d\d:\d\d/);
  expect(when.trim().length).toBeGreaterThan(0);
});

test("22. index=True gives the long list Framework7's List Index", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Данные");
  const index = page.locator(".view.tab-active .list-index").first();
  await expect(index).toBeAttached();
  expect(await index.evaluate((el) => !!el.f7ListIndex)).toBe(true);
});

test("23. navigating in and out leaves nothing of the page behind", async ({ page }) => {
  // The one thing a renderer can get wrong without ever showing it. With
  // `stackPages: false` Framework7 takes a popped page out of the document, but
  // whatever was built *against* its elements -- Calendar, Picker, ColorPicker,
  // Autocomplete, PhotoBrowser, the tooltips, and the scroll listener the long
  // list needs -- is not in the document, and nothing takes it out. It costs
  // one leak per step of navigation, and the only sign of it is an app that
  // grows heavier the longer it is used.
  //
  // What is countable from outside is the shape of it: Framework7 keeps its
  // app-level listeners in one place, and pages are elements. Both must be flat
  // across navigation -- a component built against a page and never destroyed
  // shows up in one or the other.
  //
  // Measured against the renderer this replaced: 183 listeners at rest, 233
  // after five more rounds. Ten per step of navigation, without bound.
  await boot(page);
  await openScreen(page, "Виджеты");

  const probe = () =>
    page.evaluate(() => ({
      listeners: Object.values(window.oneframework.f7.eventsListeners)
.reduce((total, handlers) => total + handlers.length, 0),
      pages: document.querySelectorAll(".page").length,
    }));
  // `void` не украшение. `dispatch` отдаёт обещание, Playwright его ждёт, а
  // сведение кадра рвёт цепочку -- обещание собирает сборщик мусора, и
  // проверка падает с «Resulting promise was garbage collected», не дойдя до
  // самого замера. Отсюда и была её шаткость: падало не то, что она стережёт.
  // Нажатие «назад» -- действие, а не вопрос; ответа у него никто не спрашивал.
  const openAndBack = async (times) => {
    for (let i = 0; i < times; i += 1) {
      await activeRows(page).first().click();
      await page.waitForTimeout(700);
      await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(600);
  };

  // The first rounds are the warm-up: they are what puts the record screen's
  // own pieces in place. Everything after them must cost nothing.
  await openAndBack(2);
  const settled = await probe();
  await openAndBack(5);
  expect(await probe()).toEqual(settled);
});

/* ---------------------------------------------------------------------------
 * Виджеты, которые Framework7 рисует своей составляющей React, а не нашей
 * строкой классов.
 *
 * Каждая проверка держит то, что при таком переходе уезжает молча: разметку,
 * живой экземпляр и -- главное -- наши параметры в нём. Составляющие F7
 * защищены сторожем `if (el.f7Stepper) return el.f7Stepper`, поэтому при двух
 * заводчиках побеждает не тот, кто знает про поле, а тот, кто успел первым, и
 * `max` рейтинга молча становится умолчанием в сотню.
 * ------------------------------------------------------------------------ */

const SAMPLE = ".view.tab-active .page-current ";

/** Экран «Виджеты», запись «Полный образец», нужная вкладка внутри неё. */
async function openSample(page, tabLabel) {
  await boot(page);
  await openScreen(page, "Виджеты");
  const row = activeRows(page).filter({ hasText: "Полный" });
  const id = await row.getAttribute("data-id");
  await row.locator(".pa-title").click();
  await page.waitForTimeout(900);
  await page.locator(`${SAMPLE}.pa-tabs__bar .tab-link:has-text('${tabLabel}')`).click();
  await page.waitForTimeout(500);
  return { id, record: await readRecord(page, "Sample", id) };
}

test("25. an icon is one <i> carrying the ligature, the box and aria-hidden", async ({ page }) => {
  await boot(page);
  const icon = page.locator(".tabbar .tab-link", { hasText: "Виджеты" }).locator("i");
  await expect(icon).toHaveClass(/(^|\s)icon(\s|$)/);
  await expect(icon).toHaveClass(/material-icons/);
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  // Имя глифа едет текстом -- лигатурой, а не разметкой изнутри.
  await expect(icon).toHaveText("palette");
  // Размер задан на месте: у глифа нет ни класса размера, ни таблицы размеров.
  expect(await icon.evaluate((el) => [el.style.fontSize, el.style.width, el.style.height]))
.toEqual(["24px", "24px", "24px"]);
});

test("26. a stepper carries the field's own bounds, not Framework7 defaults", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Виджеты");
  const row = activeRows(page).filter({ hasText: "Полный" });
  const id = await row.getAttribute("data-id");
  const before = await readRecord(page, "Sample", id);

  const stepper = row.locator(".stepper");
  // Rating(maximum=5): умолчание Framework7 -- сотня, и разница видна только
  // по тому, остановится ли он на пятёрке.
  expect(await stepper.evaluate((el) => el.f7Stepper && el.f7Stepper.params.max)).toBe(5);
  // Значение стоит в разметке с первой отрисовки, а не дописано потом.
  await expect(stepper.locator("input")).toHaveAttribute("value", String(before.stars));
  // Печатать в поле нельзя, и это наш явный отказ от умолчания Framework7:
  // он поле открывает, а набранная цифра шла бы в запись с каждой клавишей --
  // мимо буфера, которым живёт весь прочий ввод.
  await expect(stepper.locator("input")).not.toBeEditable();

  await row.locator(".stepper-button-plus").click();
  await page.waitForTimeout(700);
  expect((await readRecord(page, "Sample", id)).stars).toBe(before.stars + 1);
});

test("27. a range carries our bubble and has exactly one creator", async ({ page }) => {
  const { id, record } = await openSample(page, "Числа");
  const range = page.locator(`${SAMPLE}.range-slider`).first();
  // `label` у Framework7 по умолчанию выключен: пузырёк над ползунком есть
  // ровно тогда, когда наш параметр доехал до составляющей.
  await expect(range).toHaveClass(/range-slider-label/);
  await expect(range.locator(".range-knob-label")).toHaveText(String(record.count));
  // Заводчик один. `range-slider-init` -- это второй, автоматический
  // (`range.js:44,49`): он знает только сам элемент, то есть завёл бы ползунок
  // без пузырька, а его же `pageBeforeRemove` убрал бы составляющую за спиной
  // React.
  await expect(range).not.toHaveClass(/range-slider-init/);
  // Границы сняты с самой составляющей, но отличает здесь прошедшее от
  // непрошедшего только значение: `count` -- Integer без `maximum`, то есть
  // просит ровно те 0 и 100, которые Framework7 и так держит умолчанием. А
  // значение у него по умолчанию ноль.
  expect(await range.evaluate((el) => [el.f7Range.min, el.f7Range.max, el.f7Range.value]))
.toEqual([0, 100, record.count]);

  // И обратный ход: событие приходит теперь доводом составляющей
  // (`onRangeChanged`), а не слушателем `range:changed` на элементе. Ни
  // разметка, ни экземпляр этого не покажут -- видно только по записи, в
  // которую ползунок дописал. Значение двигает сама составляющая, а не палец:
  // событие у них одно и то же (`range-class.js:503`), а палец до ползунка,
  // стоящего во вкладке, сейчас не доходит вовсе -- он мерил себя скрытым.
  await range.evaluate((el) => el.f7Range.setValue(42));
  await page.waitForTimeout(700);
  expect((await readRecord(page, "Sample", id)).count).toBe(42);
});

test("28. a gauge is plain SVG carrying our dial, not Framework7 defaults", async ({ page }) => {
  const { record } = await openSample(page, "Числа");
  const gauge = page.locator(`${SAMPLE}.gauge`).first();
  // Составляющей здесь нет вовсе -- значит и пересоздавать её на каждое
  // значение нечего.
  expect(await gauge.evaluate((el) => !!el.f7Gauge)).toBe(false);
  const svg = gauge.locator("svg.gauge-svg");
  // Каждая из четырёх цифр -- наша, и у каждой умолчание Framework7 другое:
  // 200 в поперечнике, 10 толщины, 31 кегля и чёрная дуга.
  await expect(svg).toHaveAttribute("width", "96px");
  await expect(svg.locator(".gauge-front-circle")).toHaveAttribute("stroke-width", "8");
  await expect(svg.locator(".gauge-front-circle")).toHaveAttribute("stroke", "var(--f7-theme-color)");
  await expect(svg.locator(".gauge-value-text")).toHaveAttribute("font-size", "18");
  // Со знаком: поле объявлено `Percent`, то есть `Float(unit="%")`, и единица
  // -- часть значения, а не украшение. Прежде здесь стояло голое «64», и это
  // была не мера, а закреплённая поломка: признак процента искался несуществу-
  // ющим типом `ftype === "percent"`, поэтому не находился никогда. Соседняя
  // проверка 29 всё это время ждала от полосы `64%` -- расхождение было видно
  // и тогда.
  await expect(svg.locator(".gauge-value-text")).toHaveText(`${record.done_pct}%`);
  // Длина дуги следует из поперечника и толщины -- значит их прочитали обе.
  const dash = await svg.locator(".gauge-front-circle").getAttribute("stroke-dasharray");
  expect(Number(dash)).toBeCloseTo(2 * Math.PI * (96 / 2 - 8 / 2), 6);
});

test("29. a progressbar is offset by exactly the percent it shows", async ({ page }) => {
  const { record } = await openSample(page, "Числа");
  const bar = page.locator(`${SAMPLE}.progressbar`).first();
  await expect(bar.locator("span")).toHaveAttribute(
    "style", new RegExp(`translate3d\\(${-100 + record.done_pct}%`),
  );
  await expect(page.locator(`${SAMPLE}.pa-progresswrap__value`)).toHaveText(`${record.done_pct}%`);
});

/**
 * Провести пальцем по элементу слева направо или наоборот.
 *
 * Настоящими событиями касания, а не мышью: перетаскивание переключателя
 * Framework7 живёт на `touchstart/touchmove/touchend`, и нажатием его не
 * подменить -- именно этого поведения и не было, пока составляющей не
 * заводилось вовсе.
 */
async function swipeAcross(locator, direction) {
  await locator.evaluate((el, dir) => {
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const from = dir === "right" ? r.left + 2 : r.right - 2;
    const to = dir === "right" ? r.right - 2 : r.left + 2;
    const at = (x) => {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
      return { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true };
    };
    el.dispatchEvent(new TouchEvent("touchstart", at(from)));
    el.dispatchEvent(new TouchEvent("touchmove", at((from + to) / 2)));
    el.dispatchEvent(new TouchEvent("touchmove", at(to)));
    el.dispatchEvent(new TouchEvent("touchend", at(to)));
  }, direction);
}

test("30. a toggle drags as well as taps, and both write the record", async ({ page }) => {
  const { id, record } = await openSample(page, "Выбор");
  expect(record.active).toBe(true);
  const toggle = page.locator(`${SAMPLE}.pa-toggle`);
  // Без экземпляра Framework7 переключатель отвечает на нажатие, но не тянется
  // пальцем -- половина поведения, которой не видно, пока не попробуешь.
  expect(await toggle.evaluate((el) => !!el.f7Toggle)).toBe(true);

  await swipeAcross(toggle, "left");
  await page.waitForTimeout(700);
  expect((await readRecord(page, "Sample", id)).active).toBe(false);

  await toggle.click();
  await page.waitForTimeout(700);
  expect((await readRecord(page, "Sample", id)).active).toBe(true);
});

test("31. a Boolean in a row is Framework7's small checkbox", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Виджеты");
  const row = activeRows(page).filter({ hasText: "Полный" });
  const id = await row.getAttribute("data-id");
  const before = await readRecord(page, "Sample", id);

  const box = row.locator(".pa-checkbox");
  await expect(box).toHaveClass(/(^|\s)checkbox(\s|$)/);
  expect(await box.evaluate((el) => el.tagName)).toBe("LABEL");
  await expect(box.locator("input[type=checkbox]")).toHaveJSProperty("checked", !!before.active);
  await expect(box.locator("i.icon-checkbox")).toHaveCount(1);

  await box.click();
  await page.waitForTimeout(700);
  expect((await readRecord(page, "Sample", id)).active).toBe(!before.active);
});

test("32. a clickable chip is an anchor: pointer cursor and keyboard reach", async ({ page }) => {
  const { id } = await openSample(page, "Выбор");
  const chip = page.locator(`${SAMPLE}.pa-chips .pa-chip[data-value="done"]`);
  await expect(chip).toHaveClass(/(^|\s)chip(\s|$)/);
  await expect(chip).toHaveClass(/chip-outline/);
  // Составляющая `<Chip>` из framework7-react рисует `div`, и с ним молча
  // уходят обе вещи ниже.
  //
  // Первая -- курсор-рука. Её фишке даёт правило `a`
  // (`framework7-bundle.css:235`); своего курсора у `.chip` нет вовсе. Замер
  // идёт без классов `device-*`, и это не подтасовка, а единственный способ
  // вообще увидеть разницу: на телефоне Framework7 красит указателем весь
  // документ (`.device-ios, .device-android { cursor: pointer }`, там же
  // строка 204), а сюита ходит Android'ом. Наследуется это до самой фишки, и
  // стрелку вместо руки получает только настольный браузер -- тот, где панель
  // раздела приколота и мышь есть.
  const cursor = await chip.evaluate((el) => {
    const html = document.documentElement;
    const device = [...html.classList].filter((c) => c.startsWith("device-"));
    html.classList.remove(...device);
    const value = getComputedStyle(el).cursor;
    html.classList.add(...device);
    return value;
  });
  expect(cursor).toBe("pointer");
  // ...а нажатие с клавиатуры -- сам якорь: он стоит в обходе, и Enter на нём
  // и есть click. `div` не сфокусировать, и палец остался бы единственным
  // способом выбрать.
  await chip.focus();
  expect(await chip.evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  expect((await readRecord(page, "Sample", id)).state).toBe("done");
  // Выбранная теряет контур и получает заливку -- этим она и отличается.
  await expect(chip).not.toHaveClass(/chip-outline/);
  await expect(chip).toHaveClass(/is-active/);
});

test("33. a relation tag is an outlined chip tinted by the record's own colour", async ({
  page,
}) => {
  await boot(page);
  await openScreen(page, "Связи");
  const tag = activeRows(page).first().locator(".pa-tag");
  // А вот здесь `div` составляющей и нужен: связь нажатий не ловит, значит ни
  // курсора, ни места в обходе клавишей ей не полагается -- в отличие от
  // выбираемой фишки выше.
  expect(await tag.evaluate((el) => el.tagName)).toBe("DIV");
  await expect(tag).toHaveClass(/(^|\s)chip(\s|$)/);
  await expect(tag).toHaveClass(/chip-outline/);
  // Цвет связанной записи идёт в собственные переменные контурной фишки, а не
  // в `color` -- оттуда его берут и рамка, и текст.
  const tint = await tag.evaluate((el) => el.style.getPropertyValue("--f7-chip-outline-border-color"));
  expect(tint).toMatch(/^#|^[a-z]+$/);
  expect(await tag.locator(".chip-label").textContent()).not.toBe("");
});

test("34. a segmented control draws its own highlight, exactly once", async ({ page }) => {
  const { id, record } = await openSample(page, "Выбор");
  const segmented = page.locator(`${SAMPLE}.segmented`).first();
  await expect(segmented).toHaveClass(/segmented-strong/);
  await expect(segmented.locator("> .segmented-highlight")).toHaveCount(1);
  // Подсветка идёт последней: она позиционируется по активной кнопке до неё.
  expect(await segmented.evaluate((el) => el.lastElementChild.className))
.toBe("segmented-highlight");
  // Кнопку берём по подписи, а не по «не выбранная»: после нажатия выбранной
  // становится она, и такой отбор указал бы уже на соседнюю.
  expect(record.state).not.toBe("draft");
  const draft = segmented.locator("button", { hasText: "Черновик" });
  await expect(draft).not.toHaveClass(/button-active/);
  await draft.click();
  await page.waitForTimeout(700);
  await expect(draft).toHaveClass(/button-active/);
  expect((await readRecord(page, "Sample", id)).state).toBe("draft");
});

test("35. a radio group is a Framework7 list, one item per choice", async ({ page }) => {
  const { id, record } = await openSample(page, "Выбор");
  const list = page.locator(`${SAMPLE}.list`).filter({ has: page.locator(".item-radio") });
  await expect(list).toHaveClass(/list-strong/);
  await expect(list).toHaveClass(/(^|\s)inset(\s|$)/);
  const items = list.locator("ul > li > label.item-content.item-radio.item-radio-icon-start");
  await expect(items).toHaveCount(3);
  await expect(items.first().locator("i.icon.icon-radio")).toHaveCount(1);
  await expect(list.locator("input[type=radio]:checked")).toHaveValue(record.state);

  await items.last().click();
  await page.waitForTimeout(700);
  expect((await readRecord(page, "Sample", id)).state).toBe("done");
});

/* ---------------------------------------------------------------------------
 * Составляющие Framework7 в `nodes.jsx`: аккордеон, скребок, полоса поиска и
 * перестановка строк.
 *
 * Как и у виджетов, при переезде на составляющую молча уезжают три вещи:
 * разметка, живой экземпляр и наши параметры в нём. У скребка и полосы поиска
 * заводчика было *два* -- наш и авто-инит по классу `*-init`, -- а побеждает
 * тот, кто успел первым; проверки ниже держат то, что должно остаться после
 * того, как второй заводчик убран.
 * ------------------------------------------------------------------------ */

test("36. an accordion is a Framework7 list item that folds", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Виджеты");
  await activeRows(page).filter({ hasText: "Полный" }).locator(".pa-title").click();
  await page.waitForTimeout(900);
  await page.locator(`${SAMPLE}.pa-tabs__bar .tab-link:has-text('Время')`).click();
  await page.waitForTimeout(500);

  const list = page.locator(`${SAMPLE}.accordion-list`);
  await expect(list).toHaveClass(/list-strong/);
  await expect(list).toHaveClass(/(^|\s)inset(\s|$)/);
  // Сворачиваемый блок -- элемент списка, а не свой `div`: скругление и заливку
  // карточки даёт `.list.inset ul`, и вне `ul` его бы не было.
  const item = list.locator("ul > li.accordion-item");
  await expect(item).toHaveCount(1);
  const toggle = item.locator("> a.item-link > .item-content > .item-inner > .item-title");
  await expect(toggle).toHaveText("Сворачиваемый блок (Accordion)");
  // Якорь остаётся якорем: без `href` он выпадает из обхода клавишей, а
  // умолчание составляющей -- как раз `<a>` без него.
  expect(await item.locator("> a.item-link").getAttribute("href")).toBe("#");
  // Тело -- своя составляющая, и лежит оно рядом со ссылкой, а не в ней:
  // Framework7 меряет его высоту, чтобы раскрыть.
  const body = item.locator("> .accordion-item-content");
  await expect(body).toHaveCount(1);
  await expect(body.locator(".pa-field")).toHaveCount(2);

  await expect(item).not.toHaveClass(/accordion-item-opened/);
  expect(await body.evaluate((el) => el.offsetHeight)).toBe(0);
  await item.locator("> a.item-link").click();
  await page.waitForTimeout(700);
  await expect(item).toHaveClass(/accordion-item-opened/);
  expect(await body.evaluate((el) => el.offsetHeight)).toBeGreaterThan(0);
});

test("37. the list index is created once, and with our label", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Данные");
  const index = page.locator(`${SAMPLE}.list-index`);
  await expect(index).toHaveCount(1);
  // Класс авто-инита снят: по нему Framework7 заводил *второй* скребок на том
  // же элементе на `pageInit`, и чьи параметры доживали до экрана, решала
  // очерёдность, а не то, кто знает про список.
  await expect(index).not.toHaveClass(/list-index-init/);
  const made = await index.evaluate((el) => el.f7ListIndex && {
    label: el.f7ListIndex.params.label,
    listEl: el.f7ListIndex.params.listEl,
    items: el.f7ListIndex.$ul.find("li").length,
  });
  // `label` -- не умолчание: у Framework7 пузырёк с буквой под пальцем выключен.
  expect(made.label).toBe(true);
  // Наведён на *этот* список, а не на первый попавшийся: скребок читает его
  // заголовки и по ним прокручивает.
  expect(made.listEl).toBe(`#${await page.locator(`${SAMPLE}.pa-rows`).getAttribute("id")}`);
  expect(made.items).toBeGreaterThan(0);
});

test("38. the searchbar is Framework7's, minus the defaults we never had", async ({ page }) => {
  await boot(page);
  await openScreen(page, "Данные");
  const bar = page.locator(`${SAMPLE}.pa-searchbar`);
  // Корень остаётся `div`: умолчание составляющей -- `<form>`, и тогда Enter в
  // поле отправлял бы форму.
  expect(await bar.evaluate((el) => el.tagName)).toBe("DIV");
  await expect(bar).toHaveClass(/(^|\s)searchbar(\s|$)/);
  // Кнопки «отмена» у нас не было и нет, хотя составляющая рисует её по
  // умолчанию.
  await expect(bar.locator(".searchbar-disable-button")).toHaveCount(0);
  await expect(bar.locator("input[type=search]")).toHaveCount(1);
  expect(await bar.evaluate((el) => el.f7Searchbar?.params.customSearch)).toBe(true);

  // Затемнение было и до переезда -- его ставил авто-инит; выключать его
  // значило бы менять вид, поэтому оно оставлено умолчанием.
  const backdrop = page.locator(`${SAMPLE}.searchbar-backdrop`);
  await expect(backdrop).toHaveCount(1);
  await expect(backdrop).not.toHaveClass(/searchbar-backdrop-in/);
  await bar.locator("input").click();
  await page.waitForTimeout(500);
  await expect(backdrop).toHaveClass(/searchbar-backdrop-in/);

  // И буфер на месте: список отвечает на набранное.
  const before = await activeRows(page).count();
  await bar.locator("input").pressSequentially("100");
  await page.waitForTimeout(900);
  await expect(bar.locator("input")).toHaveValue("100");
  expect(await activeRows(page).count()).toBeLessThan(before);
});

test("39. a dragged row waits for the runtime instead of moving itself", async ({ page }) => {
  await boot(page);
  const list = page.locator(`${SAMPLE}.pa-rows`);
  await expect(list).toHaveAttribute("data-sortable-move-elements", "false");
  const order = () => activeRows(page).evaluateAll((els) => els.map((el) => el.dataset.id));
  const before = await order();

  // Настоящий жест, а не `dispatch`: переставляет строку в документе именно
  // Framework7, и выключение проверяется только пальцем. Порядок снимается в
  // том же `evaluate`, сразу за `touchend`, -- до следующего кадра, которому
  // ехать через воркер.
  const drop = await activeRows(page).evaluateAll((rows) => {
    const from = rows[0];
    const handle = from.querySelector(".sortable-handler");
    const r = handle.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y0 = r.y + r.height / 2;
    const y1 = rows[1].getBoundingClientRect().bottom - 4;
    const touch = (type, y, target) => {
      const t = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
      const empty = type === "touchend";
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: empty ? [] : [t], targetTouches: empty ? [] : [t], changedTouches: [t],
      }));
    };
    const top = () => Math.round(from.getBoundingClientRect().top);
    const startTop = top();
    touch("touchstart", y0, handle);
    touch("touchmove", y0 + 10, document);
    touch("touchmove", y1, document);
    const draggedTop = top();
    touch("touchend", y1, document);
    return {
      startTop, draggedTop, droppedTop: top(),
      order: [...from.parentElement.querySelectorAll("li[data-id]")].map((el) => el.dataset.id),
    };
  });
  expect(drop.order).toEqual(before);

  // И то же самое глазами, а не структурой: это цена запрета. Сдвиги
  // Framework7 снимает со всех строк раньше и без условий
  // (`sortable.js:146`), а переносить `<li>` ему теперь нельзя -- значит
  // брошенная строка зримо отскакивает туда, откуда её взяли, и ждёт кадра
  // там. Замер сторожит договор в обе стороны: тащили -- уехала, отпустили --
  // вернулась.
  expect(drop.draggedTop).toBeGreaterThan(drop.startTop);
  expect(drop.droppedTop).toBe(drop.startTop);

  // А кадр приезжает и переставляет -- жест дошёл до рантайма, а не пропал.
  await page.waitForTimeout(1200);
  expect(await order()).not.toEqual(before);
  expect([...(await order())].sort()).toEqual([...before].sort());
});

test("40. a select is a Framework7 list item, created exactly once", async ({ page }) => {
  const { id } = await openSample(page, "Выбор");
  const item = page.locator(`${SAMPLE}li.pa-select`);
  await expect(item).toHaveCount(1);

  // Разметка -- собственная у Framework7: `li > a.item-link.smart-select >
  // .item-content`, а не наш `a`, склеенный из ссылки и содержимого.
  await expect(item.locator("> a.item-link.smart-select > .item-content")).toHaveCount(1);
  await expect(item.locator("a")).toHaveAttribute("href", "#");

  // Заводчик один. Класса `smart-select-init` нет -- значит авто-инит
  // Framework7 (`smart-select.js:94-100`) на эту строку не придёт ни на
  // `pageInit`, ни на `tabMounted`, и `pageBeforeRemove` не уберёт живую
  // составляющую за спиной у React.
  await expect(page.locator(`${SAMPLE}.smart-select-init`)).toHaveCount(0);
  const params = await item.locator("a.smart-select").evaluate((el) => el.f7SmartSelect && {
    openIn: el.f7SmartSelect.params.openIn,
    closeOnSelect: el.f7SmartSelect.params.closeOnSelect,
    pageTitle: el.f7SmartSelect.params.pageTitle,
    setValueText: el.f7SmartSelect.params.setValueText,
  });
  // Меню, а не лист: выбор одного из немногих кончается самим выбором, и
  // крестик ему не нужен. Полосу с крестиком лист Framework7 рисует всегда, и
  // параметром её не убрать -- поэтому решается это способом открытия.
  expect(params).toEqual({
    openIn: "popover", closeOnSelect: true, pageTitle: "Selection", setValueText: true,
  });

  // И он работает пальцем: меню открывается, выбор доезжает до записи.
  await item.click();
  await page.waitForTimeout(700);
  const меню = page.locator(".popover.smart-select-popover.modal-in");
  await expect(меню).toBeVisible();
  expect(await меню.locator(".toolbar, .navbar, .sheet-close").count()).toBe(0);
  await меню.locator("label", { hasText: "Готово" }).click();
  await page.waitForTimeout(900);
  expect((await readRecord(page, "Sample", id)).state).toBe("done");
});

test("49. выбор нескольких -- лист, и крестик у него нужен", async ({ page }) => {
  // Вторая половина того же правила. Выбор нескольких нечем завершить, кроме
  // крестика: `closeOnSelect` при нём выключен -- иначе первая же метка
  // закрывала бы список. Значит лист здесь не остаток, а единственная форма,
  // в которой выбор вообще доводится до конца, и крестик в нём -- не лишний.
  await boot(page);
  await openScreen(page, "Связи");
  await activeRows(page).first().locator(".pa-title").click();
  await page.waitForTimeout(900);
  await page.locator(".page-current .pa-tabs__bar .tab-link:has-text('Связи')").click();
  await page.waitForTimeout(500);

  const строка = page.locator(".page-current li.pa-select").last();
  await expect(строка).toHaveCount(1);
  expect(await строка.locator("a.smart-select").evaluate(
    (el) => el.f7SmartSelect.params.openIn)).toBe("sheet");

  await строка.click();
  const лист = page.locator(".smart-select-sheet.modal-in");
  await лист.waitFor({ state: "visible" });
  expect(await лист.locator(".sheet-close").count()).toBe(1);
  // Отмечаем вторую метку -- и лист остаётся: выбор ещё не кончен.
  await лист.locator("label").nth(1).click();
  await page.waitForTimeout(400);
  await expect(лист).toBeVisible();
  await лист.locator(".sheet-close").click();
  await page.locator(".smart-select-sheet").waitFor({ state: "detached" });
});

/* --------------------------------------------------------------- крошки --
 *
 * Проверки 41-44 стояли на gtasks (`navigation.spec.js`) и переехали сюда,
 * когда gtasks сказал `crumbs = False`: цепочки там не осталось ни одной, и
 * мерить стало нечего. Kitchen -- витрина, вложенность у него настоящая, и
 * рядом стоят обе половины признака: карточка связи молчит и цепочку
 * получает, карточка заметки сказала `False` и не получает.
 */

const stackDepth = (page) =>
  page.evaluate(() => {
    const snap = window.oneframework.snapshot();
    return snap.stacks[snap.active].length;
  });

/** Открыть запись событием -- ту же, что уже открыта: так растёт третий кадр. */
const openAgain = (page, index = 0) =>
  page.evaluate((i) => {
    const li = document.querySelectorAll(".view.tab-active .pa-rows li[data-id]")[i];
    window.oneframework.dispatch({
      type: "open",
      list_id: li.closest("[data-list-id]").dataset.listId,
      record_id: li.dataset.id,
    });
  }, index);

const pageAt = (page, index) =>
  page.locator(`.view.tab-active .page[data-index="${index}"]`);

test("41. крошки -- проекция стека, и звено возвращает на свой уровень", async ({ page }) => {
  // У Framework7 крошки -- одна разметка: `components/breadcrumbs/` не делает
  // ничего, ни строчки поведения и ни слова про маршрутизатор. Значит цепочку
  // строим мы, и строим её из стека -- другого источника вложенности нет.
  //
  // Меряется цепочкой из трёх звеньев, а не из двух: на двух «сняли всё
  // лишнее» и «сняли один кадр» неотличимы, а событие `back_to` затем и
  // заведено, чтобы одно нажатие было одним снятием, а не тремя.
  await boot(page, DESKTOP);
  await openScreen(page, "Связи");

  // Корень раздела -- ещё не вложенность: показывать нечего, и подстроки бара
  // на странице нет вовсе.
  await expect(page.locator(".pa-crumbs")).toHaveCount(0);

  await openFirstRecord(page);
  await openAgain(page, 0);
  await page.waitForTimeout(900);
  expect(await stackDepth(page)).toBe(3);

  const crumbs = pageAt(page, 2).locator(".pa-crumbs .breadcrumbs-item");
  await expect(crumbs).toHaveCount(3);
  // Цепочка -- имена кадров, тех же самых и в том же порядке.
  const stack = await activeStack(page);
  expect(await crumbs.allInnerTexts()).toEqual(stack.map((f) => f.name));
  // Имя кадра записи -- имя самой записи, а не имя класса вида: по заголовкам
  // цепочка читалась бы «Связи / ContactDetail / ContactDetail».
  const contact = await readRecord(page, stack[1].model, stack[1].record_id);
  expect(stack[1].name).toBe(contact.name);
  // Последнее звено -- то, где стоим: помечено Framework7 и без ссылки, нажать
  // на «здесь» некуда.
  await expect(crumbs.nth(2)).toHaveClass(/breadcrumbs-item-active/);
  await expect(crumbs.nth(2).locator("a")).toHaveCount(0);
  // Страница знает, что у неё есть подстрока бара: без этого класса отступ
  // сверху не вырос бы и первая строка ушла бы под крошки.
  await expect(pageAt(page, 2)).toHaveClass(/page-with-subnavbar/);

  // Первое звено -- корень раздела, и снимаются оба кадра поверх него разом.
  await crumbs.nth(0).locator("a").click();
  await page.waitForTimeout(900);
  expect(await stackDepth(page)).toBe(1);
  await expect(page.locator(".pa-crumbs")).toHaveCount(0);
});

test("42. на телефоне крошек нет -- их место занимает стрелка «назад»", async ({ page }) => {
  // Ни Material, ни HIG крошек на телефоне не показывают, и причина
  // арифметическая: ярус под баром съедает те же полсотни пикселей, что и
  // строка списка, ради пути, который весь уже сказан стрелкой слева.
  // Проверка ставит вопрос прямо: та же вложенность, узкое окно.
  await boot(page);
  await openScreen(page, "Связи");
  await openFirstRecord(page);

  expect(await stackDepth(page)).toBe(2);
  await expect(pageAt(page, 1).locator(".link.back")).toBeVisible();
  await expect(page.locator(".pa-crumbs")).toHaveCount(0);
});

test("43. окно растянули -- крошки появились, и страница о них знает", async ({ page }) => {
  // Крошки заводятся не только рождением страницы, но и шириной окна, а класс
  // `page-with-subnavbar` Framework7 ставит один раз, на `pageInit`
  // (`components/subnavbar/subnavbar.js:7`). То есть у страницы, родившейся в
  // узком окне, ставить его на растягивании уже некому -- и без своего класса
  // отступ сверху не вырастает, первая строка списка уходит под цепочку.
  //
  // Проверка 41 этого не видит и увидеть не может: там окно широко с самого
  // начала, страница рождается с подстрокой бара, и класс ставит сам
  // Framework7 -- свой при этом ничего не меняет. Разница видна ровно в одном
  // порядке действий: сперва узко, потом широко.
  await boot(page);
  await openScreen(page, "Связи");
  await openFirstRecord(page);
  expect(await stackDepth(page)).toBe(2);
  await expect(page.locator(".pa-crumbs")).toHaveCount(0);
  await expect(pageAt(page, 1)).not.toHaveClass(/page-with-subnavbar/);

  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(900);

  // Та же страница, а не новая: `data-index` тот же, и переход её не пересоздал.
  await expect(pageAt(page, 1).locator(".pa-crumbs .breadcrumbs-item")).toHaveCount(2);
  await expect(pageAt(page, 1)).toHaveClass(/page-with-subnavbar/);
});

test("44. экран сказал `crumbs = False` -- цепочки нет там, где правило её нарисовало бы", async ({ page }) => {
  // Признак едет ключом кадра, как `dismiss`, и решает его объявление, а не
  // рендерер. Меряется парой на одной глубине и в одном окне, из одного и того
  // же раздела: карточка связи промолчала -- цепочка есть; карточка заметки
  // сказала `False` -- цепочки нет. Порознь любая половина прошла бы и от
  // того, что крошек не стало вовсе.
  await boot(page, DESKTOP);
  await openScreen(page, "Связи");

  await openFirstRecord(page);
  expect(await stackDepth(page)).toBe(2);
  await expect(page.locator(".pa-crumbs")).toHaveCount(1);

  await page.evaluate(() => void window.oneframework.dispatch({ type: "back" }));
  await page.waitForTimeout(700);

  // Вторым списком того же экрана идёт лента заметок -- она открывает NoteDetail.
  // Без `.page-current`: в разделённом окне текущая страница -- правая
  // половина, а лента стоит слева, в списке. Нажимается дата, а не строка
  // целиком: середина строки занята кнопкой удаления, и `click()` по строке
  // попадает ровно в неё.
  await page.locator(".view.tab-active .timeline-item .timeline-item-date").first().click();
  await page.waitForTimeout(900);

  expect(await stackDepth(page)).toBe(2);
  await expect(page.locator(".pa-crumbs")).toHaveCount(0);
});

test("45. переставленная строка встаёт под палец, а не на одну ниже", async ({ page }) => {
  // Номер Framework7 берёт среди всех соседей `<ul>` (`indexFrom =
  // $sortingEl.index()`), а первым там лежит не строка -- шапка отборов идёт
  // `li.list-group-title`. Рантайм считает по одним строкам, и без пересчёта
  // запись уезжала на одну ниже пальца.
  //
  // Проверка 39 этого не видит: она сторожит, что Framework7 не переставляет
  // `<li>` сам, и о порядке спрашивает только «стал другим». Другим он
  // становился и с промахом.
  await boot(page);
  // Экран «Данные»: его сортировка просит раздел (`section=True`), и заголовок
  // раздела лежит в том же `ul`, что строки. Промах возникает только там, где
  // в списке есть чужой `li`; шапка отборов, которая давала его прежде,
  // переехала над карточкой.
  await openScreen(page, "Данные");
  const before = await activeRows(page).evaluateAll((els) => els.map((el) => el.dataset.id));
  const чужие = await activeRows(page).first().evaluate(
    (el) => [...el.parentElement.children].filter((k) => k.dataset.id === undefined).length);
  expect(чужие).toBeGreaterThan(0);

  await activeRows(page).evaluateAll((rows) => {
    const from = rows[0];
    const handle = from.querySelector(".sortable-handler");
    const r = handle.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y0 = r.y + r.height / 2;
    const y1 = rows[1].getBoundingClientRect().bottom - 4;
    const touch = (type, y, target) => {
      const t = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
      const empty = type === "touchend";
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: empty ? [] : [t], targetTouches: empty ? [] : [t], changedTouches: [t],
      }));
    };
    touch("touchstart", y0, handle);
    touch("touchmove", y0 + 10, document);
    touch("touchmove", y1, document);
    touch("touchend", y1, document);
  });
  await page.waitForTimeout(1400);

  // Ровно обмен двух верхних, а не «первая уехала на третье место».
  const after = await activeRows(page).evaluateAll((els) => els.map((el) => el.dataset.id));
  expect(after.slice(0, 3)).toEqual([before[1], before[0], before[2]]);
});

test("47. датчик рисует долю, а не полное кольцо", async ({ page }) => {
  // `Percent` в объявлении -- это `Float(unit="%")`: своего типа у него нет и
  // на проводе не бывает. Рендерер же спрашивал `ftype === "percent"`, то есть
  // не попадал никогда: делителем оставалась единица, `64` упиралось в потолок
  // и рисовало полное кольцо с подписью «64».
  //
  // Меряется доля, а не картинка: Framework7 рисует дугу смещением штриха
  // (`stroke-dashoffset`) по полной окружности, и `1 - offset/C` -- это ровно
  // то, что видит глаз.
  await boot(page);
  await openScreen(page, "Виджеты");
  await activeRows(page).filter({ hasText: "Полный" }).first().click();
  await page.waitForTimeout(1200);

  const датчик = page.locator(".gauge").first();
  await expect(датчик.locator(".gauge-value-text")).toHaveText("64%");
  const доля = await датчик.locator(".gauge-front-circle").evaluate((el) => {
    const C = 2 * Math.PI * Number(el.getAttribute("r"));
    return 1 - parseFloat(getComputedStyle(el).strokeDashoffset) / C;
  });
  expect(доля).toBeGreaterThan(0.63);
  expect(доля).toBeLessThan(0.65);
});

/* ------------------------------------------------------------------ тема --
 *
 * Весь набор гоняется под Pixel 7 (`playwright.config.js`), то есть всегда под
 * `md`. Приложения больше не прибивают тему гвоздём -- `App(theme=...)` по
 * умолчанию `auto`, а Framework7 разрешает его как `device.ios ? 'ios' : 'md'`
 * (`getTheme()` в framework7-bundle.js). Значит на айфоне поедет вторая тема,
 * которую иначе не проверял бы никто.
 *
 * Это дым, а не сверка вида: доказывает, что под iOS приложение поднимается,
 * берёт вторую тему и рисует список, а не белый экран.
 */
test.describe("под айфоном", () => {
  // Не весь `devices["iPhone 13"]`: он несёт `defaultBrowserType: "webkit"`, а
  // смена браузера внутри группы запрещена -- Playwright требует новый рабочий
  // поток. Тему же решает одна строка агента: `device.ios` у Framework7 читает
  // именно её. Остальное берётся оттуда же ради честного окна и касаний.
  test.use({
    userAgent: devices["iPhone 13"].userAgent,
    viewport: devices["iPhone 13"].viewport,
    deviceScaleFactor: devices["iPhone 13"].deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  });

  test("46. на iOS берётся вторая тема, и экран поднимается", async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForFunction(
      () => document.documentElement.dataset.oneframeworkReady === "1", { timeout: 90_000 });
    test.skip((await page.evaluate(() => document.title)) !== "Kitchen", "dist/ holds a different app");

    expect(await page.evaluate(() => window.oneframework.f7.theme)).toBe("ios");
    await expect(page.locator("html")).toHaveClass(/\bios\b/);
    // Не белый экран: список на месте, и его строки -- те же наши строки.
    await expect(page.locator(".view.tab-active .pa-rowitem").first()).toBeVisible();
    await expect(page.locator(".tabbar .tab-link").first()).toBeVisible();
  });

  test("48. пустого слота в баре нет -- иначе он висит стеклянным кружком", async ({ page }) => {
    // Тема iOS красит группы бара стеклом: `.ios .navbar .left` получает
    // `backdrop-filter: blur(16px)` и белый фон. Слот, нарисованный «на
    // всякий случай», от этого перестаёт быть пустым местом и становится
    // белым кружком 44x44 в углу. Под `md` стекла нет, и увидеть это было
    // нельзя, пока Safari не начал получать вторую тему.
    //
    // Меряется пара: на корне слева класть нечего -- слота нет вовсе; в
    // открытой записи есть стрелка -- слот на месте. Порознь любая половина
    // прошла бы и от того, что слот пропал везде.
    await page.goto(APP_URL);
    await page.waitForFunction(
      () => document.documentElement.dataset.oneframeworkReady === "1", { timeout: 90_000 });
    test.skip((await page.evaluate(() => document.title)) !== "Kitchen", "dist/ holds a different app");

    await expect(page.locator(".view.tab-active .page-current .navbar .left")).toHaveCount(0);

    await page.locator(".view.tab-active .pa-rowitem").first().click();
    await page.waitForTimeout(900);
    const слева = page.locator(".view.tab-active .page-current .navbar .left");
    await expect(слева).toHaveCount(1);
    await expect(слева.locator("a.link.back")).toBeVisible();
  });
});

test("50. у нижней навигации пилюля под значком остаётся -- Material её и предписывает", async ({ page }) => {
  // Вторая половина того же правила. Одним классом `tabbar` Framework7 рисует
  // и бар вкладок сверху, и нижнюю навигацию. Пилюля (56x32, «50% rounded» у
  // Material; 64x32 у Framework7) -- указатель именно нижней, и гасить её тут
  // было бы поломкой, а не порядком. Гасится она только у бара сверху.
  await boot(page);
  const значок = page.locator(".toolbar.tabbar.toolbar-bottom .tab-link-active i.icon").first();
  await expect(значок).toHaveCount(1);
  const пилюля = await значок.evaluate((el) => {
    const s = getComputedStyle(el, "::before");
    return { фон: s.backgroundColor, ширина: s.width, непрозрачность: s.opacity };
  });
  expect(пилюля.ширина).toBe("64px");
  expect(пилюля.непрозрачность).toBe("1");
  expect(пилюля.фон).not.toBe("rgba(0, 0, 0, 0)");
});

/* ----------------------------------------- виджеты, построенные на элементе --
 *
 * Пять составляющих Framework7 не имеют класса `*-init` и строятся против
 * настоящего элемента: Calendar, ColorPicker, Autocomplete, Picker,
 * PhotoBrowser. Прежде из них была покрыта одна -- выбор колесом
 * (проверка 15). Остальные четыре меняли молча: разметку им собирал наш код
 * строкой, и обнаружить поломку было нечем.
 */

test("51. календарь открывается из поля и записывает выбранное", async ({ page }) => {
  const { id } = await openSample(page, "Время");
  // У календаря своего класса нет -- `boundInput` даёт ему пустой, -- поэтому
  // он отличается от колеса тем, что *не* `pa-picker`.
  const поле = page.locator(`${SAMPLE}input.pa-input:not(.pa-picker):visible`).first();
  await expect(поле).toHaveCount(1);
  await поле.click();
  // `.calendar` -- сам лист, а не что-то внутри него: Framework7 вешает оба
  // класса на один элемент (`sheet-modal calendar calendar-sheet modal-in`).
  await expect(page.locator(".calendar.modal-in").first()).toBeVisible();
  // Только из показанного месяца: Framework7 держит в дереве три -- прошлый,
  // текущий и следующий, -- и два из них лежат за краем.
  await page.locator(".calendar.modal-in .calendar-month-current"
    + " .calendar-day:not(.calendar-day-prev):not(.calendar-day-next)").nth(9).click();
  await page.waitForTimeout(900);
  expect((await readRecord(page, "Sample", id)).due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("52. выбиральщик цвета красит свою точку и пишет цвет в запись", async ({ page }) => {
  const { id } = await openSample(page, "Выбор");
  const точка = page.locator(`${SAMPLE}.pa-swatch`).first();
  await expect(точка).toHaveCount(1);
  // Точку красит сам ColorPicker (`targetElSetBackgroundColor`), а не мы.
  expect(await точка.evaluate((el) => getComputedStyle(el).backgroundColor))
.not.toBe("rgba(0, 0, 0, 0)");
  const было = (await readRecord(page, "Sample", id)).accent;

  await точка.click();
  const лист = page.locator(".color-picker.modal-in").first();
  await expect(лист).toBeVisible();
  await лист.locator(".color-picker-module-palette .color-picker-palette-value").nth(3).click();
  await page.waitForTimeout(900);
  const стало = (await readRecord(page, "Sample", id)).accent;
  expect(стало).toMatch(/^#[0-9a-fA-F]{6}$/);
  expect(стало.toLowerCase()).not.toBe(String(было).toLowerCase());
});

test("53. строка подсказки открывает страницу поиска Framework7", async ({ page }) => {
  // Autocomplete объявлен в модуле tasks витрины: `assignee(widget="autocomplete")`.
  await boot(page);
  await openScreen(page, "Задачи");
  await activeRows(page).first().locator(".pa-title").click();
  await page.waitForTimeout(900);
  await page.locator(".page-current .pa-tabs__bar .tab-link:has-text('Детали')").click();
  await page.waitForTimeout(600);
  const строка = page.locator(".page-current .tab-active li a.item-link.item-content")
.filter({ has: page.locator(".item-title", { hasText: "Исполнитель" }) }).first();
  await expect(строка).toHaveCount(1);
  await строка.click();
  await page.waitForTimeout(900);
  // Своей страницы он не рисует -- её рисует Framework7 по `openIn: "page"`.
  await expect(page.locator(".page-current .searchbar input").first()).toBeVisible();
});

test("54. картинка открывается смотрелкой на весь экран", async ({ page }) => {
  await openSample(page, "Файлы");
  // Смотрелка -- строка, а не сама картинка: `binary:browser` -- `boundRow`.
  // Открывается она только когда значение есть, поэтому в засев витрины
  // положена крошечная картинка.
  const строка = page.locator(`${SAMPLE}li a.item-link.item-content`)
.filter({ has: page.locator(".item-after", { hasText: /Открыть/ }) }).first();
  await expect(строка).toHaveCount(1);
  await строка.click();
  await page.waitForTimeout(900);
  await expect(page.locator(".photo-browser.modal-in, .photo-browser-popup.modal-in").first())
.toBeVisible();
});

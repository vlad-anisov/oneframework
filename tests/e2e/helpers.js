import { expect, test } from "@playwright/test";

/**
 * Every test gets a fresh browser context, so IndexedDB starts empty and the
 * demo seed runs again -- no manual database cleanup needed.
 */
export const APP_URL = "./";

/**
 * Загрузить приложение и убедиться, что собрано **это**.
 *
 * Сервер отдаёт то, что лежит в `dist/`, а там лежит собранное последним. Без
 * проверки сюита не пропускала бы себя, а падала бы на чужом приложении -- и
 * выглядело бы это как поломка, хотя собрали просто другой пример. Одно
 * описание на все сюиты: чем они дальше расходятся, тем больше «пропустилось,
 * потому что собрано другое» выглядит как «прошло».
 */
export async function bootApp(page, title) {
  await page.goto(APP_URL);

  // Сперва -- **дешёвый** вопрос: то ли это приложение вообще. Имя лежит в
  // манифесте PWA, записанном на сборке, и читается обычным `fetch` до всякой
  // загрузки. Раньше первым стояло ожидание готовности с потолком в 90 секунд,
  // и чужая сборка платила его на каждой проверке: двадцать три проверки --
  // полчаса ожидания вместо полутора минут работы. Хуже, что выглядело это
  // зависанием, а не пропуском: 21.08.2026 так и вышло, и настоящую поломку
  // (собранная база копила все примеры подряд) пришлось искать вручную.
  const собрано = await page
    .evaluate(async () => {
      const r = await fetch("./manifest.webmanifest");
      return r.ok ? (await r.json()).name : null;
    })
    .catch(() => null);
  test.skip(собрано !== null && собрано !== title,
            `dist/ holds a different app: ${собрано}`);

  await page.waitForFunction(() => document.documentElement.dataset.oneframeworkReady === "1", {
    timeout: 90_000,
  });
  // Заголовок ставит обработчик снимка, а признак готовности -- конец
  // загрузки, и порядок между ними не обещан ничем. Сравнивать заголовок
  // сразу -- значит иногда прочитать «oneframework» и тихо уйти в пропуск, а
  // пропуск в отчёте неотличим от «прошло», если смотреть на число зелёных.
  // Поэтому ждём заголовка, и пропускаем только если он так и не стал нашим.
  const свой = await page
    .waitForFunction((имя) => document.title === имя, title, { timeout: 10_000 })
    .then(() => true, () => false);
  test.skip(!свой, "dist/ holds a different app");
}

/** То же самое плюс первая строка списка -- умолчание сюиты todo. */
export async function boot(page, title = "Todo") {
  await bootApp(page, title);
  await waitReady(page);
}

export async function waitReady(page) {
  await page.waitForFunction(() => document.documentElement.dataset.oneframeworkReady === "1", {
    timeout: 90_000,
  });
  await expect(rows(page).first()).toBeVisible();
}

// The list header is an `li` of the same `ul` -- it belongs to the list, but
// it is not one of its rows.
export const rows = (page) =>
  page.locator(".pa-rows li:not(.list-group-title)");
export const titles = (page) => rows(page).locator(".pa-title");

export async function titleTexts(page) {
  return (await titles(page).allTextContents()).map((t) => t.trim());
}

export const tagChip = (page, value) =>
  page.locator(`.pa-chips .pa-chip[data-value="${value}"]`);
export const filterChip = (page, index) =>
  page.locator(`.pa-filters__chips .pa-chip[data-index="${index}"]`);
// Поле принадлежит составляющей Framework7, и своего класса на нём больше нет:
// `<Searchbar>` даёт классы корню, а вход внутри рисует сам.
export const searchInput = (page) => page.locator(".pa-searchbar input");
export const fab = (page) => page.locator(".pa-fab");
export const sortButton = (page) => page.locator(".pa-sortbtn");

export const rowByTitle = (page, text) =>
  page.locator(".pa-rows li:not(.list-group-title)").filter({ hasText: text });

/**
 * Выбор сортировки -- smart select Framework7, его собственный «выбери одно».
 *
 * Лист поднимает он сам, поэтому и класс его: `smart-select-sheet`. Нажимается
 * подпись -- указатель стоит слева, но подпись на месте в обеих темах.
 */
export async function chooseSort(page, label) {
  await sortButton(page).click();
  // Ждём открытия: у всплывающего меню есть ход, и до его конца строки в
  // дереве уже есть, а на экране ещё нет.
  const меню = page.locator(".popover.smart-select-popover.modal-in");
  await меню.waitFor({ state: "visible" });
  await меню.locator(".item-title", { hasText: label }).first().click();
  // И дождаться, пока меню уйдёт: у него есть ход, а его подложка всё это
  // время ловит нажатия -- второй вызов подряд иначе бьёт в неё.
  await page.locator(".popover").waitFor({ state: "detached" });
  await page.waitForTimeout(300);
}

export async function confirmDelete(page) {
  await page.locator(".dialog-button", { hasText: /Удалить|Delete/ }).click();
  await page.waitForTimeout(500);
}

/**
 * The render tree the screen is showing, without mutating anything.
 *
 * Read off the page rather than asked of the runtime: a "show me your state"
 * event would exist for the tests alone, and it would answer with what the
 * runtime would compute afresh rather than with what is actually drawn.
 */
export async function snapshot(page) {
  return page.evaluate(() => window.oneframework.snapshot());
}

/**
 * The stack of the destination on screen.
 *
 * There is one stack per destination, and `active` names the one being shown --
 * switching sections has to leave every other section where the user left it,
 * so a single `stack` would have nothing to be. Every read below goes through
 * here rather than reaching into the snapshot by hand.
 */
export async function activeStack(page) {
  const snap = await snapshot(page);
  return snap.stacks[snap.active];
}

export async function listNode(page) {
  const [screen] = await activeStack(page);
  return screen.children.find((c) => c.type === "list");
}

/**
 * One row straight out of SQLite, and the number of rows in a table.
 *
 * The database lives in the runtime worker -- OPFS holds its files
 * exclusively, so there is no second connection to open from the page. Both
 * go through the host, which asks the worker that owns it.
 */
export async function readRecord(page, model, id) {
  return page.evaluate(([m, i]) => window.oneframework.readRecord(m, i), [model, id]);
}

export async function countRecords(page, model) {
  return page.evaluate((m) => window.oneframework.countRecords(m), model);
}

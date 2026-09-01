import { expect, test } from "@playwright/test";

import {
  activeStack,
  boot,
  chooseSort,
  confirmDelete,
  countRecords,
  fab,
  filterChip,
  listNode,
  readRecord,
  rowByTitle,
  rows,
  searchInput,
  tagChip,
  titleTexts,
  waitReady,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page error]", err.message));
  await boot(page);
});

test("1-3. app loads with demo data and the default filter active", async ({ page }) => {
  await expect(page.locator(".navbar .title")).toHaveText("Todo");
  await expect(filterChip(page, 0)).toHaveClass(/is-active/);
  await expect(filterChip(page, 0)).toHaveText("Осталось");
  expect(await rows(page).count()).toBe(4);
  // Включённый отбор -- заливка, выключенный -- контур; фишка Framework7
  // различает их только этим классом, и «is-active» без снятого контура
  // выглядела бы ровно как выключенная.
  await expect(filterChip(page, 0)).not.toHaveClass(/chip-outline/);
  await expect(filterChip(page, 1)).toHaveClass(/chip-outline/);
  // Отбор нажимают, поэтому он остаётся якорем, а не `div`, каким его рисует
  // `<Chip>` из framework7-react: курсор-руку и место в обходе клавишей несёт
  // здесь только сам якорь -- у `.chip` ни того, ни другого нет. Чем это
  // кончается на настольном браузере, меряет проверка 32 в `kitchen.spec.js`;
  // тут довольно того, что элемент тот же.
  expect(await filterChip(page, 1).evaluate((el) => el.tagName)).toBe("A");
});

test("4. completed records are hidden by the default filter", async ({ page }) => {
  const visible = await titleTexts(page);
  expect(visible).not.toContain("Оплатить интернет");
  expect(visible).toContain("Купить молоко");
});

test("5. the 'Выполнено' filter shows only completed records", async ({ page }) => {
  await filterChip(page, 1).click();
  await expect(rows(page)).toHaveCount(2);
  expect(await titleTexts(page)).toEqual(
    expect.arrayContaining(["Оплатить интернет", "Прочитать книгу"]),
  );
});

test("6. search is reactive, case-insensitive and works on cyrillic", async ({ page }) => {
  await searchInput(page).fill("МОЛОКО");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Купить молоко");

  await searchInput(page).fill("");
  await expect(rows(page)).toHaveCount(4);
});

test("7-9. tag chips filter the list; 'Все' means UNSET, not NULL", async ({ page }) => {
  await expect(tagChip(page, "")).toHaveClass(/is-active/);
  expect(await rows(page).count()).toBe(4);

  const personal = page.locator('.pa-chips .pa-chip', { hasText: "Личное" });
  await personal.click();
  await expect(rows(page)).toHaveCount(2);
  expect(await titleTexts(page)).toEqual(
    expect.arrayContaining(["Позвонить в сервис", "Записаться к врачу"]),
  );

  await tagChip(page, "").click();
  await expect(rows(page)).toHaveCount(4);
});

test("10-11. sorts: manual order and created_at descending", async ({ page }) => {
  const manual = await titleTexts(page);
  expect(manual[0]).toBe("Купить молоко");

  await chooseSort(page, "Сначала новые");
  const newest = await titleTexts(page);
  expect(newest[0]).toBe("Записаться к врачу");
  expect(newest).not.toEqual(manual);

  await chooseSort(page, "По порядку");
  expect(await titleTexts(page)).toEqual(manual);
});

test("12-13. toggling completed persists and re-queries the list", async ({ page }) => {
  const row = rowByTitle(page, "Купить молоко");
  const id = await row.getAttribute("data-id");

  await row.locator(".pa-toggle").click();
  await expect(rowByTitle(page, "Купить молоко")).toHaveCount(0);

  expect((await readRecord(page, "TodoLine", id)).completed).toBe(true);

  await filterChip(page, 1).click();
  await expect(rowByTitle(page, "Купить молоко")).toHaveCount(1);
});

test("14-15. drag reorder rewrites sequence and survives a reload", async ({ page }) => {
  const before = await titleTexts(page);
  // Ключ записи -- строка (UUIDv7), а не число: два устройства без связи
  // обязаны выдавать разным записям разные ключи, и счётчик так не умеет.
  const ids = await rows(page).evaluateAll((els) => els.map((e) => e.dataset.id));

  // Framework7 owns the pointer gesture; the contract under test is that a
  // move expressed as record + from/to indices is what gets persisted.
  await page.evaluate(
    ([listId, recordId]) =>
      window.oneframework.dispatch({
        type: "reorder",
        list_id: listId,
        record_id: recordId,
        from: 2,
        to: 0,
      }),
    [(await listNode(page)).id, ids[2]],
  );

  await expect(rows(page).first()).toContainText(before[2]);
  expect((await readRecord(page, "TodoLine", ids[2])).sequence).toBe(10);

  await page.reload();
  await waitReady(page);
  expect((await titleTexts(page))[0]).toBe(before[2]);
});

test("16. tapping a row opens the Detail screen", async ({ page }) => {
  await rowByTitle(page, "Купить молоко").locator(".pa-title").click();
  await expect(page.locator(".page")).toHaveCount(2);
  await expect(page.locator(".page[data-index='1'] .title")).toHaveText("Купить молоко");
  await expect(
    page.locator(".page[data-index='1'] .pa-field__label").first(),
  ).toHaveText(/ЗАДАЧА/i);
});

test("17. toggling inside a row does not open the Detail", async ({ page }) => {
  await rowByTitle(page, "Купить молоко").locator(".pa-toggle").click();
  await page.waitForTimeout(600);
  await expect(page.locator(".page")).toHaveCount(1);
});

test("18. the row delete button does not open the Detail", async ({ page }) => {
  const row = rowByTitle(page, "Купить молоко");
  const id = await row.getAttribute("data-id");
  await row.locator(".pa-btn[data-action='delete']").click();
  await confirmDelete(page);

  await expect(page.locator(".page")).toHaveCount(1);
  await expect(rowByTitle(page, "Купить молоко")).toHaveCount(0);
  expect(await readRecord(page, "TodoLine", id)).toBeNull();
});

test("19-22. Detail edits text, description, relation and completed", async ({ page }) => {
  const row = rowByTitle(page, "Купить молоко");
  const id = await row.getAttribute("data-id");
  await row.locator(".pa-title").click();
  const detail = page.locator(".page[data-index='1']");

  await detail.locator("input.pa-input").first().fill("Купить кефир");
  await detail.locator("textarea.pa-textarea").fill("1 литр");
  await detail.locator("textarea.pa-textarea").blur();
  await page.waitForTimeout(700);

  let record = await readRecord(page, "TodoLine", id);
  expect(record.text).toBe("Купить кефир");
  expect(record.description).toBe("1 литр");

  // relation selector -> Framework7 SmartSelect popover: one choice out of a
  // few ends with the choice itself, so it opens as a menu, not as a sheet.
  await detail.locator(".pa-select").click();
  await page.waitForTimeout(500);
  await page
    .locator(".popover.smart-select-popover.modal-in label")
    .filter({ hasText: "Работа" })
    .first()
    .click();
  await page.waitForTimeout(900);
  record = await readRecord(page, "TodoLine", id);
  const workId = (await activeStack(page))[0].children[0].choices.find(
    (c) => c.display === "Работа",
  ).id;
  expect(record.tag).toBe(workId);

  await detail.locator(".pa-checkbox").click();
  await page.waitForTimeout(600);
  expect((await readRecord(page, "TodoLine", id)).completed).toBe(true);
});

test("23. Delete in the Detail removes the record and returns to the List", async ({ page }) => {
  const row = rowByTitle(page, "Купить молоко");
  const id = await row.getAttribute("data-id");
  await row.locator(".pa-title").click();
  await expect(page.locator(".page")).toHaveCount(2);

  await page.locator(".page[data-index='1'] .pa-btn[data-action='delete']").click();
  await confirmDelete(page);

  await expect(page.locator(".page")).toHaveCount(1);
  expect(await readRecord(page, "TodoLine", id)).toBeNull();
  await expect(rowByTitle(page, "Купить молоко")).toHaveCount(0);
});

test("24. Android/browser back returns from Detail to the List", async ({ page }) => {
  await rowByTitle(page, "Купить молоко").locator(".pa-title").click();
  await expect(page.locator(".page")).toHaveCount(2);

  await page.locator(".page[data-index='1'] .link.back").click();
  await expect(page.locator(".page")).toHaveCount(1);
  expect((await activeStack(page)).length).toBe(1);
});

test("25. the FAB creates a record and opens it for editing", async ({ page }) => {
  const before = await countRecords(page, "TodoLine");
  await fab(page).click();
  await expect(page.locator(".page")).toHaveCount(2);
  expect(await countRecords(page, "TodoLine")).toBe(before + 1);

  await page.locator(".page[data-index='1'] input.pa-input").first().fill("Новая задача");
  await page.locator(".page[data-index='1'] input.pa-input").first().blur();
  await page.waitForTimeout(700);
  await page.locator(".page[data-index='1'] .link.back").click();

  await expect(rowByTitle(page, "Новая задача")).toHaveCount(1);
});

test("26. data survives a reload (SQLite is persisted to IndexedDB)", async ({ page }) => {
  const row = rowByTitle(page, "Подготовить отчёт");
  const id = await row.getAttribute("data-id");
  await row.locator(".pa-title").click();
  await page.locator(".page[data-index='1'] input.pa-input").first().fill("Отчёт готов");
  await page.locator(".page[data-index='1'] input.pa-input").first().blur();
  await page.waitForTimeout(900);
  await page.evaluate(() => window.oneframework.flush());
  await page.waitForTimeout(600);

  await page.reload();
  await waitReady(page);

  expect((await readRecord(page, "TodoLine", id)).text).toBe("Отчёт готов");
  await expect(rowByTitle(page, "Отчёт готов")).toHaveCount(1);
  // the seed must not run twice
  expect(await countRecords(page, "Tag")).toBe(4);
});

test("27. the app boots offline from the service worker cache", async ({ page, context }) => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  // give the precache a moment to finish storing ~15 MB of runtime
  await page.waitForFunction(
    async () => (await caches.keys()).length > 0 &&
      (await (await caches.open((await caches.keys())[0])).keys()).length > 5,
    { timeout: 90_000 },
  );

  await context.setOffline(true);
  await page.reload();
  await waitReady(page);

  expect(await rows(page).count()).toBeGreaterThan(0);
  await expect(page.locator(".navbar .title")).toHaveText("Todo");
  await context.setOffline(false);
});

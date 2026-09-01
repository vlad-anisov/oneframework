/**
 * Заметки на Kotlin: логика на устройстве -- скомпилированный модуль.
 *
 * Эта сюита проверяет то, чего не проверяет ничто другое: что `.wasm`,
 * собранный на сборке (Kotlin -> байткод -> TeaVM -> WebAssembly), вправду
 * **исполняется** в браузере. Сверка байтов модуля
 * (`tests/test_js_teavm.py`) говорит лишь, что два сборщика выдали одно;
 * работает ли выданное, из неё не следует.
 *
 * Проверяется на кнопке «Пересчитать сводку»: за ней метод модели `summary`,
 * считает он словами, а заглавные расставляет сторонней библиотекой с Maven
 * Central. Появилась сводка -- значит поднялся модуль, доехала библиотека и
 * правка вернулась в запись.
 *
 * `dist/` собирается под одно приложение, поэтому сюита пропускает себя, если
 * там лежит другое, -- тем же приёмом, что у соседей.
 */

import { expect, test } from "@playwright/test";

import { bootApp, fab, readRecord, rows } from "./helpers.js";

const ИМЯ = "Заметки (Kotlin)";
const КАРТОЧКА = ".page-current";
const СВОДКА = `${КАРТОЧКА} textarea`;

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page error]", err.message));
  await bootApp(page, ИМЯ);
});

/**
 * Завести заметку и открыть её.
 *
 * Именно так, а не «нажать кнопку в черновике»: действие объявлено с
 * аргументом `ids`, а у черновика ключа ещё нет -- запись не создана. Кнопка
 * там погашена, и проверяется это отдельно, ниже.
 */
async function завести(page, текст) {
  await fab(page).click();
  const поле = page.locator(`${КАРТОЧКА} input[type='text']`).first();
  await expect(поле).toBeVisible();
  await поле.fill(текст);
  await поле.blur();
  await page.locator(`${КАРТОЧКА} .link:has-text('Сохранить')`).click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await expect(page.locator(`${КАРТОЧКА} button:has-text('Пересчитать сводку')`))
    .toBeVisible();
}

async function посчитать(page) {
  await page.locator("button:has-text('Пересчитать сводку')").click();
}

test("1. приложение поднимается и показывает пустой список", async ({ page }) => {
  await expect(page.locator(".navbar .title").first()).toHaveText("Заметки");
  await expect(page.locator(КАРТОЧКА)).toContainText("Пусто");
});

test("2. плавающая кнопка заводит запись и открывает её карточку", async ({ page }) => {
  await завести(page, "Проба");
  await expect(page.locator(`${КАРТОЧКА} .link:has-text('Сохранить')`)).toBeVisible();
});

test("3. модуль WebAssembly считает сводку", async ({ page }) => {
  await завести(page, "первое второе третье четвёртое пятое шестое");
  await посчитать(page);
  // Шесть слов, а в сводку идут первые пять -- ровно так объявлено в модели.
  await expect(page.locator(СВОДКА).first())
    .toHaveValue("6 слов: Первое Второе Третье Четвёртое Пятое", { timeout: 20_000 });
});

test("4. заглавные расставляет сторонняя библиотека с Maven Central", async ({ page }) => {
  // `WordUtils.capitalizeFully` из `commons-text` не только поднимает первую
  // букву, но и **опускает** остальные. По этому и видно, что доехал именно
  // байткод библиотеки, -- ради чего выбран TeaVM, а не `kotlinc-wasm`:
  // тот принимает только `.klib`, пересобранные под свою цель.
  await завести(page, "ГРОМКО тихо");
  await посчитать(page);
  await expect(page.locator(СВОДКА).first())
    .toHaveValue("2 слов: Громко Тихо", { timeout: 20_000 });
});

test("5. посчитанное ложится в базу, а не живёт на экране", async ({ page }) => {
  await завести(page, "одно два");
  await посчитать(page);
  await expect(page.locator(СВОДКА).first())
    .toHaveValue("2 слов: Одно Два", { timeout: 20_000 });

  // Ключ -- со строки списка: он же и есть ключ записи, и брать его оттуда
  // честнее, чем спрашивать у рантайма, -- на экране видно то же, что в базе.
  const id = await rows(page).first().getAttribute("data-id");
  const запись = await readRecord(page, "Note", id);
  expect(запись.details).toBe("2 слов: Одно Два");
});

test("6. пересчёт по изменившемуся тексту даёт новую сводку", async ({ page }) => {
  await завести(page, "одно два");
  await посчитать(page);
  await expect(page.locator(СВОДКА).first()).toHaveValue("2 слов: Одно Два",
                                                         { timeout: 20_000 });
  const поле = page.locator(`${КАРТОЧКА} input[type='text']`).first();
  await поле.fill("одно два три");
  await поле.blur();
  await посчитать(page);
  // Не «сводка есть», а «сводка другая»: модуль обязан считать заново, а не
  // отдавать прошлый ответ.
  await expect(page.locator(СВОДКА).first()).toHaveValue("3 слов: Одно Два Три",
                                                         { timeout: 20_000 });
});


test("7. на черновике кнопка действия погашена, а не молчит", async ({ page }) => {
  // До 21.08.2026 она оставалась живой и **ничего не делала**: логика исправно
  // исполнялась над пустым набором -- записи-то ещё нет, -- проходила успешно
  // и не меняла ничего. Объяснить это пользователю было нечем: ни ответа, ни
  // отказа, ни следа. Тем же доводом рядом гасится удаление на черновике.
  //
  // Гасится, а не прячется: после сохранения кнопка нужна, и исчезать с
  // карточки ей незачем -- иначе она прыгала бы туда-обратно.
  await fab(page).click();
  const поле = page.locator(`${КАРТОЧКА} input[type='text']`).first();
  await поле.fill("первое второе");
  await поле.blur();

  const кнопка = page.locator("button:has-text('Пересчитать сводку')").first();
  await expect(кнопка).toHaveClass(/\bdisabled\b/);

  // Сохранили -- запись появилась, и кнопка ожила.
  await page.locator(`${КАРТОЧКА} .link:has-text('Сохранить')`).click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await expect(page.locator("button:has-text('Пересчитать сводку')").first())
    .not.toHaveClass(/\bdisabled\b/);
});

//: Здесь стояла проверка условия, записанного строкой: `expr("length(...) > 3")`
//: на кнопке. Она требовала добавить условие в котлиновское приложение -- а
//: тройка примеров обязана быть одинаковой снаружи, и `test_three_languages`
//: это сторожит. Умение проверено там, где ему место: разборщик сверен с
//: питоновским DSL (`test_expr_text.py`), провод -- в `test_expr_text_wire.py`,
//: а согласие показа с отбором -- в `test_expr_evaluate_arith.py`.

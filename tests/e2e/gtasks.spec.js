/**
 * Логика в WASM, нажатая пальцем.
 *
 * Всё, что ниже, уже проверено тестами -- порознь: хост, доставка модуля,
 * одинаковость двух рантаймов. Здесь проверяется то, чего ни один из них не
 * видит: что в собранном приложении, открытом в настоящем браузере, кнопка
 * доходит до модуля, а модуль -- до базы. Питона на этом конце нет вовсе:
 * модуль лежит в SQLite, приехавшей сборкой, и исполняет его движок браузера.
 *
 * Прогон идёт против *gtasks*: в `dist/` лежит то приложение, которое собрали
 * последним, поэтому сюита пропускает себя, если собрано другое --
 * `oneframework build web examples/gtasks/app.py`.
 */

import { expect, test } from "@playwright/test";

import { bootApp, readRecord } from "./helpers.js";

const boot = (page) => bootApp(page, "Задачи");

//: Вкладок в gtasks столько, сколько списков, и все они в разметке разом --
//: строки берутся из открытой, иначе их набирается тридцать.
const rows = (page) =>
  page.locator(".pa-tabs__panes .tab-active .pa-rows li:not(.list-group-title)");

const listMenu = (page) => page.locator(".pa-tabs__panes .tab-active .pa-listmenu");

//: Строка открывается нажатием на название: слева от него стоит флажок
//: «выполнено», и попасть в него значит проверить не то.
const openRow = (page) => rows(page).first().locator(".pa-title").first();

//: Плавающая кнопка экрана записи -- не та, что у списка: у списка это
//: `pa-fab`, здесь -- прикреплённая к карточке.
const doneFab = (page) => page.locator(".pa-pinned", { hasText: "Выполнено" });

/** Открыть вкладку списка -- так, как это делает палец. */
async function openBoard(page, label) {
  await page.locator(".pa-tabs__bar .tab-link", { hasText: label }).first().click();
  await page.waitForTimeout(500);
}

/** Ключи задач открытой вкладки, в том порядке, в каком они нарисованы. */
async function visibleTaskIds(page) {
  return page.evaluate(() => {
    const snap = window.oneframework.snapshot();
    const screen = snap.stacks[snap.active].at(-1);
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === "tab" && node.active === false) return;
      if (node.type === "list" && node.rows) found.push(...node.rows.map((r) => r.id));
      Object.values(node).forEach(walk);
    };
    walk(screen);
    return found;
  });
}

/** Значение вычисляемого поля, как его нарисовали. */
async function boardProgress(page) {
  return page.evaluate(() => {
    const snap = window.oneframework.snapshot();
    const screen = snap.stacks[snap.active].at(-1);
    const field = screen.children.find((c) => c.type === "field" && c.name === "progress");
    return field ? field.value : null;
  });
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page error]", err.message));
});

test("28. the button runs the WASM module, and it walks the whole subtree", async ({
  page,
}) => {
  await boot(page);
  await openBoard(page, "Терминал");

  const ids = await visibleTaskIds(page);
  expect(ids.length).toBeGreaterThan(1);
  const [parent, child] = ids;
  // Подзадачу заводит обычное событие записи -- то же, что кладёт поле
  // «Подзадача к» на карточке. Ради теста ничего не заводится в обход.
  await page.evaluate(([model, id, values]) =>
    window.oneframework.dispatch({ type: "write", model, record_id: id, values }),
  ["Task", child, { parent }]);
  await page.waitForTimeout(300);

  await openRow(page).click();
  await page.waitForTimeout(500);
  await expect(doneFab(page)).toBeVisible();
  await doneFab(page).click();
  await page.waitForTimeout(700);

  const top = await readRecord(page, "Task", parent);
  const kid = await readRecord(page, "Task", child);
  // Одного `done` мало: `Set(done, True)` поставил бы его и без всякого WASM.
  // Модуль виден по двум вещам, которых декларация не умеет: он дошёл до
  // подзадачи и проставил дату выполнения.
  expect(top.done).toBeTruthy();
  expect(kid.done).toBeTruthy();
  expect(top.finished).toBeTruthy();
  expect(kid.finished).toBe(top.finished);
});

test("29. a computed field is answered by the module and moves with the data", async ({
  page,
}) => {
  await boot(page);
  await openBoard(page, "Терминал");

  await listMenu(page).click();
  await page.waitForTimeout(400);
  await page.locator(".actions-button", { hasText: "Переименовать список" }).click();
  await page.waitForTimeout(700);

  // Колонки `progress` в базе нет -- число посчитал модуль при отрисовке.
  const before = await boardProgress(page);
  expect(before).toBe(0);
  const label = page.locator(".pa-field__label", { hasText: "Готовность" });
  await expect(label).toBeVisible();
  // Ввод у него закрыт: колонки нет, и напечатанное не записалось бы никуда.
  await expect(page.locator('.pa-input[type="number"]')).toHaveAttribute("readonly", "");

  await page.evaluate(() => window.oneframework.dispatch({ type: "back" }));
  await page.waitForTimeout(500);
  const [first] = await visibleTaskIds(page);
  await openRow(page).click();
  await page.waitForTimeout(500);
  await doneFab(page).click();
  await page.waitForTimeout(700);
  expect((await readRecord(page, "Task", first)).done).toBeTruthy();

  await page.evaluate(() => window.oneframework.dispatch({ type: "back" }));
  await page.waitForTimeout(500);
  await listMenu(page).click();
  await page.waitForTimeout(400);
  await page.locator(".actions-button", { hasText: "Переименовать список" }).click();
  await page.waitForTimeout(700);

  // Шесть задач, одна завершена -- 17 %. Считает это модуль, а не SQL, и
  // считает заново: хранимое число осталось бы нулём.
  expect(await boardProgress(page)).toBe(17);
});

test("30. the invitation row keeps its hint colour, and paints no icon of its own", async ({ page }) => {
  await boot(page);
  await openBoard(page, "Терминал");
  await openRow(page).click();
  await page.waitForTimeout(900);

  // «Добавить подзадачи» -- выбиральщик связи, чья подпись живёт в подсказке:
  // строка *и есть* значение, поэтому она без уголка и приглушена.
  const item = page.locator("li.pa-select");
  await expect(item).toHaveCount(1);
  await expect(item).toHaveClass(/no-chevron/);
  await expect(item.locator(".item-title")).toHaveText("Добавить подзадачи");

  // Цвет подсказки идёт переменной Framework7 на `li` -- до самого
  // `.item-title` составляющая добраться не даёт, и своего правила CSS для
  // этого не заведено.
  const paint = await item.evaluate((li) => {
    const title = li.querySelector(".item-title");
    const icon = li.querySelector(".item-media i");
    const probe = document.createElement("span");
    probe.style.color = "var(--f7-input-placeholder-color)";
    li.appendChild(probe);
    const hint = getComputedStyle(probe).color;
    probe.remove();
    return {
      fromLi: li.style.getPropertyValue("--f7-list-item-title-text-color").trim(),
      title: getComputedStyle(title).color,
      hint,
      icon: getComputedStyle(icon).color,
      iconInline: icon.style.color,
    };
  });
  expect(paint.fromLi).toBe("var(--f7-input-placeholder-color)");
  expect(paint.title).toBe(paint.hint);
  // Ведущую иконку мы больше не красим вовсе: тон `--f7-md-on-surface-variant`
  // был нашим -- он тянул материальную палитру и в тему iOS тоже, где ей не
  // место. Теперь цвет решает Framework7, и решает он «как весь текст»: иконка
  // выходит темнее приглушённой подписи рядом. Это следствие снятия, а не
  // недосмотр, и проверка сторожит именно его -- своего цвета на иконке нет.
  expect(paint.iconInline).toBe("");
  expect(paint.icon).not.toBe(paint.hint);
});

test("31. волна прикосновения обрезана строкой, а не расходится по листу", async ({ page }) => {
  // Класс `ripple` -- только метка для обработчика касаний
  // (`touchRippleElements`); в таблице стилей Framework7 правила на него нет
  // ни одного. Вместилище волны -- `position: relative; overflow: hidden` --
  // он раздаёт своим формам строки: `.list .item-link`, `.list
  // label.item-content`, `.list .list-button`.
  //
  // Меряется не картинка, а вместилище: волну Framework7 растит по диагонали
  // короба (у строки высотой 48 это круг в 362 пикселя), и всё, что решает
  // «внутри строки или по всему листу», -- обрезает её родитель или нет.
  await boot(page);
  await openBoard(page, "Терминал");

  const строка = page.locator(".pa-tabs__panes .tab-active .pa-rowitem").first();
  await expect(строка).toHaveClass(/item-link/);
  const держит = await строка.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { обрезка: cs.overflow, позиция: cs.position };
  });
  expect(держит).toEqual({ обрезка: "hidden", позиция: "relative" });

  // Строка связи в карточке -- та же беда с другой стороны: её Framework7
  // ловит по `.link`, а `.link` получает позицию без обрезки.
  await openRow(page).click();
  await page.waitForTimeout(700);
  const связь = page.locator(".page-current .link.item-content").first();
  await expect(связь).toHaveClass(/item-link/);
  expect(await связь.evaluate((el) => getComputedStyle(el).overflow)).toBe("hidden");
});

test("32. выбор сортировки -- меню Framework7 у самой кнопки, без крестика", async ({ page }) => {
  // Прежде это был лист действий, а галочку выбранной строке мы проставляли
  // сами, полем `icon`. Кнопка со значком получает у Framework7 слот
  // `actions-button-media`, кнопка без значка -- не получает вовсе, поэтому
  // подписи начинались с разных мест, и каждая тема сдвигала их по-своему.
  //
  // Теперь порядок выбирается его собственным smart select, и открыт он
  // всплывающим меню, а не листом. Разница не в красоте: лист Framework7
  // рисует поверх себя полосу с крестиком (`renderSheet`), и параметром её не
  // убрать, -- а меню и Material, и HIG для выбора порядка и предписывают.
  // Всплывающее меню полосы не имеет вовсе, и это здесь и проверяется:
  // вернувшийся лист провалит проверку, а не просто изменит вид.
  await boot(page);
  await openBoard(page, "Терминал");
  // Не `.first()`: кнопка сортировки своя у каждой вкладки-списка, и первая
  // из них лежит в невидимой панели.
  const кнопка = page.locator(".pa-tabs__panes .tab-active .pa-sortbtn");
  await кнопка.click();
  const меню = page.locator(".popover.smart-select-popover.modal-in");
  await меню.waitFor({ state: "visible" });

  expect(await меню.locator(".toolbar, .navbar, .sheet-close").count()).toBe(0);
  await expect(page.locator(".smart-select-sheet")).toHaveCount(0);

  // Меню стоит у кнопки, а не посреди экрана: Framework7 сам считает угол.
  const [м, к] = await Promise.all([
    меню.evaluate((el) => el.getBoundingClientRect().toJSON()),
    кнопка.evaluate((el) => el.getBoundingClientRect().toJSON()),
  ]);
  expect(Math.abs(м.top - к.bottom)).toBeLessThan(24);

  const строки = меню.locator(".item-radio");
  expect(await строки.count()).toBeGreaterThan(1);
  const края = await строки.locator(".item-title").evaluateAll(
    (els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  expect(new Set(края).size).toBe(1);

  // Отмечена та, что в силе, и отмечена ровно одна.
  expect(await строки.locator("input:checked").count()).toBe(1);

  // И выбор доводится до конца. Без этого проверка мерила бы только вид:
  // у `smart-select` признак `closeOnSelect` выключен по умолчанию -- он
  // рассчитан и на выбор нескольких, -- и меню оставалось бы открытым, а его
  // подложка ловила все нажатия. Поймала это сюита todo, а не эта.
  await строки.nth(1).locator(".item-title").click();
  await page.locator(".popover").waitFor({ state: "detached" });
  await page.waitForTimeout(700);
  await expect(page.locator(".popover-backdrop.backdrop-in")).toHaveCount(0);
});

test("33. меню сортировки уходит и по касанию мимо -- иначе крестик был бы нужен", async ({ page }) => {
  // Крестик у листа -- не украшение: без него лист нечем закрыть, не выбрав.
  // Убрав крестик, мы обязаны доказать, что уйти есть чем. Обработчики Framework7
  // вешает не при открытии, а по `popoverOpened`, то есть по концу хода, --
  // касание раньше этого мига проходит в пустоту. Поэтому ждём не появления
  // меню, а конца его хода.
  await boot(page);
  await openBoard(page, "Терминал");
  await page.locator(".pa-tabs__panes .tab-active .pa-sortbtn").click();
  const меню = page.locator(".popover.smart-select-popover.modal-in");
  await меню.waitFor({ state: "visible" });
  await меню.evaluate((el) => new Promise((готово) => {
    if (getComputedStyle(el).opacity === "1") return готово();
    el.addEventListener("transitionend", () => готово(), { once: true });
  }));

  await page.locator(".popover-backdrop").tap({ position: { x: 8, y: 8 } });
  await page.locator(".popover").waitFor({ state: "detached" });
  await expect(page.locator(".popover-backdrop.backdrop-in")).toHaveCount(0);
});

test("34. у вкладки сверху один указатель -- линия, а не пилюля нижней навигации", async ({ page }) => {
  // Одним классом `tabbar` Framework7 рисует две разные вещи Material: бар
  // вкладок и нижнюю навигацию. Пилюлю под значком (`.md .tabbar i.icon::before`,
  // 64x32, скругление 32) Material предписывает второй -- 56x32, «50% rounded»,
  // -- а вкладкам сверху предписывает линию. Framework7 даёт и то и другое,
  // и выходило два указателя на одно состояние, причём пилюля -- только у
  // вкладки со значком, потому что у остальных значка нет.
  await boot(page);
  const бар = page.locator(".pa-tabs__panes .tab-active").first()
    .locator("xpath=ancestor::div[contains(@class,'pa-tabs')]").first()
    .locator(".pa-tabs__bar").first();
  const значок = бар.locator(".tab-link.tab-link-active i.icon").first();
  await expect(значок).toHaveCount(1);

  const пилюля = await значок.evaluate((el) => {
    const s = getComputedStyle(el, "::before");
    return { фон: s.backgroundColor, ширина: s.width, непрозрачность: s.opacity };
  });
  // Правило Framework7 никуда не делось -- погашен его же переменной цвет.
  expect(пилюля.ширина).toBe("64px");
  expect(пилюля.фон).toBe("rgba(0, 0, 0, 0)");

  // А линия -- на месте, и стоит она под открытой вкладкой. Мерить её сразу
  // нельзя: Framework7 подводит её ходом, и до конца хода она стоит мимо.
  const линия = бар.locator(".tab-link-highlight");
  await expect(линия).toHaveCount(1);
  await линия.evaluate((el) => new Promise((готово) => {
    let было = null;
    const смотреть = () => {
      const стало = el.getBoundingClientRect().left;
      if (стало === было) return готово();
      было = стало;
      requestAnimationFrame(смотреть);
    };
    смотреть();
  }));
  const [л, в] = await Promise.all([
    линия.evaluate((el) => el.getBoundingClientRect().toJSON()),
    бар.locator(".tab-link.tab-link-active").first()
      .evaluate((el) => el.getBoundingClientRect().toJSON()),
  ]);
  expect(Math.round(л.width)).toBe(Math.round(в.width));
  expect(Math.abs(л.left - в.left)).toBeLessThan(2);
});

test("35. выбор вкладки двигает листалку, а не только красит подпись", async ({ page }) => {
  // Дыра, которую эта проверка закрывает. Панели вкладок лежат в листалке в
  // ряд, и открытую показывает её сдвиг. Класс `tab-active` сам по себе
  // ничего не двигает -- панель остаётся за краем экрана. Playwright же
  // считает видимым всё, у чего есть коробка, в том числе уехавшее за экран:
  // сюита читала строки «открытой» вкладки, которой человек не видит.
  //
  // Поймано мутацией: ссылка на листалку у составляющей приходит как
  // `{ el }`, и стоило прочитать её как элемент, `el.swiper` пропадал, сведение
  // молча выключалось -- а все двадцать проверок оставались зелёными.
  await boot(page);
  const вкладки = page.locator(".pa-tabs__bar .tab-link");
  await вкладки.nth(2).click();
  await page.waitForTimeout(600);

  const снимок = await page.evaluate(() => {
    const el = document.querySelector(".pa-tabs__panes");
    const открытая = el.querySelector(".tab-active");
    const к = открытая.getBoundingClientRect();
    return {
      номер: el.swiper?.activeIndex,
      открытаяПоСчёту: [...el.children].indexOf(открытая),
      слева: Math.round(к.left),
      ширинаОкна: window.innerWidth,
    };
  });
  // Листалка стоит на той же панели, что помечена открытой...
  expect(снимок.номер).toBe(снимок.открытаяПоСчёту);
  // ...и панель эта правда на экране, а не за его краем.
  expect(Math.abs(снимок.слева)).toBeLessThan(2);
});

test("36. приехавший обменом вид меняет кадр сразу, без перезагрузки", async ({ page }) => {
  // Главное обещание каркаса, и до 20.08.2026 оно выполнялось только наполовину.
  // Схема и документы читались из базы, а не из сборки, -- но читались **один
  // раз за жизнь воркера**. Приехавший вид ложился в `_oneframework_def` и
  // ждал перезапуска: `apply_changes` накладывал changeset, помечал модели
  // изменёнными и всё. Нашёл это разбор со стороны, а не эта сюита.
  //
  // Обмен подделан на месте: конверт с одним определением и без единой записи.
  // Настоящий сервер не нужен -- проверяется не доставка, а то, что
  // доставленное становится кадром.
  //
  // Три вещи, стоившие трёх неверных редакций этой проверки, и все три стоит
  // помнить. Подпись ячейки в строке списка не рисуется -- проверка на неё
  // проходила и с выключенной пересборкой. Документ из **снимка** уже
  // развёрнут по записям, и отправить его определением значит подменить
  // объявление его тенью -- список схлопывался. И наконец: вызов хоста минует
  // оболочку, поэтому экран от него не перерисовывается вовсе -- смотреть надо
  // на кадр, который хост вернул.
  await boot(page);

  const где = (кадр) => {
    const э = кадр.stacks[кадр.active][0];
    const f = (n, п) => (п(n) ? n : (n?.children || []).map((k) => f(k, п)).find(Boolean));
    const сп = f(э.doc ?? э, (n) => n?.type === "list");
    return f(сп.row, (n) => n?.name === "starred");
  };

  // До обмена ячейка звезды в кадре есть и не погашена.
  const было = await page.evaluate(`(${где})(window.oneframework.snapshot())`);
  expect(было).toBeTruthy();
  expect(было.visible).not.toBe(false);

  const ответ = await page.evaluate(async () => {
    const конверт = await window.oneframework.host.pendingChanges();
    // Настоящее объявление, а не его тень из кадра.
    const док = await window.oneframework.host.readDefinition("view", "TaskRow");
    const f = (n, п) => (п(n) ? n : (n?.children || []).map((k) => f(k, п)).find(Boolean));
    f(док, (n) => n?.name === "starred").visible = false;
    return window.oneframework.host.applyChanges({
      protocol: конверт.protocol,
      schema: конверт.schema,
      changes: [],
      defs: [{ kind: "view", name: "TaskRow", doc: док }],
      accepted: [],
      cursor: null,
    });
  });

  // Обмен сказал, что определения были: по этому счёту воркер и решает,
  // пересобирать ли рантайм.
  expect(ответ.sync.defs).toBe(1);

  // И кадр, который он вернул, собран по **приехавшему** документу: ячейка
  // погашена. Со старым поведением здесь пришёл бы кадр по документам,
  // прочитанным при запуске, и ячейка осталась бы прежней.
  const стало = await page.evaluate(`(${где})(${JSON.stringify(ответ.snapshot)})`);
  expect(стало).toBeTruthy();
  expect(стало.visible).toBe(false);
});

test("37. воркер исполняет запросы по одному, а не вперемешку", async ({ page }) => {
  // До 20.08.2026 `self.onmessage` был объявлен `async`, и на каждое сообщение
  // заводилась своя цепочка. Пока одна ждала -- питон на устройстве поднимается
  // секундами, -- воркер начинал следующую. Беда не в порядке ответов, а в том,
  // что обе трогают **одну синхронную базу**: вторая приходила в неё посреди
  // чужой транзакции. Наружу это выглядело так: медленное действие кончалось
  // позже быстрого и перезаписывало экран уже устаревшим кадром. Ни исключения,
  // ни следа в журнале.
  //
  // Медленным служит настоящий питон на устройстве: `Board.normalize` поднимает
  // Pyodide, и первый вызов стоит около полутора секунд. Ничто другое в воркере
  // не ждёт настоящего ввода-вывода: обещание, разрешённое сразу, отдаёт
  // управление микрозадаче, а сообщения приходят макрозадачами -- и порядок
  // сохраняется сам собой, без всякой очереди. Три первые редакции этой
  // проверки на том и провалились: они ловили мутацию только на бумаге.
  await boot(page);
  await page.locator(".pa-tabs__bar .tab-link", { hasText: "Терминал" }).first().click();
  await page.waitForTimeout(700);
  await page.locator(".pa-tabs__panes .tab-active .pa-listmenu").first().click();
  await page.waitForTimeout(600);
  await page.locator(".actions-modal.modal-in .actions-button", { hasText: /Переименовать/ })
    .first().click();
  await page.waitForTimeout(1000);

  const итог = await page.evaluate(async () => {
    const хост = window.oneframework.host;
    const кадр = window.oneframework.snapshot();
    const стек = кадр.stacks[кадр.active];
    const экран = стек[стек.length - 1];
    const найти = (n, п) => (п(n) ? n : (n?.children || []).map((k) => найти(k, п)).find(Boolean));
    const кнопка = найти(экран.doc ?? экран, (n) => n?.action?.type === "logic");
    if (!кнопка) return { ошибка: "на карточке нет кнопки с логикой" };

    const кончил = [];
    const начало = performance.now();
    // Медленный уходит первым, быстрый -- сразу следом.
    const медленный = хост.dispatch({
      type: "action", button_id: кнопка.id,
      context: { screen_id: экран.id, record_id: экран.record_id },
    }).then(() => кончил.push("питон"), () => кончил.push("питон"));
    const быстрый = хост.countRecords("Task").then(() => кончил.push("счёт"));
    await Promise.all([медленный, быстрый]);
    return { порядок: кончил, мс: Math.round(performance.now() - начало) };
  });

  expect(итог.ошибка).toBeUndefined();
  // Медленный правда медленный -- иначе проверка мерила бы совпадение.
  expect(итог.мс).toBeGreaterThan(300);
  // И быстрый дождался его: очередь исполняет по одному, в порядке прихода.
  // Без очереди здесь стоит ["счёт", "питон"] -- замерено.
  expect(итог.порядок).toEqual(["питон", "счёт"]);
});

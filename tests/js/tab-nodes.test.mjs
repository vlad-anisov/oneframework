/**
 * Вкладки в привязке на JavaScript.
 *
 * Что они дают тот же документ, что и питон, сверено побайтово при переносе;
 * ожидаемое здесь записано **списком**, а не вычислено тем же кодом --
 * вычисленное сошлось бы с любой ошибкой разбора.
 *
 * Проверяется разбор доводов: что уходит в заголовок, что в содержимое, что в
 * плавающую кнопку. Разделять их по месту нельзя -- ни текст, ни значок, ни
 * счётчик содержимым не бывают, и помечать, который довод чем является, было
 * бы обрядом.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Button, Icon, List, Repeat, Section, Tab, Tabs, Text, boolean, model,
  string, view }
  from "../../../oneframework-js/index.mjs";

const M = model("M", { fields: { t: string("Т"), c: boolean("В") } });

/** Документ вкладок через настоящий вид: номера раздаёт он. */
const вкладки = (...аргументы) =>
  view("V", { ui: () => [Tabs(...аргументы)] }).document().children[0];

test("голая строка -- сокращение для одного текста", () => {
  const в = вкладки(Tab("Раз")).children[0];
  assert.equal(в.label, "Раз");
  assert.deepEqual(в.title, [{ type: "text", id: "V.txt1", value: "Раз" }]);
  assert.deepEqual(в.children, []);
});

test("вкладка, названная знаком, простого имени не имеет", () => {
  // Пустая строка, а не лигатура значка: лигатура словом не является, а звено
  // крошки без слова было бы дырой в цепочке. Знак при этом в заголовке, а не
  // в содержимом -- картинка вместо имени и есть имя.
  const в = вкладки(Tab(Icon("star"), List(M))).children[0];
  assert.equal(в.label, "");
  assert.deepEqual(в.title, [{ type: "icon", id: "V.ic1", name: "star" }]);
  assert.deepEqual(в.children.map((c) => c.type), ["list"]);
});

test("знак не первым доводом -- всё равно заголовок", () => {
  // Первый довод в заголовок кладёт само правило «подпись»; про остальные
  // решает род узла, и знак содержимым не бывает.
  const в = вкладки(Tab("Раз", Icon("star"), List(M))).children[0];
  assert.deepEqual(в.title.map((ч) => ч.type), ["text", "icon"]);
  assert.deepEqual(в.children.map((c) => c.type), ["list"]);
});

test("заголовок между группами -- содержимое, а не часть заголовка вкладки", () => {
  const в = вкладки(Tab("Раз", Section("Первый", "и подпись"))).children[0];
  assert.deepEqual(в.title.map((ч) => ч.value), ["Раз"]);
  assert.deepEqual(в.children,
                   [{ type: "section", id: "V.sec1", title: "Первый", subtitle: "и подпись" }]);
});

test("части заголовка отделяются от содержимого", () => {
  // Второй текст -- часть заголовка, список -- содержимое. По месту их не
  // различить: оба стоят среди доводов подряд.
  const в = вкладки(Tab("Раз", Text("ещё"), List(M))).children[0];
  assert.deepEqual(в.title.map((ч) => ч.value), ["Раз", "ещё"]);
  assert.deepEqual(в.children.map((c) => c.type), ["list"]);
  // Простое имя -- первый текст заголовка, а не склейка всех.
  assert.equal(в.label, "Раз");
});

test("плавающая кнопка вкладки -- не содержимое страницы", () => {
  // Она висит над всем экраном, а какая страница открыта -- знает только
  // рендерер. Оставь её в детях -- и она уехала бы вместе со страницей.
  const в = вкладки(Tab("Раз", Button({ place: "fab", action: M.create() }),
                        List(M))).children[0];
  assert.equal(в.fab.place, "fab");
  assert.deepEqual(в.children.map((c) => c.type), ["list"]);
});

test("обычная кнопка остаётся содержимым", () => {
  // Правило про плавающую, а не про кнопки вообще: иначе вкладка теряла бы
  // всякую кнопку, которую в неё положили.
  const в = вкладки(Tab("Раз", Button("Жать", { action: M.create() }))).children[0];
  assert.equal(в.fab, null);
  assert.deepEqual(в.children.map((c) => c.type), ["button"]);
});

test("номера раздаются заголовку, кнопке и содержимому", () => {
  // Части заголовка -- тоже узлы, и номер нужен им как всякому другому:
  // без номера рендереру нечем ключевать элемент.
  const т = вкладки(Tab("Раз", Button({ place: "fab", action: M.create() }), List(M)),
                    Tab("Два", List(M)));
  assert.equal(т.id, "V.tb1");
  assert.deepEqual(т.children.map((c) => c.id), ["V.tab1", "V.tab2"]);
  assert.deepEqual(т.children[0].title.map((ч) => ч.id), ["V.txt1"]);
  assert.equal(т.children[0].fab.id, "V.b1");
  assert.deepEqual(т.children.map((c) => c.children[0].id), ["V.l1", "V.l2"]);
});

test("кнопка в конце полосы -- страница вкладок, а не страница", () => {
  const т = вкладки(Tab("Раз", List(M)), Button("В конце", { action: M.create() }));
  assert.deepEqual(т.children.map((c) => c.type), ["tab", "button"]);
});

test("вкладки решают, они ли сам экран", () => {
  assert.equal(вкладки(Tab("Раз")).page, "auto");
  assert.equal(вкладки(Tab("Раз"), { page: true }).page, true);
  assert.equal(вкладки(Tab("Раз"), { page: false }).page, false);
});

test("недопустимое значение page отвергнуто по имени", () => {
  // Молча принятое «страница» значило бы, что вкладки прокручиваются не так, и
  // заметить это можно было бы только глазами на устройстве.
  assert.throws(() => Tabs(Tab("Раз"), { page: "страница" }),
                /Tabs\(page: "страница"\)/);
});

test("во вкладки не кладут что попало", () => {
  assert.throws(() => Tabs(List(M)), /принимает страницы Tab\(\.\.\.\)/);
});

test("повторитель -- законная страница вкладок", () => {
  // Вкладок бывает столько, сколько записей, и это ровно то, ради чего
  // повторитель заведён.
  const т = вкладки(Repeat(M, (item) => Tab("{item.t}", List(M))));
  assert.deepEqual(т.children.map((c) => c.type), ["repeat"]);
});

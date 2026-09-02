/**
 * Поиск, отбор и порядок в привязке на JavaScript -- правила, которых не видно
 * на подопытном приложении.
 *
 * Что они дают тот же документ, что и питон, сверяет `tests/js/todo-parity.test.mjs`.
 * Но приложение задевает не всё: у него есть и отбор по умолчанию, и порядок по
 * умолчанию, и обе ветки «а если не назначили» остаются непройденными. Они
 * здесь.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Filter, List, Search, Sort, boolean, integer, model, string, view }
  from "../../../oneframework-js/index.mjs";

const M = model("M", {
  fields: { t: string("Задача"), c: boolean("Выполнено"), s: integer() },
});

/**
 * Документ списка -- через настоящий вид: номера раздаёт он, а `record` в виде
 * без модели даёт непривязанные ссылки, которыми поиск и пишется.
 */
function список(собрать, настройки = {}) {
  const V = view("V", {
    ui: (record) => [List(M, { search: собрать(record), ...настройки })],
  });
  return V.document().children[0];
}

test("порядок в силе есть всегда, даже когда его не назначили", () => {
  // Список без выбранного порядка показывал бы записи в порядке базы -- то
  // есть в произвольном, и меняющемся от вставки. Первый объявленный и есть
  // порядок по умолчанию, пока не сказано иначе.
  const s = список((r) => Search(Sort("По порядку", r.s), Sort("По имени", r.t))).search;
  assert.equal(s.default_sort, 0);
  assert.deepEqual(s.sorts.map((x) => x.default), [false, false]);
});

test("назначенный порядок побеждает первый", () => {
  const s = список((r) => Search(Sort("По порядку", r.s),
                                 Sort("По имени", r.t, { default: true }))).search;
  assert.equal(s.default_sort, 1);
});

test("порядков нет -- нет и того, что в силе", () => {
  assert.equal(список((r) => Search(r.t)).search.default_sort, null);
});

test("отбора по умолчанию может не быть вовсе", () => {
  // В отличие от порядка: «все записи» -- законное состояние списка, а
  // «никакого порядка» -- нет.
  const s = список(() => Search(Filter("Осталось", null), Filter("Все", null))).search;
  assert.equal(s.default_filter, null);
});

test("назначенный отбор находится по счёту, а не по имени", () => {
  const s = список(() => Search(Filter("Все", null),
                                Filter("Осталось", null, { default: true }))).search;
  assert.equal(s.default_filter, 1);
});

test("порядок без поля отвергнут по имени", () => {
  // Переключатель без порядка -- кнопка, которая ничего не значит.
  assert.throws(() => Sort("Никак"), /Sort\("Никак"\) без поля/);
});

test("в поиск не кладут что попало", () => {
  assert.throws(() => Search("текстом"),
                /принимает ссылки на поля, Filter\(\.\.\.\) и Sort\(\.\.\.\)/);
});

test("списку в поиск дают Search, а не похожее", () => {
  assert.throws(() => список(() => ({ fields: ["t"] })), /List\(search:\) ждёт Search/);
});

test("перетаскивание -- только когда порядок и есть ручка по возрастанию", () => {
  // Иначе перетащенная строка встала бы не туда, куда её тащили: ручка пишет
  // своё поле, а показывают записи по другому.
  const по = (порядок, ручка) =>
    список((r) => Search(порядок(r)), { handleField: ручка }).search.sorts[0].reorderable;
  assert.equal(по((r) => Sort("Руками", r.s), "s"), true);
  assert.equal(по((r) => Sort("Наоборот", r.s.desc()), "s"), false);
  assert.equal(по((r) => Sort("По имени", r.t), "s"), false);
  assert.equal(по((r) => Sort("Руками", r.s), null), false);
  // Два члена -- уже не ручка: перетаскивание правит один, а порядок решают оба.
  assert.equal(по((r) => Sort("Двумя", r.s, r.t), "s"), false);
});

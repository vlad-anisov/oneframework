/**
 * Проверка набора, написанная исходником, отвергается при загрузке.
 *
 * Запись синхронна: база спрашивает проверку прямо в ходе сохранения, а
 * исходник на питоне или JavaScript исполняется хостом асинхронно. Прими такую
 * проверку молча -- и сохранение прошло бы мимо неё, то есть проверки не было
 * бы вовсе, а объявлена она была.
 *
 * Нашёл это разбор со стороны. Своей проверки на этот случай не
 * было ни одной: ни один пример такую не объявляет, до неё доходили только
 * чтением кода.
 *
 * Настоящей базы здесь не нужно: `register` спрашивает только объявления, и
 * подменяется ровно этот один вызов.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { register } from "../../src/runtime/logic.js";

const объявление = (носитель) => ({
  name: "Task.validate",
  model: "Task",
  args: [{ name: "records", type: "json" }],
  returns: [{ name: "errors", type: "json" }],
...носитель,
});

const база = (доки) => ({
  connect: () => ({
    execute: (sql) => (sql.includes("_oneframework_def")
      ? доки.map((d) => ({ kind: "action", name: d.name, doc: JSON.stringify(d) }))
      : []),
    one: () => null,
  }),
});

const попытка = async (носитель) => {
  try {
    await register(база([объявление(носитель)]), { actions: {}, models: {} });
    return { отвергнуто: false, слово: "" };
  } catch (о) {
    return { отвергнуто: true, слово: String(о.message) };
  }
};

describe("проверка набора", () => {
  for (const [язык, носитель] of [
    ["python", { python: { entry: "check", source: "def check(f): pass" } }],
    ["js", { js: { entry: "check", source: "export function check() {}" } }],
  ]) {
    it(`исходником на ${язык} -- отвергается при загрузке`, async () => {
      const о = await попытка(носитель);
      assert.ok(о.отвергнуто, `${язык}: проверка принята молча`);
      // Отказ обязан называть и причину, и выход -- иначе он бесполезен.
      assert.match(о.слово, /запись синхронна/);
      assert.match(о.слово, /rule/);
    });
  }

  it("объявлением -- проходит: отказ обязан быть узким", async () => {
    const о = await попытка({ rule: { name: "self" }, write: { set: {} } });
    assert.equal(о.отвергнуто, false, о.слово);
  });
});

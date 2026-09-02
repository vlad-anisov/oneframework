/**
 * Запись, которой нет, пока её не сохранили.
 *
 * Так устроены обе платформы -- дочерний контекст на iOS, ViewModel на
 * Android, -- и виртуальная запись Odoo. Пока форма открыта, до таблицы не
 * доходит ничего, а отменённый черновик не оставляет следа вовсе.
 *
 * Спрашивается тот рантайм, что стоит на устройстве, а не эталон рядом с
 * ним: сверка двух копий доказывает их согласие, а не верность работающей.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { Draft } from "../../src/runtime/session.js";
import { поднятьРантайм, пробноеПриложение } from "./помощь.mjs";

/** Кадр черновика открывается тем же видом, что кнопка «создать». */
const КАРТОЧКА = "TodoLineDetail";

describe("черновик", () => {
  let rt; let db; let модели;

  beforeEach(async () => {
    const { пакет } = await пробноеПриложение();
    ({ rt, db, модели } = await поднятьРантайм(пакет, пакет.app.screens));
  });

  const черновик = (модель) => new Draft(модели[модель]);
  const сколько = (модель) => db.count(модели[модель]);

  it("черновик читается записью без ключа", () => {
    const д = черновик("TodoLine");
    const строка = д.read();
    assert.equal(строка.id, null);
    for (const поле of Object.keys(модели.TodoLine.fields)) {
      assert.ok(поле in строка, `нет поля ${поле}`);
    }
  });

  it("правка черновика не трогает таблицу", () => {
    const было = сколько("TodoLine");
    const д = черновик("TodoLine");
    д.write({ text: "Черновик" });
    assert.equal(д.values.text, "Черновик");
    assert.equal(сколько("TodoLine"), было);
  });

  it("сохранение вставляет ровно одну строку", () => {
    const было = сколько("TodoLine");
    const д = черновик("TodoLine");
    д.write({ text: "Сохранить меня" });
    const ключ = д.save(db);
    assert.equal(сколько("TodoLine"), было + 1);
    assert.equal(db.read(модели.TodoLine, ключ).text, "Сохранить меня");
  });

  it("вложенный черновик вставляется с ключом родителя", () => {
    // В этом весь смысл вложенности: ребёнок не может знать ключ заранее.
    // Поле связи живёт у **потомка** (`TodoLine.tag`), а не у родителя.
    const родитель = черновик("Tag");
    родитель.write({ name: "Родитель" });
    const ребёнок = черновик("TodoLine");
    ребёнок.write({ text: "Ребёнок" });
    родитель.children.push([модели.TodoLine.fields.tag, ребёнок]);

    const ключРодителя = родитель.save(db);
    const сохранены = db.all(модели.TodoLine).filter((r) => r.text === "Ребёнок");
    assert.equal(сохранены.length, 1);
    assert.equal(сохранены[0].tag, ключРодителя);
  });

  it("правленый черновик сообщает о себе, что тронут", () => {
    const д = черновик("TodoLine");
    assert.equal(д.touched(), false);
    д.write({ text: "что-то" });
    assert.equal(д.touched(), true);
  });

  it("правка поднимает ревизию: черновик реактивен, как таблица", () => {
    const д = черновик("TodoLine");
    const было = д.rev.peek();
    д.write({ text: "правка" });
    assert.ok(д.rev.peek() > было);
  });

  it("запись на экране черновика не доходит до таблицы", () => {
    const было = сколько("TodoLine");
    const кадр = rt.push(КАРТОЧКА, { draft: черновик("TodoLine") });
    rt.dispatch({ type: "write", model: "TodoLine", record_id: null,
                  screen_id: кадр.id, values: { text: "Не в базе" } });
    assert.equal(сколько("TodoLine"), было);
    assert.equal(кадр.draft.values.text, "Не в базе");
  });

  it("уход с экрана черновика не оставляет строки", () => {
    const было = сколько("TodoLine");
    const кадр = rt.push(КАРТОЧКА, { draft: черновик("TodoLine") });
    rt.dispatch({ type: "write", model: "TodoLine", record_id: null,
                  screen_id: кадр.id, values: { text: "Передумал" } });
    rt.dispatch({ type: "back" });
    assert.equal(сколько("TodoLine"), было);
  });

  it("запись в несуществующую запись, которая не черновик, -- отказ", () => {
    assert.throws(() => rt.dispatch({
      type: "write", model: "TodoLine", record_id: null,
      screen_id: rt.stack[rt.stack.length - 1].id, values: { text: "никуда" },
    }));
  });
});

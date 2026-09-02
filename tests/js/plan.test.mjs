/**
 * План выкладки -- правилами, а не сверкой с питоном.
 *
 * Пока сборщик переезжал, здесь стояла двусторонняя сверка: `cli/plan.py`
 * против `src/build/plan.mjs`, план целиком как текст. Она свою работу
 * сделала: правило теперь записано один раз, а питоновская дверь за ним только
 * ходит -- сравнивать стало нечего. Остались правила: что всё объявленное
 * доезжает до определений, что схема не выдумывается, что негодный пакет
 * отказывается вслух и откуда берётся ключ издателя.
 *
 * Подопытных пакетов три, а не девять примеров, как было. Богатый образец
 * (`tests/fixtures/parity_app.mjs`) задевает каждый род узла договора -- этого
 * перебор девяти приложений не давал. Что до плана доезжают и настоящие
 * приложения, видно на сборке: каждый пример собирается сквозным набором.
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildPlan } from "../../src/build/plan.mjs";

let пакеты = {};

before(async () => {
  const { declare } = await import("../../../oneframework-js/index.mjs");
  const { пакет } = await import("../fixtures/parity_app.mjs");
  const { application: todo } = await import("../../../oneframework-examples/todo-js/app.mjs");
  const notes = (await import("../../examples/notes-js/app.mjs")).default;
  пакеты = { богатый: пакет(), todo: declare(todo), notes: declare(notes) };
});

/** План, посчитанный с заданным окружением: ключ издателя берётся оттуда. */
function план(пакет, окружение = {}) {
  const было = { ...process.env };
  delete process.env.PYAPP_SIGNING_KEY;
  Object.assign(process.env, окружение);
  try { return buildPlan(структура(пакет)); }
  finally {
    for (const к of Object.keys(process.env)) delete process.env[к];
    Object.assign(process.env, было);
  }
}

/** Своя копия пакета: проверки поломок его правят. */
const структура = (п) => structuredClone(п);

for (const имя of ["богатый", "todo", "notes"]) {
  test(`всё объявленное доезжает до плана: ${имя}`, () => {
    const пакет = пакеты[имя];
    const п = план(пакет);
    const роды = {};
    for (const [вид, кто] of п.defs) (роды[вид] ??= []).push(кто);

    assert.deepEqual(роды.types, ["_"], "таблица типов кладётся ровно одна");
    // И не пустая: имя записи ничего не говорит о том, что в ней. Без этой
    // строки подменённая на `{}` таблица проходила проверку -- замерено, а на
    // устройстве это значит «ни одного известного типа поля».
    const типы = п.defs.find((д) => д[0] === "types")[2];
    assert.deepEqual(типы, пакет.types);
    assert.ok(Object.keys(типы).length, "таблица типов пуста");
    assert.deepEqual((роды.model ?? []).sort(), пакет.models.map((м) => м.name).sort());
    assert.deepEqual((роды.view ?? []).sort(), пакет.views.map((в) => в.name).sort());
    const объявлено = (пакет.logic ?? []).flatMap((з) => (з.actions ?? []).map((д) => д.name));
    assert.deepEqual((роды.action ?? []).sort(), объявлено.sort());
    // Порядок определений -- по нему считается ревизия, и он обязан быть тем
    // же, что в пакете: перестановка сменила бы ревизию на ровном месте.
    assert.equal(п.defs[0][0], "types");
  });

  test(`схема -- это типы и модели пакета: ${имя}`, () => {
    // Схему план не выдумывает. Третьей записи правила создания таблиц нет:
    // их заводит `db.ensureSchema` на устройстве, одна реализация на всех.
    const пакет = пакеты[имя];
    const схема = план(пакет).schema;
    assert.equal(схема.version, 1);
    assert.deepEqual(схема.types, пакет.types);
    assert.deepEqual(схема.models.map((м) => м.name), пакет.models.map((м) => м.name));
  });
}

/** Пара Ed25519 файлом -- то же, что делает `oneframework keygen`. */
function ключ() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const файл = path.join(mkdtempSync(path.join(tmpdir(), "ключ-")), "издатель.pem");
  writeFileSync(файл, privateKey.export({ type: "pkcs8", format: "pem" }));
  // Голые 32 байта: у DER-обёртки Ed25519 они последние.
  const сырой = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { файл, hex: сырой.toString("hex") };
}

test("ключ издателя -- голый ключ шестнадцатеричным", () => {
  // 64 знака, а не PEM: на устройстве он попадает в
  // `crypto.subtle.importKey("raw", ...)`. Разойдись он с тем, чем подписано,
  // -- подпись перестала бы проверяться, и увидел бы это пользователь.
  const к = ключ();
  assert.equal(план(пакеты.todo, { PYAPP_SIGNING_KEY: к.файл }).publisher, к.hex);
  assert.equal(к.hex.length, 64);
});

test("ключ не назван -- подписи нет", () => {
  // И сборка при этом законна.
  assert.equal(план(пакеты.todo).publisher, null);
});

test("названный и негодный ключ -- отказ", () => {
  // Собрать неподписанное вместо подписанного значит выдать одно за другое, и
  // заметить подмену негде: файл соберётся, подписи в нём просто не окажется.
  const нет = path.join(mkdtempSync(path.join(tmpdir(), "ключ-")), "нет-такого.pem");
  assert.throws(() => план(пакеты.todo, { PYAPP_SIGNING_KEY: нет }), /нет-такого/);
});

const ПОЛОМКИ = {
  "не пакет": [(п) => { for (const к of Object.keys(п)) delete п[к]; п["нет"] = "разделов"; },
               /пакет объявления/],
  "действие без правила": [(п) => { п.logic = [{ actions: [{ name: "Пустышка" }] }]; },
                           /Пустышка/],
  "логика модулем": [(п) => { п.logic = [{ module: "старый.wasm", actions: [] }]; },
                     /старый\.wasm/],
};

for (const [случай, [сломать, слово]] of Object.entries(ПОЛОМКИ)) {
  test(`негодный пакет останавливает план: ${случай}`, () => {
    const пакет = structuredClone(пакеты.todo);
    сломать(пакет);
    assert.throws(() => буквально(пакет), слово);
  });
}

/** Без копии: поломку внесли снаружи, и план обязан на неё наткнуться. */
const буквально = (п) => buildPlan(п);

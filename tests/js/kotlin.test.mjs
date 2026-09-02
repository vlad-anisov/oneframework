/**
 * Привязка Kotlin -- правилами, а не сверкой с питоном.
 *
 * Работу напечатанного проверяет `tests/e2e/notes-kotlin.spec.js`: приложение
 * на Kotlin собирается ядром при физически убранном каталоге `oneframework/`,
 * и кнопка в браузере считает сводку скомпилированным модулем.
 *
 * Здесь остались правила, которые сквозной сюитой не увидеть: как читаются
 * зависимости, куда ложится переходник и что в нём обязано быть.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  commonSources, declare, зависимости, пакетФайла, записатьEntry, записатьMain,
} from "../../src/build/kotlin.mjs";
import { kotlinCompiler } from "../../src/build/teavm.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ПРИЛОЖЕНИЕ = path.join(ROOT, "examples", "notes-kotlin", "App.kt");
const времянка = () => mkdtempSync(path.join(tmpdir(), "kotlin-"));

/** Есть ли на машине компилятор Kotlin: без него котлиновская половина спит. */
const безКомпилятора = (() => {
  try { return !kotlinCompiler(); } catch { return true; }
})();

test("объявление читается текстом исходника", () => {
  // Текстом потому, что иначе курица и яйцо: чтобы напечатать объявление, надо
  // собрать приложение, а чтобы собрать -- знать зависимости, которые названы
  // в объявлении. Не прочитай их сборка -- TeaVM сказал бы «Class ... was not
  // found» уже про чужую беду.
  assert.equal(пакетФайла(ПРИЛОЖЕНИЕ), "notes");
  assert.deepEqual(зависимости(ПРИЛОЖЕНИЕ), [
    "org.apache.commons:commons-text:1.12.0",
    "org.apache.commons:commons-lang3:3.14.0",
  ]);
});

// Нет пакета или зависимостей -- пустая строка и пустой список. Это законные
// приложения, а не поломка: пакет в Kotlin необязателен, а зависимости бывают
// не нужны.
const МУСОР = {
  "без пакета": ["val application = app()\n", "", []],
  "без зависимостей": ["package a.b\n\nval application = app()\n", "a.b", []],
  "пустой listOf": ["package a.b\n\nval x = app(dependencies = listOf())\n", "a.b", []],
};

for (const [случай, [текст, пакет, ждём]] of Object.entries(МУСОР)) {
  test(`исходник ${случай} читается пустым, а не ошибкой`, () => {
    const файл = path.join(времянка(), "App.kt");
    writeFileSync(файл, текст, "utf8");
    assert.equal(пакетФайла(файл), пакет);
    assert.deepEqual(зависимости(файл), ждём);
  });
}

test("порождённый main зовёт emit на объявленном приложении", () => {
  // В самом приложении его нет намеренно: он звал бы `emit`, а тот живёт в
  // JVM-части библиотеки, и файл приложения перестал бы компилироваться под
  // WebAssembly -- ровно то ограничение, ради снятия которого всё и сделано.
  const файл = записатьMain(ПРИЛОЖЕНИЕ);
  const текст = readFileSync(файл, "utf8");
  assert.equal(path.basename(файл), "GeneratedMain.kt");
  assert.ok(текст.includes("fun main() { emit(notes.application) }"), текст);
  assert.ok(текст.startsWith("package oneframework\n"), текст);
});

const ДЕЙСТВИЕ = {
  model: "Note",
  wasm: { entry: "summary", module: "Note", writes: ["details"] },
};

test("порождённый переходник назван так, что TeaVM его найдёт", () => {
  // `Entry.kt` даёт `EntryKt`, которым сборка и зовёт модуль. Назови иначе --
  // TeaVM не найдёт класса и уронит себя `NullPointerException`, ни слова не
  // сказав о причине.
  assert.equal(path.basename(записатьEntry(ПРИЛОЖЕНИЕ, [ДЕЙСТВИЕ])), "Entry.kt");
});

test("переходник несёт то, чего требует договор", () => {
  // Через границу ходит UTF-8 JSON: у стековой машины нет ни словарей, ни
  // списков. Переходник разбирает кадр в набор записей и складывает обратно
  // то, что изменилось; метод модели про это не знает и знать не должен.
  const текст = readFileSync(записатьEntry(ПРИЛОЖЕНИЕ, [ДЕЙСТВИЕ]), "utf8");

  // Строкой целиком, а не вхождением: закомментированный `// @JSExport`
  // содержит то же слово, а модуль наружу не отдаёт ничего -- замерено.
  assert.ok(текст.split("\n").includes("    @JSExport"),
            "без экспорта модуль ничего не отдаст наружу");
  assert.ok(текст.includes("fun summary(frame: String): String"), текст);
  assert.ok(текст.includes('Records.fromJson(frame, listOf("details"))'),
            "список правок -- из объявления: он решает, что модулю позволено писать");
  assert.ok(текст.includes("notes.Note.summary(records)"), "зовётся метод модели с её пакетом");
  assert.ok(текст.includes("records.changedJson()"), текст);
  // Точка входа для TeaVM: он ищет `main(Array<String>)` и выбрасывает всё, до
  // чего от неё не дойти, -- вместе с `@JSExport`.
  assert.ok(текст.includes("fun main(args: Array<String>)"), текст);
  assert.ok(текст.includes("if (args.size > 99)"),
            "условие держит `Entry` достижимым, но не даёт ему исполниться");
});

test("пакет несёт исходники, которые нужны модулю", { skip: безКомпилятора }, () => {
  // Kotlin знает свои действия, но не знает, где лежит библиотека. Вписывает
  // её сборка -- вместе с порождённым переходником. Забудь она это, и модуль
  // собрался бы без библиотеки объявления, то есть не собрался бы.
  const пакет = declare(ПРИЛОЖЕНИЕ);
  const действия = (пакет.logic ?? []).flatMap((з) => з.actions ?? []);
  assert.ok(действия.length, "у примера есть действие -- иначе проверять нечего");
  const источники = действия[0].wasm.sources;
  assert.ok(источники.some((и) => и.endsWith("/Entry.kt")), "нет переходника");
  assert.ok(источники.some((и) => и.endsWith("/App.kt")), "нет самого приложения");
  assert.ok(источники.filter((и) => и.includes("libs/kotlin")).length >= 10,
            `общая библиотека не вписана целиком: ${источники}`);
});

test("библиотека Kotlin находится рядом или по имени", () => {
  // Библиотека объявления живёт в своём репозитории, а нужна ядру: тот же файл
  // приложения собирается дважды -- под JVM и под WebAssembly, -- и оба раза
  // вместе с ней. Пока всё лежало в одном дереве, путь был жёстким; разложи по
  // репозиториям -- и сборка Kotlin перестаёт работать.
  assert.ok(commonSources().length >= 10, "библиотека нашлась, но пуста");
});

test("названная, но негодная библиотека -- отказ", () => {
  // Тот же довод, что у ядра и у ключа подписи: собрать не тем значит выдать
  // одно за другое, а заметить это негде -- модуль соберётся. Отдельным
  // процессом: переменную ядро читает при разборе своего же поиска.
  const скрипт = 'import { commonSources } from "' +
    path.join(ROOT, "libs", "js", "src", "build", "kotlin.mjs") + '";\ncommonSources();\n';
  let вышло = null;
  try {
    execFileSync("node", ["--input-type=module", "-e", скрипт], {
      cwd: ROOT, encoding: "utf8",
      env: { ...process.env, ONEFRAMEWORK_KOTLIN: path.join(времянка(), "нет-такой") },
    });
  } catch (беда) { вышло = беда; }
  assert.ok(вышло, "негодный путь принят молча");
  assert.match(вышло.stderr, /нет-такой/);
  assert.match(вышло.stderr, /main\/kotlin/);
});

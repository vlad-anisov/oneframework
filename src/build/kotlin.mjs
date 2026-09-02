/**
 * Приложение на Kotlin: один файл, две цели.
 *
 * Питона в этой цепочке нет: чтобы объявить приложение на Kotlin, не должно
 * быть нужно ставить питон. Компилятор Kotlin нужен -- он и так нужен.
 *
 * Тот же `App.kt` собирается дважды и разными компиляторами:
 *
 * * **под JVM** -- чтобы напечатать пакет объявления на машине разработчика.
 *   Здесь же работает отражение: имена методов моделей находятся сами, и
 *   помечать их в приложении нечем;
 * * **под WebAssembly** -- чтобы логика работала на устройстве. Отражения там
 *   нет и не нужно: точку входа проставляет сборка.
 *
 * Точки входа обе **порождаются**, а не пишутся руками: и `main()` для JVM, и
 * экспорт для WebAssembly -- это переходники между договором и языком, а не
 * часть приложения.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TeaVMMissing, библиотека, kotlinCompiler, resolve as разрешить } from "./teavm.mjs";

const ЗДЕСЬ = path.dirname(fileURLToPath(import.meta.url));

/**
 * Корень ядра -- по примете, а не по глубине.
 *
 * Глубина у сборщика разная: в общем дереве он лежит в `libs/js/src/build`, в
 * отдельном репозитории -- в `src/build`. Счёт уровней верен ровно в одной
 * раскладке, и в другой перелетает мимо -- поймано первой же сборкой из
 * расколотых деревьев.
 */
export const ROOT = (() => {
  let где = ЗДЕСЬ;
  for (let шаг = 0; шаг < 8; шаг += 1) {
    if (existsSync(path.join(где, "src", "build-db.mjs"))) return где;
    const выше = path.dirname(где);
    if (выше === где) break;
    где = выше;
  }
  return path.resolve(ЗДЕСЬ, "..", "..");
})();

/**
 * Где лежит библиотека объявления на Kotlin.
 *
 * Она живёт в **своём** репозитории (`oneframework-kotlin`), а ядру нужна:
 * тот же файл приложения собирается дважды -- под JVM, чтобы напечатать
 * пакет, и под WebAssembly, чтобы логика работала на устройстве, -- и оба раза
 * вместе с библиотекой.
 *
 * Порядок тот же, что у питоновской привязки, ищущей ядро: сказали прямо --
 * берём сказанное; не сказали -- смотрим рядом. Названный и негодный путь --
 * отказ, а не переход к следующему месту: собрать чужой библиотекой значит
 * выдать одно за другое.
 */
export const ENV_KOTLIN = "ONEFRAMEWORK_KOTLIN";

function библиотекаKotlin() {
  const указано = process.env[ENV_KOTLIN];
  if (указано) {
    const путь = path.resolve(указано);
    if (!existsSync(path.join(путь, "main", "kotlin"))) {
      throw new KotlinMissing(
        `${ENV_KOTLIN} указывает на ${путь}, а библиотеки там нет: не нашлось ` +
        "main/kotlin.");
    }
    return путь;
  }
  // Рядом с ядром -- обе раскладки живые: в общем дереве ядро лежит в
  // `libs/js`, а библиотека рядом в `libs/kotlin`; в отдельных репозиториях
  // они соседи, `oneframework` и `oneframework-kotlin`.
  const где = [
    path.join(ROOT, "..", "kotlin", "src"),
    path.join(ROOT, "..", "oneframework-kotlin", "src"),
  ];
  for (const п of где) if (existsSync(path.join(п, "main", "kotlin"))) return п;
  throw new KotlinMissing(
    "Библиотека объявления на Kotlin не найдена. Искали:\n" +
    где.map((п) => `  ${п}`).join("\n") +
    `\n\nПоложите её рядом -- \`git clone https://github.com/vlad-anisov/` +
    `oneframework-kotlin\` -- либо укажите путь: ${ENV_KOTLIN}=/путь/к/src.`);
}

const COMMON = () => path.join(библиотекаKotlin(), "main", "kotlin");
const JVM_ONLY = () => path.join(библиотекаKotlin(), "jvmMain", "kotlin");

export class KotlinMissing extends TeaVMMissing {}

function всеKt(корень) {
  const out = [];
  const обойти = (к) => {
    for (const имя of readdirSync(к).sort()) {
      const п = path.join(к, имя);
      if (statSync(п).isDirectory()) обойти(п);
      else if (имя.endsWith(".kt")) out.push(п);
    }
  };
  if (existsSync(корень)) обойти(корень);
  // Порядок -- по частям пути, как у `sorted(Path)` в питоне: он входит в
  // отпечаток кэша, и другой порядок значил бы лишнюю пересборку.
  return out.sort((a, b) => {
    const ч = (п) => path.relative(корень, п).split(path.sep);
    const [x, y] = [ч(a), ч(b)];
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return 0;
  });
}

/** Общая часть библиотеки -- та, что понимают оба компилятора. */
export function commonSources() {
  return всеKt(COMMON());
}

/** Что едет в модуль устройства: общая библиотека, приложение, переходник. */
export function wasmSources(appFile, entryFile) {
  return [...commonSources(), String(appFile), String(entryFile)];
}

function генератор(appFile) {
  // Имя файла становится именем класса, поэтому оно ровное, а разводит их
  // папка: дефис в имени файла Kotlin в идентификатор не пускает.
  const куда = path.join(os.tmpdir(), "oneframework-kotlin", "gen",
                         path.basename(appFile, ".kt"));
  mkdirSync(куда, { recursive: true });
  return куда;
}

export function пакетФайла(appFile) {
  for (const строка of readFileSync(appFile, "utf8").split("\n")) {
    if (строка.startsWith("package ")) return строка.slice(8).trim();
  }
  return "";
}

/**
 * Зависимости Maven, названные в файле приложения.
 *
 * Читаются текстом, и это единственное место, где мы так делаем. Иначе --
 * курица и яйцо: чтобы напечатать объявление, надо собрать приложение, а чтобы
 * собрать, надо знать зависимости, которые названы в объявлении.
 */
export function зависимости(appFile) {
  const текст = readFileSync(appFile, "utf8");
  const кусок = /dependencies\s*=\s*listOf\(([^)]*)\)/.exec(текст);
  if (!кусок) return [];
  return [...кусок[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Порождённый `main()`: находит действия отражением и печатает пакет.
 *
 * В самом приложении его нет намеренно. Он звал бы `emit`, а `emit` живёт в
 * JVM-части библиотеки -- и файл приложения перестал бы компилироваться под
 * WebAssembly, то есть ровно то ограничение, которое здесь и снимается.
 */
export function записатьMain(appFile) {
  const пакет = пакетФайла(appFile);
  const ссылка = пакет ? `${пакет}.application` : "application";
  const файл = path.join(генератор(appFile), "GeneratedMain.kt");
  writeFileSync(файл,
    "package oneframework\n\n" +
    "// Порождено сборкой. Переходник между договором и языком.\n" +
    `fun main() { emit(${ссылка}) }\n`, "utf8");
  return файл;
}

/**
 * Порождённый экспорт для WebAssembly.
 *
 * Через границу стековой машины ходит UTF-8 JSON -- у неё нет ни словарей, ни
 * списков (`protocol/logic.json`). Переходник разбирает кадр в набор записей и
 * складывает обратно то, что изменилось; метод модели про это не знает и знать
 * не должен.
 */
export function записатьEntry(appFile, действия) {
  const пакет = пакетФайла(appFile);
  const приставка = пакет ? `${пакет}.` : "";
  const строки = [
    "// Порождено сборкой. Переходник между договором и языком.",
    "package oneframework.generated",
    "",
    "import oneframework.Records",
    "import org.teavm.jso.JSExport",
    "",
    "object Entry {",
  ];
  for (const действие of действия) {
    const модель = действие.model;
    const entry = действие.wasm.entry;
    const writes = действие.wasm.writes.map((и) => JSON.stringify(и)).join(", ");
    строки.push(
      "    @JSExport",
      "    @JvmStatic",
      `    fun ${entry}(frame: String): String {`,
      `        val records = Records.fromJson(frame, listOf(${writes}))`,
      `        ${приставка}${модель}.${entry}(records)`,
      "        return records.changedJson()",
      "    }",
      "");
  }
  // Точка входа для TeaVM: он ищет `main(Array<String>)` и выбрасывает всё, до
  // чего от неё не дойти, -- вместе с `@JSExport`.
  строки.push("}", "", "fun main(args: Array<String>) {",
              "    if (args.size > 99) println(Entry)", "}");
  // Имя файла -- это имя класса: `Entry.kt` даёт `EntryKt`, которым сборка и
  // зовёт модуль. Назови файл иначе -- TeaVM не найдёт класса и уронит себя
  // `NullPointerException`, ни слова не сказав о причине.
  const файл = path.join(генератор(appFile), "Entry.kt");
  writeFileSync(файл, строки.join("\n"), "utf8");
  return файл;
}

/** Собрать приложение под JVM. Возвращает папку классов и имя главного. */
export function собратьJvm(appFile, libraries = []) {
  const mainKt = записатьMain(appFile);
  const исходники = [...commonSources(), ...всеKt(JVM_ONLY()), String(appFile), mainKt];
  // В отпечаток входят и имена: у Kotlin имя файла становится именем класса,
  // поэтому переименование меняет результат сборки, не меняя ни байта
  // содержимого. Один раз уже поймано -- кэш отдал классы под старым именем, и
  // запуск не нашёл главного.
  const хеш = createHash("sha256");
  for (const и of исходники) {
    хеш.update(path.basename(и));
    хеш.update(readFileSync(и));
  }
  const отпечаток = хеш.digest("hex").slice(0, 16);
  const куда = path.join(os.tmpdir(), "oneframework-kotlin", отпечаток);
  const метка = path.join(куда, ".готово");
  if (!existsSync(метка)) {
    mkdirSync(куда, { recursive: true });
    const команда = [kotlinCompiler(), "-nowarn", "-d", куда];
    if (libraries.length) команда.push("-cp", libraries.join(path.delimiter));
    const готово = spawnSync(команда[0], [...команда.slice(1), ...исходники],
                             { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (готово.status !== 0) {
      throw new KotlinMissing(
        `\nKotlin не собрался под JVM:\n${готово.stderr || готово.stdout}\n`);
    }
    writeFileSync(метка, отпечаток, "utf8");
  }
  return [куда, "oneframework.GeneratedMainKt"];
}

/**
 * Собрать приложение под JVM, запустить и вернуть пакет объявления.
 *
 * Рабочая папка -- папка приложения, как и у остальных языков.
 *
 * Напечатанный пакет **дополняется**: Kotlin знает, какие у модели действия,
 * но не знает, где лежат исходники библиотеки. Это дело сборки, и она их сюда
 * и вписывает -- вместе с порождённым переходником.
 */
export function declare(appFile) {
  // Зависимости нужны дважды: когда собирается байткод и когда он исполняется,
  // чтобы напечатать объявление. Прочитать их из объявления нельзя -- оно ещё
  // не напечатано, -- поэтому они читаются из файла приложения тем же
  // способом, что и имя пакета.
  const libraries = разрешить(зависимости(appFile));
  const [классы, главный] = собратьJvm(appFile, libraries);
  const путь = [классы, библиотека("kotlin-stdlib.jar"),
                библиотека("kotlin-reflect.jar"), ...libraries].join(path.delimiter);
  const готово = spawnSync("java", ["-cp", путь, главный], {
    encoding: "utf8", cwd: path.dirname(path.resolve(appFile)),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (готово.status !== 0) {
    throw new KotlinMissing(
      `\n${appFile}: приложение не напечатало объявление.\n` +
      `${готово.stderr || готово.stdout}\n`);
  }

  const пакет = JSON.parse(готово.stdout);
  const действия = (пакет.logic || []).flatMap((з) => з.actions || []);
  if (действия.length) {
    const переходник = записатьEntry(appFile, действия);
    const исходники = wasmSources(appFile, переходник);
    for (const действие of действия) действие.wasm.sources = исходники;
  }
  return пакет;
}

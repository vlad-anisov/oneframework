/**
 * Kotlin на устройстве: байткод -> TeaVM -> WebAssembly.
 *
 * Шаг не питоновский: собрать модуль просит **пакет объявления** (действие с
 * разделом `wasm`), а объявить такое может приложение на любом языке. Живи
 * сборка модулей в питоновском пакете, человек с приложением на Kotlin ставил
 * бы питон ради того, чтобы скомпилировать свой же Kotlin.
 *
 * Почему TeaVM, а не `kotlinc-wasm`: тот собирает **исходник**, и до него не
 * доезжает ни одна обычная библиотека -- компилятор принимает только `.klib`,
 * пересобранные под `wasmJs`. TeaVM работает с байткодом, а любая библиотека с
 * Maven Central -- такой же байткод. Заодно вышло дешевле: 90 КБ по проводу
 * против 320 и две секунды сборки против двадцати.
 *
 * Цель -- `wasm-gc`, а не `js`, хотя `js` легче на 23 КБ: у фреймворка три
 * способа исполнять логику, и собери Kotlin в JavaScript -- третий схлопнулся
 * бы во второй.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const VERSION = "0.14.1";

/**
 * Что нужно TeaVM, чтобы собрать.
 *
 * Список выведен опытом, а не документацией: без `teavm-jso-impl` сборка
 * проходит «с ошибками» и молча даёт нерабочий файл.
 */
export const JARS = {
  "teavm-cli": `org/teavm/teavm-cli/${VERSION}/teavm-cli-${VERSION}-all.jar`,
  "teavm-classlib": `org/teavm/teavm-classlib/${VERSION}/teavm-classlib-${VERSION}.jar`,
  "teavm-platform": `org/teavm/teavm-platform/${VERSION}/teavm-platform-${VERSION}.jar`,
  "teavm-metaprogramming-impl":
    `org/teavm/teavm-metaprogramming-impl/${VERSION}/teavm-metaprogramming-impl-${VERSION}.jar`,
  "teavm-core": `org/teavm/teavm-core/${VERSION}/teavm-core-${VERSION}.jar`,
  "teavm-jso": `org/teavm/teavm-jso/${VERSION}/teavm-jso-${VERSION}.jar`,
  "teavm-jso-apis": `org/teavm/teavm-jso-apis/${VERSION}/teavm-jso-apis-${VERSION}.jar`,
  "teavm-jso-impl": `org/teavm/teavm-jso-impl/${VERSION}/teavm-jso-impl-${VERSION}.jar`,
  "commons-cli": "commons-cli/commons-cli/1.9.0/commons-cli-1.9.0.jar",
};

export const MAVEN = "https://repo1.maven.org/maven2/";

/** Обвязка, поднимающая модуль в браузере. Лежит ресурсом внутри `teavm-core`. */
const RUNTIME_IN_JAR = "org/teavm/backend/wasm/wasm-gc-module-runtime.js";

export class TeaVMMissing extends Error {}

/**
 * Где лежат jar-ы TeaVM.
 *
 * `TEAVM_HOME` -- если сказали явно. Иначе общий кэш, и туда же они
 * скачиваются при первой сборке: требовать от человека вручную собрать девять
 * артефактов, о половине которых не сказано в документации, -- не то, чем
 * стоит встречать. Кэш **тот же**, что у питоновской половины: скачивать одно
 * и то же дважды незачем.
 */
export function home() {
  const указано = process.env.TEAVM_HOME;
  if (указано) return указано;
  return path.join(os.homedir(), ".cache", "oneframework", `teavm-${VERSION}`);
}

function скачать(откуда, куда) {
  // `curl`, а не fetch: fetch тянет весь ответ в память, а jar-ы тут по
  // тридцать мегабайт, и качаются они на машине сборки, где curl есть всегда.
  const готово = spawnSync("curl", ["-fsSL", "-o", куда, откуда], { encoding: "utf8" });
  if (готово.status !== 0) {
    throw new TeaVMMissing(
      `не скачался ${откуда}: ${готово.stderr || готово.status}`);
  }
}

/** Скачать недостающее. Возвращает папку с jar-ами. */
export function ensure() {
  const куда = home();
  mkdirSync(куда, { recursive: true });
  const нужно = Object.entries(JARS)
    .filter(([имя]) => !existsSync(path.join(куда, `${имя}.jar`)));
  if (нужно.length) {
    console.log(`TeaVM ${VERSION}: качаю ${нужно.length} артефакт(ов) в ${куда}`);
    for (const [имя, путь] of нужно) {
      try {
        скачать(MAVEN + путь, path.join(куда, `${имя}.jar`));
      } catch (отказ) {
        throw new TeaVMMissing(
          `${отказ.message}\nПоложите артефакты рядом руками и укажите TEAVM_HOME=${куда}`);
      }
    }
  }
  return куда;
}

/**
 * «группа:артефакт:версия» -> jar-ы в кэше, скачивая недостающие.
 *
 * Без разрешения зависимостей зависимостей: объявляют то, что нужно, и
 * объявляют полностью. Разрешатель -- это Maven, и переписывать его здесь
 * значило бы завести полурабочую копию, которая однажды соврёт о версии.
 */
export function resolve(coordinates) {
  if (!coordinates || !coordinates.length) return [];
  const куда = path.join(home(), "maven");
  mkdirSync(куда, { recursive: true });
  const out = [];
  for (const адрес of coordinates) {
    const части = адрес.split(":");
    if (части.length !== 3) {
      throw new TeaVMMissing(
        `зависимость «${адрес}» записана не так: нужно «группа:артефакт:версия», ` +
        "например «org.apache.commons:commons-text:1.12.0».");
    }
    const [группа, артефакт, версия] = части;
    const файл = path.join(куда, `${артефакт}-${версия}.jar`);
    if (!existsSync(файл)) {
      console.log(`Maven: качаю ${адрес}`);
      скачать(
        `${MAVEN}${группа.replace(/\./g, "/")}/${артефакт}/${версия}/${артефакт}-${версия}.jar`,
        файл);
    }
    out.push(файл);
  }
  return out;
}

export function classpath(куда, extra = []) {
  return [...Object.keys(JARS).map((имя) => path.join(куда, `${имя}.jar`)), ...extra]
    .join(path.delimiter);
}

/** Достать обвязку из jar-а. Она едет к приложению, а не остаётся здесь. */
export function runtime(куда) {
  const вышло = path.join(куда, "wasm-gc-module-runtime.mjs");
  if (!existsSync(вышло)) {
    // Через `unzip -p`: свой распаковщик zip ради одного ресурса -- это
    // сотня строк, которую придётся сопровождать.
    const данные = execFileSync("unzip",
      ["-p", path.join(куда, "teavm-core.jar"), RUNTIME_IN_JAR],
      { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(вышло, данные);
  }
  return вышло;
}

export function kotlinCompiler() {
  const домой = process.env.KOTLIN_HOME;
  if (домой && existsSync(path.join(домой, "bin", "kotlinc-jvm"))) {
    return path.join(домой, "bin", "kotlinc-jvm");
  }
  for (const имя of ["kotlinc-jvm", "kotlinc"]) {
    const найден = spawnSync("which", [имя], { encoding: "utf8" });
    if (найден.status === 0) return найден.stdout.trim();
  }
  throw new TeaVMMissing(
    "Приложение написано на Kotlin, а компилятора нет.\n" +
    "Поставьте его и укажите путь: KOTLIN_HOME=/путь/к/kotlinc");
}

/**
 * Найти jar рядом с компилятором -- в любой из известных раскладок.
 *
 * Раскладок две, и обе живые. У распаковки с сайта jar'ы лежат в
 * `<kotlinc>/lib`; у Homebrew исполняемый файл -- обёртка в `bin`, а настоящее
 * дерево уходит в `libexec`. Считалось, что раскладка одна, и на самой обычной
 * установке под macOS приложение на Kotlin не собиралось вовсе.
 */
export function библиотека(имя) {
  // Ссылку разрешаем: `which kotlinc-jvm` у Homebrew даёт `/opt/homebrew/bin`,
  // а дерево лежит в Cellar. Без этого поиск уходит на два уровня не туда.
  const корень = path.dirname(path.dirname(realpathSync(kotlinCompiler())));
  const где = [path.join(корень, "lib", имя), path.join(корень, "libexec", "lib", имя)];
  for (const п of где) if (existsSync(п)) return п;
  throw new TeaVMMissing(
    `Рядом с компилятором нет ${имя}. Искали:\n${где.map((п) => `  ${п}`).join("\n")}\n` +
    "Укажите распаковку целиком: KOTLIN_HOME=/путь/к/kotlinc");
}

/**
 * Удалась ли сборка -- по коду возврата **и** по выводу.
 *
 * TeaVM не считает ошибкой то, из-за чего файл не заработает: он пишет
 * «Output file built with errors» и выходит с нулём. Один раз уже отдал
 * нерабочий модуль молча.
 *
 * Отдельным правилом, а не строкой внутри запуска: заставить TeaVM выдать
 * такой вывод по заказу не выходит -- отражение и файловую систему он терпит,
 * -- а правило, которое нечем проверить, стоит зелёным навсегда.
 */
export function удалась(код, вывод) {
  return код === 0 && !String(вывод).includes("built with errors");
}

function прогнать(команда, что) {
  const ответ = spawnSync(команда[0], команда.slice(1),
                          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const вывод = `${ответ.stdout || ""}\n${ответ.stderr || ""}`;
  if (!удалась(ответ.status, вывод)) {
    throw new TeaVMMissing(`${что} не удалась:\n${вывод.trim().slice(0, 2000)}`);
  }
}

/**
 * `.kt` -> модуль WebAssembly рядом с приложением.
 *
 * Два шага: `kotlinc-jvm` делает байткод, TeaVM делает из байткода модуль.
 * Кэшируется по отпечатку исходников -- пересборка того же не должна стоить
 * ничего.
 */
export function build(sources, куда, имя, mainClass, libraries = []) {
  const исходники = sources.map(String);
  const хеш = createHash("sha256");
  for (const и of исходники) {
    хеш.update(path.basename(и));
    хеш.update(readFileSync(и));
  }
  const отпечаток = хеш.digest("hex").slice(0, 16);
  const метка = path.join(куда, `.${имя}-${отпечаток}`);
  if (existsSync(метка)) return куда;

  const дом = ensure();
  const kotlin = kotlinCompiler();
  const stdlib = библиотека("kotlin-stdlib.jar");
  const рабочая = path.join(path.dirname(куда), `.teavm-${имя}`);
  if (existsSync(рабочая)) rmSync(рабочая, { recursive: true });
  const классы = path.join(рабочая, "classes");
  mkdirSync(классы, { recursive: true });

  const свои = [path.join(дом, "teavm-jso.jar"), path.join(дом, "teavm-jso-apis.jar"),
                stdlib, ...libraries];
  прогнать([kotlin, "-nowarn", "-cp", свои.join(path.delimiter),
            "-d", классы, ...исходники],
           "сборка байткода (Kotlin)");

  const вывод = path.join(рабочая, "out");
  прогнать(["java", "-cp", classpath(дом, [классы, stdlib, ...libraries]),
            "org.teavm.cli.TeaVMRunner", "-t", "wasm-gc",
            "-d", вывод, "-f", `${имя}.wasm`, mainClass],
           "сборка WebAssembly (TeaVM)");

  if (existsSync(куда)) rmSync(куда, { recursive: true });
  mkdirSync(куда, { recursive: true });
  for (const файл of readdirSync(вывод)) {
    cpSync(path.join(вывод, файл), path.join(куда, файл));
  }
  copyFileSync(runtime(дом), path.join(куда, "runtime.mjs"));
  rmSync(рабочая, { recursive: true });
  writeFileSync(метка, "", "utf8");
  return куда;
}

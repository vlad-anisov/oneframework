/**
 * Сборка под Android: веб -> Capacitor -> Gradle -> APK.
 *
 * В ядре, а не у питоновской привязки. Причина простая: чтобы выпустить
 * приложение, написанное на Kotlin, питон был **обязателен** -- при том, что ни
 * строчки питоновского здесь нет. Всё, что делает этот файл, -- находит SDK и
 * JDK и запускает `npx cap` с `gradlew`.
 *
 * Насквозь, а не наполовину: `oneframework build android` обязан выдать файл,
 * который ставится на телефон, а не список указаний.
 */
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync }
  from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export const APK = path.join("android", "app", "build", "outputs", "apk", "debug",
                             "app-debug.apk");

/** Где лежит Android SDK. Переменная важнее догадки. */
export function найтиSDK(env = process.env) {
  for (const имя of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const где = env[имя];
    if (где && existsSync(где)) return где;
  }
  for (const где of [path.join(homedir(), "Library", "Android", "sdk"),
                     path.join(homedir(), "Android", "Sdk")]) {
    if (existsSync(где)) return где;
  }
  throw new Error(
    "Android SDK не найден. Задайте ANDROID_HOME или поставьте его из Android Studio.");
}

/** Старшая цифра версии JDK: `21.0.8` -> 21, `1.8.0` -> 8. */
export function версияJDK(дом) {
  const бинарь = path.join(дом, "bin", "java");
  if (!existsSync(бинарь)) return null;
  const из = spawnSync(бинарь, ["-version"], { encoding: "utf8" }).stderr || "";
  const м = из.match(/"([\d._]+)"/);
  if (!м) return null;
  const части = м[1].split(".");
  return Number(части[0] === "1" ? части[1] : части[0]) || null;
}

/**
 * JDK не ниже нужного. Берётся **наименьший подходящий**, а не свежайший:
 * Gradle ломается о версии, которых ещё не знает, и «поновее» тут не значит
 * «полу+чше».
 */
export function найтиJDK(минимум = 21, env = process.env) {
  const кандидаты = [];
  if (env.JAVA_HOME && existsSync(env.JAVA_HOME)) кандидаты.push(env.JAVA_HOME);

  const из = spawnSync("/usr/libexec/java_home", ["-V"], { encoding: "utf8" }).stderr || "";
  for (const строка of из.split("\n")) {
    const м = строка.match(/\s(\/\S.*)$/);
    if (м && existsSync(м[1].trim())) кандидаты.push(м[1].trim());
  }
  for (const база of ["/opt/homebrew/opt", "/usr/lib/jvm"]) {
    if (!existsSync(база)) continue;
    for (const имя of readdirSync(база)) {
      if (!имя.includes("jdk")) continue;
      for (const хвост of ["libexec/openjdk.jdk/Contents/Home", "", "Contents/Home"]) {
        const п = хвост ? path.join(база, имя, хвост) : path.join(база, имя);
        if (existsSync(path.join(п, "bin", "javac"))) кандидаты.push(п);
      }
    }
  }
  let лучший = null;
  for (const п of кандидаты) {
    const в = версияJDK(п);
    if (в === null || в < минимум) continue;
    if (лучший === null || в < лучший[0]) лучший = [в, п];
  }
  return лучший ? лучший[1] : null;
}

function запустить(команда, куда, env, что) {
  console.log(`$ ${команда.join(" ")}`);
  const ответ = spawnSync(команда[0], команда.slice(1),
                          { cwd: куда, env: { ...process.env, ...env }, stdio: "inherit" });
  if (ответ.status !== 0) {
    throw new Error(`${что || "команда"} не удалась (код ${ответ.status})`);
  }
}

export function завестиПлатформу(корень, env) {
  if (existsSync(path.join(корень, "android"))) return;
  console.log("Завожу платформу Android для Capacitor...");
  запустить(["npx", "--no-install", "cap", "add", "android"], корень, env, "cap add android");
}

export function писатьLocalProperties(корень, sdk) {
  const цель = path.join(корень, "android", "local.properties");
  const текст = `sdk.dir=${sdk}\n`;
  if (!existsSync(цель) || readFileSync(цель, "utf8") !== текст) {
    writeFileSync(цель, текст);
  }
}

/** Имя пакета -- из конфига Capacitor: его же спрашивает `adb`. */
export function имяПакета(корень) {
  const конфиг = path.join(корень, "capacitor.config.json");
  if (!existsSync(конфиг)) return "com.example.app";
  return JSON.parse(readFileSync(конфиг, "utf8")).appId || "com.example.app";
}

/**
 * Собрать APK. `собратьВеб` приходит доводом: веб внутри APK -- это обычная
 * боевая сборка, и делает её тот же код, что и для браузера.
 */
export function buildAndroid(корень, { собратьВеб, install = false } = {}) {
  if (собратьВеб) собратьВеб();

  const sdk = найтиSDK();
  const jdk = найтиJDK();
  if (jdk === null) {
    throw new Error("JDK 21 или новее не найден: его требует Capacitor 8 "
                    + "(например, `brew install openjdk@21`).");
  }
  console.log(`Android SDK: ${sdk}\nJDK: ${jdk}`);
  const env = { JAVA_HOME: jdk, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };

  завестиПлатформу(корень, env);
  писатьLocalProperties(корень, sdk);
  запустить(["npx", "--no-install", "cap", "sync", "android"], корень, env, "cap sync");

  const gradlew = path.join(корень, "android", "gradlew");
  chmodSync(gradlew, 0o755);
  запустить([gradlew, "assembleDebug", "--console=plain"],
            path.join(корень, "android"), env, "gradle");

  const апк = path.join(корень, APK);
  if (!existsSync(апк)) throw new Error(`Gradle отработал, а APK нет: ${апк}`);
  console.log(`\nAndroid APK:\n${апк}  (${(statSync(апк).size / 1e6).toFixed(1)} МБ)`);

  if (install) {
    const adb = path.join(sdk, "platform-tools", "adb");
    запустить([adb, "install", "-r", апк], корень, env, "adb install");
    запустить([adb, "shell", "monkey", "-p", имяПакета(корень), "-c",
               "android.intent.category.LAUNCHER", "1"], корень, env, "запуск");
  }
  return апк;
}

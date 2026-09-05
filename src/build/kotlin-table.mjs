/**
 * Таблица типов полей -- исходником для Kotlin.
 *
 * Ресурс рядом с классами читает только JVM, а библиотека объявления
 * собирается ещё и под WebAssembly, где никакого classpath нет. Строка есть на
 * обеих платформах -- значит таблица едет строкой.
 *
 * В ядре, а не у привязки: таблица лежит данными и читается всеми тремя
 * одинаково, а порождать из неё исходник для одного из трёх -- работа ядра.
 * Делай это привязка, поправить таблицу и пересобрать Kotlin без неё было бы
 * нельзя.
 *
 *     node src/build/kotlin-table.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ЗДЕСЬ = path.dirname(fileURLToPath(import.meta.url));
const КОРЕНЬ = path.resolve(ЗДЕСЬ, "..", "..", "..", "..");

export const ТАБЛИЦА = path.join(КОРЕНЬ, "protocol", "field-types.json");
export const КУДА = path.join(КОРЕНЬ, "libs", "kotlin", "src", "main", "kotlin",
                              "oneframework", "FieldTypes.kt");

const ШАПКА = `package oneframework

/**
 * Таблица типов полей -- та же, что у питона и у JavaScript.
 *
 * Лежит **исходником**, а не ресурсом рядом с классами: ресурс читает только
 * JVM, а эта библиотека собирается ещё и под WebAssembly, где никакого
 * classpath нет. Строка есть на обеих платформах.
 *
 * Порождается из \`protocol/field-types.json\`
 * (\`node src/build/kotlin-table.mjs\`), совпадение сторожит
 * \`tests/together/test_protocol.py\`. Руками не править: правка уедет при первой
 * пересборке.
 */
internal const val FIELD_TYPES_JSON: String =
`;

/** Файл целиком -- то, что должно лежать в `FieldTypes.kt`. */
export function исходник(таблица = ТАБЛИЦА) {
  const текст = readFileSync(таблица, "utf8");
  // Экранирование JSON почти совпадает с котлиновским, но доллар в Kotlin
  // начинает подстановку. В таблице он есть -- ключ `$comment`.
  const литерал = JSON.stringify(текст).replaceAll("$", "\\$");
  return `${ШАПКА}    ${литерал}\n`;
}

export function записать(куда = КУДА) {
  writeFileSync(куда, исходник(), "utf8");
  return куда;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(записать());
}

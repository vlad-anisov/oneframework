/**
 * Опознание узла выражения и сверка его с договором.
 *
 * Помощником, а не внутри проверки: тем же сверщиком пользуется
 * `tests/together/test_grammar_apps.py`, а ввезти файл проверок нельзя -- он
 * при ввозе запускает свои же проверки и засоряет вывод. Второй записи правила
 * тоже не нужно: два сверщика однажды разойдутся, и разойдутся молча, потому
 * что оба зелёные.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Договор выражений -- источник, а не вывод. Читают его все. */
export const ГРАММАТИКА = JSON.parse(
  readFileSync(path.join(КОРЕНЬ, "protocol", "expression.json"), "utf8"));

/**
 * Какой род договора описывает этот узел. `null` -- ни один.
 *
 * По ключам, а не по значению: род и есть набор ключей, и различать их иначе
 * значило бы завести второе правило о том, что такое узел.
 */
export function узнать(узел) {
  if (!узел || typeof узел !== "object" || Array.isArray(узел)) return null;
  const ключи = new Set(Object.keys(узел));
  for (const [имя, описание] of Object.entries(ГРАММАТИКА.nodes)) {
    const все = Object.keys(описание.keys);
    const обязательные = все.filter((к) => !описание.keys[к].optional);
    if (!обязательные.every((к) => ключи.has(к))) continue;
    if (![...ключи].every((к) => все.includes(к))) continue;
    // Ключ с закрытым списком значений входит в опознание: `{"op": "&"}` и
    // `{"op": "="}` -- разные роды при одинаковых ключах.
    const сходится = все.every((к) => {
      const о = описание.keys[к];
      return !о.one_of || !(к in узел) || о.one_of.includes(узел[к]);
    });
    if (сходится) return имя;
  }
  return null;
}

/** Всё, чем дерево расходится с описанием. Пусто -- значит отвечает. */
export function беды(узел, путь = "выражение") {
  if (узел === null || ["string", "number", "boolean"].includes(typeof узел)) return [];
  if (typeof узел !== "object" || Array.isArray(узел)) {
    return [`${путь}: ${typeof узел} -- не узел выражения`];
  }
  const род = узнать(узел);
  if (род === null) {
    return [`${путь}: ни один род договора не описывает ${Object.keys(узел).sort()}`];
  }
  const описание = ГРАММАТИКА.nodes[род].keys;
  const найдено = [];
  for (const [ключ, значение] of Object.entries(узел)) {
    const о = описание[ключ];
    const где = `${путь}.${ключ}`;
    if (о.name && typeof значение !== "string") {
      найдено.push(`${где}: имя пишется строкой, а тут ${JSON.stringify(значение)}`);
    } else if (о.expr) {
      найдено.push(...беды(значение, где));
    } else if (о.exprs) {
      if (!Array.isArray(значение)) найдено.push(`${где}: ждали список выражений`);
      else значение.forEach((ч, i) => найдено.push(...беды(ч, `${где}[${i}]`)));
    }
  }
  return найдено;
}

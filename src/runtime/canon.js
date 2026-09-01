/**
 * Канонический JSON и отпечаток -- без WASM. Единственная реализация:
 * питоновская удалена 21.08.2026 вместе с выкладкой на питоне.
 *
 * Раньше это считал `core.wasm`: две реализации однажды разошлись, и лечили их
 * вынесением правила в один модуль. Лечение было верным, а лекарство дороже
 * болезни -- модуль потянул за собой мегабайт в браузере и рантайм WASM на
 * сервере.
 *
 * Правило вернулось в оба языка, но сторожит его теперь **чужой стандарт**
 * (RFC 8785), а не наша аккуратность. Две копии, сверяемые внешним эталоном,
 * -- это не то же, что две копии, сверяющие друг друга.
 *
 * Здесь работы меньше, чем в питоне, ровно на одно: правило печати чисел --
 * это и есть `String(число)`, потому что правило взято у ECMAScript. Питону
 * приходится под него подстраиваться, и там оно расписано целиком.
 */

import { sha256Hex } from "./sha256.js";

//: `sha256Hex` ждёт **байты**, а не строку: скормив ей строку, получаешь один
//: и тот же отпечаток для «[]» и «{}» -- она читает `length` и берёт
//: несуществующие элементы. Поймано сверкой, а не глазами.
const utf8 = new TextEncoder();

/** Сколько знаков отпечатка едет в базу. Пара к `canon.FINGERPRINT_CHARS`. */
export const FINGERPRINT_CHARS = 16;

/**
 * Ключи по **кодовым точкам**, а не по кодовым единицам UTF-16.
 *
 * `Array.prototype.sort` без сравнителя делает второе, и на символах вне
 * основной плоскости даёт порядок, обратный питоновскому. Расхождение
 * молчаливое: отпечаток не сойдётся, определение будет считаться вечно
 * изменившимся и ездить кругами.
 */
function byCodePoint(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length - y.length;
}

/** Один и тот же текст при одном и том же смысле. */
export function canonical(value) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      // Отказ здесь, а не отпечаток, который не сойдётся ни с чем и никогда.
      throw new Error("nan и бесконечности не имеют канонической записи");
    }
    return String(value === 0 ? 0 : value);   // -0 печатается нулём
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(byCodePoint);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  throw new Error(`нельзя записать канонически: ${String(value)}`);
}

/** Отпечаток содержимого документа -- начало sha256 канонического текста. */
export function fingerprint(doc) {
  return sha256Hex(utf8.encode(canonical(doc))).slice(0, FINGERPRINT_CHARS);
}

/** Пары `[текст, отпечаток]` в порядке запроса -- форма прежнего ядра. */
export function canonicalMany(docs) {
  return docs.map((doc) => {
    const text = canonical(doc);
    return [text, sha256Hex(utf8.encode(text)).slice(0, FINGERPRINT_CHARS)];
  });
}

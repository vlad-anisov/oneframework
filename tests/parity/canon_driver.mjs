/**
 * Каноническая запись на стороне устройства.
 *
 * Реализация одна, и ожидания записаны в проверке литералами, а не сняты у
 * соседа.
 *
 * Читает со stdin `{docs: [...], numbers: ["3.5", ...]}` и пишет обратно
 * канонический текст и отпечаток каждого документа плюс печать каждого числа.
 *
 * Числа отдельно от документов намеренно: правило печати чисел -- это то
 * место, где два языка расходятся первым, и точные значения удобнее передавать
 * литералом, чем прятать внутрь документа.
 */

import { canonical, fingerprint } from "../../src/runtime/canon.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  const docs = (input.docs || []).map((doc) => {
    try {
      return { ok: { text: canonical(doc), fp: fingerprint(doc) } };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });
  const numbers = (input.numbers || []).map((literal) => String(Number(literal)));
  // Именованные пробы: по одному правилу на имя. Так проверка называет
  // правило, а не индекс в списке.
  const probes = {};
  for (const [имя, doc] of Object.entries(input.probes || {})) {
    try {
      probes[имя] = { text: canonical(doc), fp: fingerprint(doc) };
    } catch (err) {
      probes[имя] = { error: String(err.message || err) };
    }
  }
  // Бесконечность и NaN через JSON не проезжают -- их строит сам драйвер.
  // Правило: такие числа обязаны отказывать, а не попадать в отпечаток; иначе
  // документ, который нельзя записать, получил бы имя и уехал обменом.
  for (const [имя, значение] of [["бесконечность", Infinity], ["минусбесконечность", -Infinity],
                                 ["ненеЧисло", NaN]]) {
    try {
      probes[имя] = { text: canonical({ x: значение }) };
    } catch (err) {
      probes[имя] = { error: String(err.message || err) };
    }
  }
  process.stdout.write(JSON.stringify({ docs, numbers, probes }));
});

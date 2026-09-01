/**
 * Отпечатки от нашей стороны -- питон сверяет их со своим `hashlib`.
 *
 * Сверять надо не с собой, а с той стороной, которая эти отпечатки читает: по
 * ним changeset узнают на другой машине.
 */
import { sha256Hex } from "../../src/runtime/sha256.js";

const образцы = [
  "",
  "a",
  "привет",
  "abc".repeat(100),
  JSON.stringify({ kind: "view", name: "TaskRow" }),
];
const utf8 = new TextEncoder();
const ответ = {};
for (const с of образцы) ответ[с] = sha256Hex(utf8.encode(с));
// И на длинных байтах: граница блока у SHA-256 ровно 64 байта, и ошибки набивки
// видны только вокруг неё.
for (const n of [55, 56, 63, 64, 65, 119, 120, 128]) {
  ответ[`байт:${n}`] = sha256Hex(new Uint8Array(n).map((_, i) => (i * 7) % 256));
}
process.stdout.write(JSON.stringify(ответ));

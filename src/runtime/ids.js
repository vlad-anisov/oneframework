/**
 * Ключ записи. Порт `oneframework/model/ids.py`; там же и объяснение, почему ключ
 * вообще придумывает устройство, а не база.
 *
 * Здесь важно одно: `crypto.randomUUID()` не подходит. Он даёт четвёртую
 * версию, а весь остальной код опирается на то, что строковый порядок ключей
 * совпадает с порядком создания -- на этом держится `ORDER BY id`. Со случайным
 * ключом список не сломается с ошибкой, он просто окажется перемешан, и
 * заметить это можно только глазами.
 */

//: Столько бит отведено счётчику внутри одной миллисекунды (поле rand_a).
const COUNTER_BITS = 12;
const COUNTER_MAX = (1 << COUNTER_BITS) - 1;

let lastMs = 0;
let counter = 0;

const BYTE_HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * Случайные байты. `crypto` есть и в браузере, и в WebView, и в node; ветка с
 * `Math.random` -- только чтобы модуль оставался пригодным в голом окружении
 * вроде теста, а не источником молчаливо предсказуемых ключей.
 */
function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/**
 * Новый ключ строкой.
 *
 * Монотонность внутри миллисекунды держится счётчиком, а не случайностью: seed
 * добавляет десяток записей в одном цикле, все они попадают в одну и ту же
 * миллисекунду, и без счётчика список показался бы перемешанным.
 */
export function newId() {
  const wall = Date.now();
  if (wall > lastMs) {
    lastMs = wall;
    counter = 0;
  } else if (++counter > COUNTER_MAX) {
    // Счётчик кончился -- занимаем следующую миллисекунду. Часы её догонят,
    // а порядок при этом не ломается.
    lastMs += 1;
    counter = 0;
  }

  // 48 бит времени не влезают в побитовые операции JS (они 32-битные), поэтому
  // старшая и младшая половины считаются делением, а не сдвигом.
  const high = Math.floor(lastMs / 0x100000000) & 0xffff;
  const low = lastMs % 0x100000000;
  const time = high.toString(16).padStart(4, "0") + low.toString(16).padStart(8, "0");

  const b = randomBytes(8);
  const version = (0x7000 | counter).toString(16).padStart(4, "0");
  const variant = BYTE_HEX[(b[0] & 0x3f) | 0x80] + BYTE_HEX[b[1]];
  let tail = "";
  for (let i = 2; i < 8; i++) tail += BYTE_HEX[b[i]];

  return `${time.slice(0, 8)}-${time.slice(8)}-${version}-${variant}-${tail}`;
}

/**
 * Похоже ли значение на наш ключ -- вопрос миграции, которой надо отличить уже
 * переехавшую базу от той, где `id` ещё число.
 *
 * Проверка повторяет питоновскую вплоть до вольностей `uuid.UUID`: длина ровно
 * 36, а дальше дефисы выбрасываются целиком, где бы они ни стояли.
 */
export function isId(value) {
  if (typeof value !== "string" || value.length !== 36) return false;
  const hex = value
    .replaceAll("urn:", "")
    .replaceAll("uuid:", "")
    .replace(/^\{+|\}+$/g, "")
    .replaceAll("-", "");
  return /^[0-9a-fA-F]{32}$/.test(hex);
}

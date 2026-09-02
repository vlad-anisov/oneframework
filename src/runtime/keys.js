/**
 * Подпись издателя на стороне устройства.
 *
 * Пары на питоне больше нет: половина, ставящая подпись, переехала в ядро
 * 02.09.2026 (`oneframework keygen` в `libs/js/bin/oneframework.mjs`, ключ
 * читает `build/plan.mjs`). Подписывается сборка, а запускает её ядро -- и
 * пока команда жила у питоновской привязки, приложение на Kotlin подписать
 * было нечем.
 *
 * Устройство только **проверяет**: приватного ключа у него нет и быть не должно
 * -- ключ, разосланный на все устройства, перестаёт что-либо доказывать.
 * Проверяет чужой код: `crypto.subtle` браузера, Ed25519. Своей криптографии
 * здесь нет ни строки, и это не осторожность, а единственный разумный выбор.
 *
 * Всё асинхронно, потому что таков `crypto.subtle`, и это определило место
 * проверок: они стоят там, где рантайм и так асинхронен, -- на старте
 * (`worker.js`, разворачивание модулей) и на приёме обмена. Внутрь отрисовки
 * или обработчика нажатия эта граница не заходит: рантайм за пределами воркера
 * синхронен, и делать его асинхронным ради проверки, которая уже сделана, было
 * бы платой ни за что.
 */

/** Где устройство держит публичный ключ издателя. Пара к `keys.PUBLISHER_META`. */
export const PUBLISHER_META = "publisher:key";

//: Приставки областей. Подпись, сделанная для одной, недействительна для
//: другой: без приставки подпись модуля годилась бы как подпись конверта --
//: отпечаток модуля -- это строка, и он ездит открытым текстом.
export const MODULE = "oneframework/module/v1\n";
export const ENVELOPE = "oneframework/envelope/v1\n";

const encoder = new TextEncoder();

export class SigningError extends Error {
  constructor(message) {
    super(message);
    this.name = "SigningError";
  }
}

/** Ключ издателя, каким его знает это устройство. `null` -- не знает. */
export function publisherKey(db) {
  return db.getMeta(PUBLISHER_META) || null;
}

function fromHex(text, what) {
  const value = String(text ?? "");
  if (value.length % 2 || /[^0-9a-fA-F]/.test(value)) {
    throw new SigningError(`${what} не шестнадцатеричный.`);
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(value.substr(i * 2, 2), 16);
  return out;
}

/**
 * Канонический JSON -- одинаково с питоном, байт в байт.
 *
 * Ключи сортируются на каждом уровне, пробелов нет. Подпись считается по
 * байтам, и словарь, сериализованный в другом порядке, -- это другие байты;
 * разойдись стороны здесь, и отказ выглядел бы как подделка, хотя подделки нет.
 * `JSON.stringify` сортировать не умеет, поэтому порядок задаётся вручную.
 */
export function canonical(value) {
  if (typeof value === "number" && !Number.isInteger(value)) {
    // Замер, а не придирка: `3.0` питон пишет как `3.0`, а `JSON.stringify` --
    // как `3`. Одно значение, разные байты, разная подпись -- и ни одна сторона
    // об этом не узнает. Правило пережило питоновскую половину нарочно: пакет
    // объявления печатает и питон тоже, и дробное в нём разошлось бы так же.
    throw new SigningError(
      `Дробное число ${value} в подписываемом сообщении: питон и JavaScript `
        + "пишут такие числа по-разному, и подпись разошлась бы молча.",
    );
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function message(domain, payload) {
  const body = typeof payload === "string" ? payload : canonical(payload);
  return encoder.encode(domain + body);
}

/**
 * Проверить подпись или отказать, назвав причину.
 *
 * Отказ -- исключение, а не `false`. Проверку, которую можно забыть прочитать,
 * от отсутствующей не отличить, а цена забывчивости здесь -- чужой код на
 * устройстве человека.
 */
export async function verify(publicKeyHex, domain, payload, signature) {
  if (!signature) {
    throw new SigningError(
      "Подписи нет вовсе. Сборка с ключом издателя подписывает всё, что кладёт; "
        + "неподписанное приехало не от неё.",
    );
  }
  const raw = fromHex(publicKeyHex, "Публичный ключ");
  if (raw.length !== 32) {
    throw new SigningError(
      `Публичный ключ длиной ${raw.length} байт, а у Ed25519 он ровно 32.`,
    );
  }
  const sig = fromHex(signature, "Подпись");
  let key;
  try {
    key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch (err) {
    // Ed25519 в WebCrypto появился не во всех движках сразу. Молча пропустить
    // проверку здесь нельзя: это ровно та дыра, которую она закрывает.
    throw new SigningError(
      `Этот движок не умеет Ed25519 в crypto.subtle (${err.message || err}), `
        + "а проверить подпись больше нечем. Исполнять неподтверждённый код "
        + "нельзя.",
    );
  }
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" }, key, sig, message(domain, payload),
  );
  if (!ok) {
    throw new SigningError(
      "Подпись не сходится с ключом издателя. Либо содержимое поменяли после "
        + "подписи, либо подписал не издатель -- различить эти два случая нечем, "
        + "и оба означают одно: исполнять это нельзя.",
    );
  }
}

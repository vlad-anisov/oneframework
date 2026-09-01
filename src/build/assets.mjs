/**
 * Файлы, которые сборка кладёт рядом с приложением: манифест, значки, конфиг.
 *
 * Порт `oneframework/cli/assets.py` -- третья перенесённая часть после плана и
 * пакета. Порт на время переезда: `test_js_assets.py` сверяет байты обеих
 * реализаций, и питоновская уходит вместе со сверкой.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

/**
 * Адрес обмена, каким его увидит устройство.
 *
 * Читается на сборке, а не на устройстве: одно и то же приложение собирается и
 * под стенд, и под боевой адрес, и разница между ними -- переменная окружения,
 * а не правка в исходнике. `PYAPP_SYNC_URL=off` выключает обмен в сборке.
 */
export function syncAddress(meta, env = process.env) {
  const значение = env.PYAPP_SYNC_URL;
  if (значение === undefined) return meta;
  const с = значение.trim();
  return { ...meta, sync: ["", "off", "0", "none"].includes(с.toLowerCase()) ? false : с };
}

/**
 * То, что рантайму нужно до первого запроса к базе.
 *
 * Разделы и оформление читаются раньше, чем открывается база: по ним рисуется
 * оболочка. Всё остальное -- схема, документы, записи -- берётся из базы.
 */
export function buildManifest(root, пакет, статика = { scripts: [], styles: [] }) {
  const out = path.join(root, "web", "public", "oneframework-manifest.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    meta: syncAddress(пакет.meta()),
    db_name: пакет.db_name,
    scripts: статика.scripts,
    styles: статика.styles,
  }), "utf8");
  return out;
}

/**
 * Минимальный кодировщик RGBA PNG -- чтобы не тащить зависимость ради значка.
 *
 * Байты обязаны совпасть с питоновскими: сверка иначе сравнивала бы картинки
 * на глаз. Совпадают они потому, что оба сжимают zlib'ом на девятом уровне --
 * замерено, вывод тот же.
 */
export function png(size, pixels) {
  const строка = size * 4 + 1;
  const raw = Buffer.alloc(строка * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * строка] = 0;                       // фильтр строки -- «никакой»
    for (let x = 0; x < size; x += 1) {
      const п = pixels[y][x];
      raw.set(п, y * строка + 1 + x * 4);
    }
  }
  const кусок = (тег, данные) => {
    const длина = Buffer.alloc(4);
    длина.writeUInt32BE(данные.length);
    const тело = Buffer.concat([Buffer.from(тег, "ascii"), данные]);
    const сумма = Buffer.alloc(4);
    сумма.writeUInt32BE(crc32(тело) >>> 0);
    return Buffer.concat([длина, тело, сумма]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    кусок("IHDR", ihdr),
    кусок("IDAT", deflateSync(raw, { level: 9 })),
    кусок("IEND", Buffer.alloc(0)),
  ]);
}

const ТАБЛИЦА_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = ТАБЛИЦА_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Заливка и белая галочка двумя толстыми отрезками. */
export function iconPixels(size, bg = [103, 80, 164], fg = [255, 255, 255]) {
  const px = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => [bg[0], bg[1], bg[2], 255]));
  const s = size / 48.0;
  const толщина = 4.0 * s;
  const отрезки = [
    [13 * s, 25 * s, 20 * s, 32 * s],
    [20 * s, 32 * s, 35 * s, 16 * s],
  ];
  const расстояние = (px_, py_, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const длина = dx * dx + dy * dy;
    const t = длина === 0 ? 0 : Math.max(0, Math.min(1, ((px_ - ax) * dx + (py_ - ay) * dy) / длина));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.sqrt((px_ - cx) ** 2 + (py_ - cy) ** 2);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.min(...отрезки.map((о) => расстояние(x + 0.5, y + 0.5, ...о)));
      const край = толщина / 2.0;
      let alpha;
      if (d <= край) alpha = 1.0;
      else if (d <= край + 1.2) alpha = 1.0 - (d - край) / 1.2;   // дешёвое сглаживание
      else continue;
      const база = px[y][x];
      px[y][x] = [
        Math.trunc(база[0] + (fg[0] - база[0]) * alpha),
        Math.trunc(база[1] + (fg[1] - база[1]) * alpha),
        Math.trunc(база[2] + (fg[2] - база[2]) * alpha),
        255,
      ];
    }
  }
  return px;
}

export function writePwaAssets(root, title) {
  const public_ = path.join(root, "web", "public");
  const icons = path.join(public_, "icons");
  mkdirSync(icons, { recursive: true });

  for (const size of [192, 512]) {
    const цель = path.join(icons, `icon-${size}.png`);
    if (!existsSync(цель)) writeFileSync(цель, png(size, iconPixels(size)));
  }

  writeFileSync(path.join(public_, "manifest.webmanifest"), JSON.stringify({
    name: title,
    short_name: title,
    start_url: "./index.html",
    scope: "./",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fef7ff",
    theme_color: "#fef7ff",
    icons: [192, 512].map((size) => ({
      src: `./icons/icon-${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any maskable",
    })),
  }, null, 2), "utf8");
}

export { createHash, readFileSync };

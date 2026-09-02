/**
 * Пакет объявления: прочитать, проверить, ответить на вопросы сборки.
 *
 * Порт `Bundle` из `oneframework/declaration.py`. Копия уходит вместе со
 * сверкой, не раньше -- две живые реализации одного правила расходятся молча.
 *
 * Чем написано приложение -- питоном, Kotlin или JavaScript -- отсюда не
 * видно, и в этом весь смысл.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Порядок системных полей -- из **договора**, а не из копии у привязки.
 *
 * Раньше читалось `../types.mjs` -- таблица типов, лежащая рядом с библиотекой
 * на JavaScript. Внутри одного дерева это работало, а на деле означало, что
 * ядро зависит от привязки: разложи их по репозиториям -- и сборщик не
 * поднимется. Нашлось при первой же раскладке.
 *
 * Ищется вверх по дереву, а не относительным путём: глубина у сборщика разная
 * в монорепозитории и в изданном пакете, и жёсткий путь верен ровно в одном
 * из них. Читается **копия рядом с пакетом**, а не `protocol/`: у того, кто
 * пакет поставил, дерева с договором нет.
 */
function договор() {
  let где = dirname(fileURLToPath(import.meta.url));
  for (let шаг = 0; шаг < 8; шаг += 1) {
    // Копия договора рядом с корнем пакета -- она и едет в поставке: у
    // поставившего пакет никакого дерева с `protocol/` нет. Совпадение копии
    // с договором сторожит `tests/test_protocol.py`.
    try {
      return JSON.parse(readFileSync(join(где, "field-types.json"), "utf8"));
    } catch { /* нет так нет -- ищем выше */ }
    const выше = dirname(где);
    if (выше === где) break;
    где = выше;
  }
  throw new Error(
    "Не нашёлся field-types.json рядом с пакетом. Без него неизвестен порядок " +
    "системных полей, а он решает, каким полем начинается карточка.");
}

const SYSTEM_FIELD_ORDER = договор().system_field_order;

/** Версия договора. Та же, что в `protocol/declaration.json`. */
export const VERSION = 1;

/** Разделы, обязательные **ключом**, а не содержимым. */
const РАЗДЕЛЫ = ["app", "types", "models", "views", "logic", "seeds"];

export class DeclarationError extends Error {}

export class Bundle {
  constructor(doc, { source = null } = {}) {
    if (doc?.oneframework !== VERSION) {
      throw new DeclarationError(
        `Пакет объявления версии ${JSON.stringify(doc?.oneframework)}, а эта ` +
        `сборка понимает ${VERSION}. Обновите библиотеку своего языка.`,
      );
    }
    // Пустой список -- законный ответ «их нет», отсутствие ключа -- потерянный
    // раздел, и по пакету их не различить.
    for (const key of РАЗДЕЛЫ) {
      if (!(key in doc)) {
        throw new DeclarationError(`В пакете объявления нет раздела «${key}».`);
      }
    }

    this.doc = doc;
    //: Откуда пакет приехал -- показывается в сообщениях об отказе.
    this.source = source;
    const сведения = doc.app;
    this.title = сведения.title;
    this.color = сведения.color ?? "#6750A4";
    this.dynamic_color = сведения.dynamic_color ?? false;
    this.locale = сведения.locale ?? null;
    this.theme = сведения.theme ?? "auto";
    this.sync = сведения.sync ?? null;
    this.root_view = сведения.root;
    this.screens = сведения.screens || [];
    this.python_packages = [...(сведения.python_packages || [])];
    //: Зависимости с Maven Central. Нужны сборке модуля, на устройство сами по
    //: себе не едут.
    this.maven = [...(сведения.maven || [])];
    this.db_name = сведения.db_name || `${slug(this.title)}.db`;
    this.types = doc.types;
    this.model_docs = doc.models;
    this.view_docs = doc.views;
    this.logic = doc.logic || [];
    //: Демо-данные строками. Пустой список -- законный ответ «их нет».
    this.seeds = doc.seeds || [];
    this.#проверить();
  }

  /**
   * Поймать неполный пакет здесь, а не в пустом экране на устройстве.
   *
   * Проверяется то, чего сборка не переживёт: неизвестный тип поля, вид,
   * привязанный к несуществующей модели, корневой вид, которого нет.
   */
  #проверить() {
    const имена_моделей = new Set(this.model_docs.map((m) => m.name));
    for (const модель of this.model_docs) {
      for (const поле of модель.fields) {
        if (!(поле.ftype in this.types)) {
          throw new DeclarationError(
            `${модель.name}.${поле.name}: тип «${поле.ftype}» не описан в ` +
            `разделе «types» пакета. Известны: ` +
            `${Object.keys(this.types).sort().join(", ")}.`,
          );
        }
      }
    }
    const имена_видов = new Set(this.view_docs.map((v) => v.name));
    for (const вид of this.view_docs) {
      const модель = вид.model;
      if (модель != null && !имена_моделей.has(модель)) {
        throw new DeclarationError(
          `Вид «${вид.name}» привязан к модели «${модель}», которой в пакете нет.`,
        );
      }
    }
    if (!имена_видов.has(this.root_view)) {
      throw new DeclarationError(
        `Корневой вид «${this.root_view}» не объявлен. Есть: ` +
        `${[...имена_видов].sort().join(", ") || "ни одного"}.`,
      );
    }
  }

  /**
   * Сведения, которые рантайм читает **до** первого запроса к базе.
   *
   * Собираются здесь, а не в каждой библиотеке: это производная от типов и
   * моделей, и требовать её от Kotlin значило бы просить его повторить вывод,
   * который и так однозначен.
   */
  meta() {
    const модели = {};
    for (const м of this.model_docs) {
      const поля = {};
      for (const поле of полявПорядкеМодели(м)) {
        поля[поле.name] = {
          type: поле.ftype,
          label: подпись(поле),
          required: Boolean(поле.required ?? false),
          widgets: [...this.types[поле.ftype].widgets],
          default_widget: поле.widget || this.types[поле.ftype].widget,
          // Только у ссылки на одну запись: рантайм спрашивает comodel, чтобы
          // нарисовать выбор. У набора записей выбирать нечего.
          comodel: (поле.ftype === "many2one" || поле.ftype === "one2one")
            ? (поле.comodel ?? null) : null,
        };
      }
      модели[м.name] = {
        label: м.label ?? м.name,
        table: м.table,
        display_field: чемНазывается(м),
        fields: поля,
      };
    }
    return {
      title: this.title,
      root: this.root_view,
      screens: this.screens,
      color: this.color,
      locale: this.locale,
      theme: this.theme,
      sync: this.sync,
      models: модели,
    };
  }

  logic_modules() {
    return [...this.logic];
  }

  toString() {
    const откуда = this.source ? ` из ${this.source}` : "";
    return `<Bundle '${this.title}' моделей=${this.model_docs.length} ` +
      `видов=${this.view_docs.length}${откуда}>`;
  }
}

/** Прочитать пакет из файла. */
export function load(path, readFile) {
  let doc;
  try {
    doc = JSON.parse(readFile(path));
  } catch (отказ) {
    throw new DeclarationError(`${path}: это не JSON -- ${отказ.message}`);
  }
  return new Bundle(doc, { source: String(path) });
}

export function slug(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "app";
}

/**
 * Порядок, в котором поля лежат у модели: сперва ``id``, потом объявленные.
 *
 * Документ печатает поля в порядке объявления, а ``meta`` -- в порядке
 * словаря полей, и это разные порядки. Разница видна на устройстве: первым в
 * карточке рисуется первое поле, и перепутать их значит переставить экран.
 */
function полявПорядкеМодели(модель) {
  const поИмени = new Map(модель.fields.map((f) => [f.name, f]));
  const порядок = поИмени.has("id") ? [поИмени.get("id")] : [];
  порядок.push(...модель.fields.filter((f) => !SYSTEM_FIELD_ORDER.includes(f.name)));
  for (const имя of SYSTEM_FIELD_ORDER.slice(1)) {
    if (поИмени.has(имя)) порядок.push(поИмени.get(имя));
  }
  return порядок;
}

/**
 * Подпись поля на экране: объявленная, иначе выведенная из имени.
 *
 * В документе подпись лежит, только если её объявили, -- поэтому вывести её
 * обязан тот, кто документ читает, и обязан ровно так же, иначе у
 * Kotlin-приложения поле подпишется иначе, чем у питоновского.
 */
function подпись(поле) {
  if (поле.label) return поле.label;
  const с = поле.name.replace(/_/g, " ");
  return с.charAt(0).toUpperCase() + с.slice(1).toLowerCase();
}

/** Чем запись называется: ``name``, иначе первая строка, иначе ничего. */
function чемНазывается(модель) {
  const поля = модель.fields.filter((f) => !f.system);
  if (поля.some((f) => f.name === "name")) return "name";
  const строка = поля.find((f) => f.ftype === "string");
  return строка ? строка.name : null;
}

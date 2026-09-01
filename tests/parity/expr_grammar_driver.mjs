/**
 * Что порождает библиотека объявления на JavaScript -- против общего описания.
 *
 * Читает со stdin `protocol/expression.json` и собирает по образцу каждого узла
 * свой -- теми же средствами, какими его собрало бы приложение. Сверяет питон,
 * и сверяет побайтно: «похоже» здесь не значит ничего, потому что разошедшийся
 * узел доезжает не ошибкой, а не тем условием на экране.
 *
 * Узел, которого библиотека не умеет, попадает в `missing`. Отставание тогда --
 * число, а не впечатление от чтения трёх файлов подряд.
 */

import { Bool, Cmp, Not, Order, Ref, toJson } from "../../src/expr.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const grammar = JSON.parse(raw);
  // Дырка «любое вложенное выражение» -- ссылка на поле записи. Имя берётся из
  // самого договора: иначе ответ пришлось бы сравнивать «примерно», а не с
  // образцом.
  const child = () => new Ref(grammar.sentinels.child.r);
  const имя = grammar.sentinels.name;

  /** Чем библиотека собирает узел грамматики. Чего здесь нет -- того не умеет. */
  const build = {
    record_ref: () => new Ref(имя),
    view_ref: () => new Ref(имя, "view"),
    item_ref: () => new Ref(имя, "item"),
    cmp: (sample) => new Cmp(sample.op, child(), child()),
    and: (sample) => new Bool(sample.op, [child(), child()]),
    or: (sample) => new Bool(sample.op, [child(), child()]),
    not: () => new Not(child()),
    order: (sample) => new Order(child(), sample.dir),
  };

  const built = {};
  const refused = {};
  const missing = [];
  for (const [node, shape] of Object.entries(grammar.nodes)) {
    if (!build[node]) {
      missing.push(node);
      continue;
    }
    try {
      built[node] = toJson(build[node](shape.sample));
    } catch (err) {
      refused[node] = String(err.message || err);
    }
  }

  // Чужой узел обязан отказать вслух. Молчаливое «что-нибудь» здесь хуже
  // отказа: оно уедет в документ вида и покажет не те записи.
  let unknown = { refused: true };
  try {
    unknown = { refused: false, value: toJson({ похоже: "на выражение" }) };
  } catch (err) {
    unknown = { refused: true, message: String(err.message || err) };
  }

  process.stdout.write(JSON.stringify({ built, refused, missing, unknown }));
});

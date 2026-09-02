/**
 * Сведение описания строки с вектором ответов записи.
 *
 * Отдельным файлом от `nodes.jsx`, потому что это **провод**, а не рисование:
 * ни одного узла React здесь нет, зато есть вторая половина формы, которую
 * задаёт `protocol/wire.json`. Разница не в опрятности -- проверки провода
 * (`tests/js/wire.test.mjs`, `tests/js/runtime.test.mjs`) обязаны звать ту
 * самую функцию, которой рисуют, а `.jsx` под Node не ввозится: пока она жила
 * там, у проверок была её копия -- и копия расходилась бы молча.
 */

/**
 * Одна запись как строка, которую рисует истолкователь: описание строки списка,
 * в которое подставлены ответы этой записи.
 *
 * Вторая половина формы, которую задаёт `protocol/wire.json`. Список везёт одно
 * описание своей строки -- узлы, их ключи, их подписи, весь словарь связи -- и
 * по вектору ответов на запись. Сводит их эта функция, и делает это *после*
 * окна, поэтому список из десяти тысяч записей строит те тридцать строк,
 * которые на экране, и ни одной сверх.
 *
 * Собственный ключ записи -- не слот: всякая ячейка строки принадлежит одной и
 * той же записи, поэтому он подставляется здесь, а не повторяется в каждом
 * векторе. Не слот и `related` у many2one -- варианты стоят на узле один раз, а
 * значение указывает внутрь них.
 */
export function bindRow(template, row) {
  const values = row.v;
  const bind = (n) => {
    const out = { ...n };
    const slots = out.bind;
    if (slots) delete out.bind;
    if (out.children) out.children = out.children.map(bind);
    if (slots) for (const [key, index] of Object.entries(slots)) out[key] = values[index];
    if (out.type === "field") {
      if (out.scope === "record") {
        out.record_id = row.id;
        if (out.ftype === "many2one" || out.ftype === "one2one") {
          out.related = (out.choices || []).find((c) => c.id === out.value) ?? null;
        }
      }
    } else if (out.type === "button") {
      out.context = { ...out.context, record_id: row.id };
    }
    return out;
  };
  const entry = {
    id: row.id,
    openable: template.openable,
    children: template.children.map(bind),
  };
  if (template.cells) entry.cells = template.cells.map(bind);
  return entry;
}

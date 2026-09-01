/**
 * Обстановка, в которой рисуется узел.
 *
 * Ни одно решение здесь не зависит от модели или имени поля -- только от того,
 * *где* узел рисуется: в форме, в строке списка или в баре. Отсюда же уходят
 * все события: узел не знает ни про рантайм, ни про воркер, он знает `commit` и
 * `action`.
 *
 * Одна обстановка на экран, и она же -- граница между истолкователем и
 * оболочкой: всё, что открывает лист или диалог, приходит сюда вызовом, а не
 * своей веткой внутри виджета.
 */
import { confirmAction, openListMenu, pickRelation } from "./menus.js";

/** Уже поперёк экрана: столбцы со своими заголовками помещаются. */
export const TABLE_MIN_WIDTH = 560;

/** Экран показывает одну запись? */
export const isRecordScreen = (screen) => screen.record_id != null || !!screen.draft;

/**
 * Запись значения -- одно из двух событий, и выбор между ними принадлежит полю.
 *
 * `view.x` -- состояние экрана, оно нигде не хранится; `record.x` -- колонка
 * записи. Разделение приходит с узлом (`scope`), а не выясняется здесь.
 */
export const commitOf = (dispatch) => (n, value) =>
  dispatch(
    n.scope === "view"
      ? { type: "set_state", screen_id: n.screen_id, field: n.name, value }
      : {
          type: "write", model: n.model, record_id: n.record_id,
          screen_id: n.screen_id, values: { [n.name]: value },
        },
  );

/**
 * Обстановка страницы.
 *
 * `measure` отдаёт прокручиваемый элемент: с листаемыми вкладками их несколько,
 * по одному на страницу, поэтому спрашивается он на каждое чтение, а не
 * запоминается один раз.
 */
export function pageCtx({ f7, dispatch, screen, store, measure, bodyWidth }) {
  const mode = isRecordScreen(screen) ? "form" : "plain";
  return {
    //: сам Framework7: составляющие, которых нет объявительной формы, заводит
    //: тот виджет, которому они нужны, -- и он же их убирает
    f7,
    //: виджет модуля вправе спросить, на каком он экране
    screen,
    mode,
    screenMode: mode,
    dispatch,
    commit: commitOf(dispatch),
    scrollTop: () => measure()?.scrollTop ?? 0,
    viewportHeight: () => measure()?.clientHeight ?? 800,
    action: (n) =>
      confirmAction(f7, n, () =>
        dispatch({ type: "action", button_id: n.id, context: n.context })),
    act: (event) => dispatch(event),
    pickRelation: (n) => pickRelation(f7, n, dispatch),
    // Строки или таблица -- решается по ширине коробки самого списка.
    wantsTable: (n) =>
      n.display === "table"
      && (n.columns || []).length > 1
      && bodyWidth() >= TABLE_MIN_WIDTH,
    open: (listId, recordId) =>
      dispatch({ type: "open", list_id: listId, record_id: recordId }),
    search: (listId, value) => dispatch({ type: "set_search", list_id: listId, value }),
    filter: (listId, index) => dispatch({ type: "set_filter", list_id: listId, index }),
    listMenu: (n) => openListMenu(f7, n, dispatch),
    tabOf: (id) => store.tab(id),
    setTab: (id, tab) => store.setTab(id, tab),
  };
}

/**
 * Обстановка бара: `mode: "navbar"`.
 *
 * Не «form» -- в баре нет строк с подписями -- и не «row»: подписанное действие
 * в баре ссылка, а в строке кнопка. Всё остальное -- то же самое, что у
 * страницы: та же запись, та же отправка, те же меню.
 */
export function navbarCtx({ f7, dispatch, store }) {
  return {
    f7,
    mode: "navbar",
    screenMode: "navbar",
    dispatch,
    commit: commitOf(dispatch),
    action: (n) => dispatch({ type: "action", button_id: n.id, context: n.context }),
    act: (event) => dispatch(event),
    listMenu: (n) => openListMenu(f7, n, dispatch),
    pickRelation: (n) => pickRelation(f7, n, dispatch),
    tabOf: (id) => store.tab(id),
    setTab: (id, tab) => store.setTab(id, tab),
    wantsTable: () => false,
    scrollTop: () => 0,
    viewportHeight: () => 800,
  };
}

/**
 * Список на экране, вглубь.
 *
 * Список может лежать внутри группы или вкладки -- но ищется он только в
 * открытой вкладке: прокручивают ту, и подкачка страниц принадлежит ей.
 */
export function findList(nodes, tabOf) {
  for (const n of nodes || []) {
    if (n.type === "list") return n;
    let children = n.children;
    if (n.type === "tabs") {
      const pages = (n.children || []).filter((c) => c.type === "tab");
      const active = tabOf(n.id) ?? pages[0]?.id;
      children = pages.filter((c) => c.id === active);
    }
    const found = findList(children, tabOf);
    if (found) return found;
  }
  return null;
}

/**
 * Плавающее действие экрана.
 *
 * `Button(place="fab")`, объявленное на экране или на вкладке. Вкладкино
 * принадлежит экрану ровно так же -- оно висит над всей страницей, -- но только
 * то, чья страница открыта, а какая открыта, знает одна оболочка.
 */
export function fabButton(screen, tabOf) {
  return tabFab(screen.children, tabOf)
    || (screen.navbar_buttons || []).find((b) => b.place === "fab")
    || null;
}

function tabFab(nodes, tabOf) {
  for (const n of nodes || []) {
    if (n.type === "tabs") {
      const pages = (n.children || []).filter((c) => c.type === "tab");
      const open = pages.find((c) => c.id === (tabOf(n.id) ?? pages[0]?.id));
      const found = open && (open.fab || tabFab(open.children, tabOf));
      if (found) return found;
      continue;
    }
    const found = tabFab(n.children, tabOf);
    if (found) return found;
  }
  return null;
}

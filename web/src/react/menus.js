/**
 * Листы действий и диалоги -- то, что остаётся повелительным и после переезда.
 *
 * Лист действий не часть кадра: он живёт ровно от нажатия до выбора, ничего на
 * экране не занимает и закрывается сам. Держать его состоянием React означало
 * бы описывать в дереве то, чего в дереве нет, и вручную сводить «открыт» с
 * тем, открыт ли он на самом деле. Framework7 умеет это сам, и `f7.actions` --
 * ровно тот случай, для которого повелительный вызов и уместен.
 */
import { t } from "../i18n.js";

/**
 * Группа, закрывающая лист, там где она у платформы есть.
 *
 * iOS-лист всегда кончается «Отменой» -- она часть органа управления, и лист
 * без неё читается незаконченным. У материальной нижней карточки её нет
 * никогда: она закрывается касанием мимо или движением вниз, а строка «Отмена»
 * была бы вторым способом ничего не сделать. Поэтому группа -- темы, а не наша.
 */
const cancelGroup = (f7) => (f7.theme === "ios" ? [[{ text: t("cancel"), color: "red" }]] : []);

/** Все записи сомодели плюс строка «не указано». */
export function pickRelation(f7, node, dispatch) {
  const pick = (id) =>
    dispatch({
      type: "write", model: node.model, record_id: node.record_id,
      screen_id: node.screen_id, values: { [node.name]: id },
    });
  f7.actions
    .create({
      buttons: [
        [
          { text: node.placeholder || node.label, label: true },
          ...(node.choices || []).map((choice) => ({
            text: choice.display,
            onClick: () => pick(choice.id),
          })),
          { text: t("none"), onClick: () => pick(null) },
        ],
        ...cancelGroup(f7),
      ],
    })
    .open();
}

/** Что стоит за тремя точками в шапке списка: собственные действия списка. */
export function openListMenu(f7, node, dispatch) {
  // Либо список, которому меню принадлежит, либо само меню -- меню записи в
  // верхнем баре приезжает без всякой обёртки.
  const menu = node.type === "menu" ? node : node.menu;
  const buttons = (menu?.children || []).filter((b) => b.type === "button");
  if (!buttons.length) return;
  f7.actions
    .create({
      buttons: [
        buttons.map((b) => ({
          text: b.label,
          // Красным на iOS помечена разрушительная строка -- там лист действий
          // так и устроен. Материальное меню всё одним цветом: сторожит там
          // подтверждение, которое идёт следом. Одна и та же кнопка говорит
          // одно и то же голосом своей платформы.
          color: b.style === "destructive" && f7.theme === "ios" ? "red" : undefined,
          // Строка меню, которой не над чем работать, остаётся на месте и
          // гаснет -- а не появляется и исчезает вслед за списком.
          disabled: b.enabled === false,
          onClick: () => dispatch({ type: "action", button_id: b.id, context: b.context }),
        })),
        ...cancelGroup(f7),
      ],
    })
    .open();
}


/** Разрушительное действие с подтверждением: диалог Framework7, слова -- DSL. */
export function confirmAction(f7, node, run) {
  if (node.action.type !== "delete" || !node.action.confirm) {
    run();
    return;
  }
  f7.dialog
    .create({
      title: typeof node.action.confirm === "string" ? node.action.confirm : t("confirmDelete"),
      buttons: [{ text: t("cancel") }, { text: t("delete"), color: "red", onClick: run }],
      verticalButtons: false,
    })
    .open();
}

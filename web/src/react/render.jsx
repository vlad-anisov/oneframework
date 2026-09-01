/**
 * Обход документа: тип узла -> составляющая, и граница вокруг каждого.
 *
 * Отдельным файлом не ради красоты. Обход -- то единственное место, которое
 * могла бы забрать чужая библиотека, и его размер -- ответ на вопрос «а нет ли
 * готового». Пока он лежал вперемешку с составляющими, ответ приходилось
 * вычислять заново. Тот же приём у openHAB -- единственной живой системы с тем
 * же устройством, виды в базе и отрисовка в Framework7: у них обход это
 * `generic-widget-component.vue`, 110 строк, против 13 739 строк виджетов.
 *
 * Сами составляющие живут в `nodes.jsx` и записываются сюда `registerNode`.
 * Роспись, а не `switch`, по двум причинам: она разрывает круг ввоза (обходу
 * не нужно знать про составляющие, только им про обход) и позволяет сверить
 * заполненность с `NODE_TYPES` -- обещанием, которое даёт схема.
 */
import React from "react";

import { preformatted } from "../text.js";

export const NODE_TYPES = [
  "view", "row", "col", "group", "accordion", "section",
  "tabs", "tab", "pill", "text", "icon", "field", "button", "list", "menu",
];

/**
 * Всё, что пошло не так, -- в собственном красном блоке Framework7.
 *
 * Вывезен, потому что зовут его двое: граница вокруг сломанного виджета и
 * экран, которому рантайм вернул отказ (`nodes.jsx`). У второго он был не
 * ввезён, и **показ ошибки падал сам**: вместо объяснения на странице
 * оказывалось `ErrorBox is not defined`, а настоящая причина не доезжала
 * вовсе. Хуже отсутствия сообщения только сообщение о сломанном сообщении.
 */
export const ErrorBox = ({ text }) => (
  <div
    className="block block-strong inset color-red text-color-primary"
    dangerouslySetInnerHTML={{ __html: preformatted(text) }}
  />
);

/**
 * Один сломанный виджет не должен уносить экран с собой.
 *
 * Раньше это был `try/catch` вокруг построения узла. В React ошибка отрисовки
 * поднимается вверх по дереву, и поймать её может только граница -- причём
 * только у *потомка*, не у себя. Отсюда два компонента на узел: граница и то,
 * что внутри неё строится.
 */
const where = (n) =>
  `${n.type}${n.name ? ` ${n.name}` : ""}${n.widget ? `(widget="${n.widget}")` : ""}`;

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    // Узел приезжает новым объектом на каждый кадр, поэтому попытка повторяется
    // с каждым кадром -- ровно как повторялась с каждой заплаткой.
    if (this.state.error && prev.n !== this.props.n) this.setState({ error: null });
  }

  componentDidCatch(error) {
    console.error(`[oneframework/nodes] ${where(this.props.n)}`, error);
  }

  render() {
    if (this.state.error) {
      return <ErrorBox text={`${where(this.props.n)}: ${this.state.error.message}`} />;
    }
    return <NodeBody n={this.props.n} ctx={this.props.ctx} />;
  }
}

/** Узел с ключом и границей -- всё, чем узел приходит в дерево. */
export const node = (n, ctx) => <Boundary key={n.id} n={n} ctx={ctx} />;


const ТИПЫ = {};

/**
 * Записать, чем рисуется узел такого типа.
 *
 * `РИСУЕТ_РОДИТЕЛЬ` вместо составляющей -- для тех, кого обход не рисует
 * никогда: вкладку рисует полоса вкладок, значок и подпись -- строка. Записать
 * их всё равно надо, иначе сверка ниже сочтёт их забытыми, а забытый тип от
 * нарисованного родителем ничем не отличается, кроме умысла.
 */
export const РИСУЕТ_РОДИТЕЛЬ = "рисует родитель";
export const registerNode = (тип, рисовать) => { ТИПЫ[тип] = рисовать; };

/**
 * Сверить роспись с обещанием схемы.
 *
 * Тип, объявленный в `NODE_TYPES`, но не записанный сюда, -- обещание, которого
 * никто не сдержит: документ с таким узлом молча нарисует пустоту. Раньше это
 * ловилось только тем, что `switch` и список стояли рядом и правились вместе.
 */
export function assertEveryTypeIsDrawn() {
  const нет = NODE_TYPES.filter((т) => !(т in ТИПЫ));
  if (нет.length) {
    throw new Error(
      `NODE_TYPES обещает типы, которых отрисовка не знает: ${нет.join(", ")}. `
      + "Либо запишите их через registerNode, либо уберите из NODE_TYPES -- "
      + "схема и отрисовка обязаны говорить одно и то же.",
    );
  }
}

const NodeBody = ({ n, ctx }) => {
  const рисовать = ТИПЫ[n.type];
  if (typeof рисовать !== "function") {
    return <div className="pa-readonly">{String(n.value ?? "")}</div>;
  }
  return рисовать(n, ctx);
};

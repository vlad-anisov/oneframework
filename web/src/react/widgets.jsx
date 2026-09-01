/**
 * Таблица виджетов: `(node, ctx) -> узел React`.
 *
 * Нигде ни одной ветки по модели или *имени* поля -- только по типу поля и по
 * виджету, который запросил DSL.
 *
 * Всё, у чего есть готовая составляющая React, берётся ею: она и разметку
 * рисует ту же, и составляющую Framework7 заводит и убирает сама. В эффекте
 * здесь остался один TextEditor -- он переписал бы набранное эхом нашего же
 * коммита, -- и одна нажимаемая фишка осталась написанной разметкой: `<Chip>`
 * рисует `div`, а нажимаемому нужен якорь (почему -- у самой `Chip`).
 *
 * Ещё пять строятся против настоящего элемента, и причины у них разные --
 * прежняя запись их путала. У Autocomplete, Picker и PhotoBrowser
 * объявительной формы нет вовсе. У Calendar и ColorPicker она есть:
 * `<ListInput type="datepicker" calendarParams>` и `type="colorpicker"`
 * (`f7r/components/list-input.js:160,172`) заводят и убирают их сами. Но
 * `ListInput` -- это целая строка поля, от `li` до `item-input-wrap`, а наша
 * строка своя: подпись, ведущий слот, рамка, поведение внутри группы и четыре
 * места, куда она правит стиль (см. `InputRow`). Вложить строку в строку
 * нельзя, поэтому этим двум достаётся элемент. Это та же дверь, в которую
 * входит собственный виджет модуля через `registerWidget`.
 *
 * Что изменилось против прежней таблицы на snabbdom, кроме языка разметки:
 *
 *   * поле ввода стало управляемым, с собственным состоянием строки. У React
 *     `onChange` -- это событие `input`, то есть каждое нажатие клавиши, а
 *     запись значения происходит по `change`, то есть по уходу из поля. Между
 *     ними нужен буфер, иначе либо не набрать ни буквы, либо не записать ни
 *     разу;
 *   * событие составляющей Framework7 (`texteditor:change`) вешается на
 *     элемент вручную: это обычное событие DOM с двоеточием в имени, а React
 *     знает только свой список;
 *   * каждая заведённая составляющая убирается на выходе. Раньше её никто не
 *     убирал -- страница уходила, а Calendar с её обработчиками оставался.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Checkbox, Chip as F7Chip, Gauge, List, ListItem, Progressbar, Range, Segmented, Stepper, Toggle,
} from "framework7-react";

import { Glyph } from "./glyph.jsx";
import { locale, t } from "../i18n.js";

/* ------------------------------------------------------------------ utils */

/**
 * Как дата читается, где бы её ни показали.
 *
 * Одна форма и для строки, и для карточки: дата, которую читатель узнаёт, в его
 * собственной локали, а не ISO, которым её хранит колонка. Календарь Framework7
 * принимает те же настройки `Intl`, поэтому значение в поле и значение в списке
 * форматируются одним правилом.
 */
const DATE_FORMAT = { day: "numeric", month: "short" };

/**
 * Дата или отметка времени в ISO, в локали читателя. Неразобранное проходит
 * как есть.
 *
 * `format` -- настройки `Intl.DateTimeFormat`, поэтому поле, которому нужен год
 * (или день недели, или один только месяц), говорит это само и не остаётся с
 * той формой, которая случайно понадобилась строке списка.
 */
export const stamp = (value, format) => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleDateString(locale(), format || DATE_FORMAT);
};

/** Цвет записи -- через собственные переменные контурной фишки Framework7. */
const outline = (hex) => ({
  "--f7-chip-outline-border-color": hex,
  "--f7-chip-outline-text-color": hex,
});

export function cssColor(value) {
  return /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]+$/.test(String(value).trim())
    ? String(value).trim()
    : "#9e9e9e";
}

const label = (node) => node.label + (node.required ? " *" : "");

/**
 * Строки без собственной строки подписи.
 *
 * Решает приложение, дав полю подсказку: этот текст *и есть* подпись, он стоит
 * внутри пустого органа управления, и надпись над ним говорила бы то же самое
 * второй раз. Ни из виджета, ни из иконки ничего не выводится.
 */
const labelIsThePlaceholder = (node) => node.placeholder != null;

/** Что говорит пустой орган управления: то, что попросили, или ничего. */
const placeholderOf = (node, ctx) =>
  node.placeholder != null
    ? node.placeholder
    // Вне формы строки подписи нет, поэтому подпись -- всё наименование, какое
    // орган управления получает: ячейка таблицы, строка списка.
    : ctx.mode !== "form" ? node.label ?? "" : "";

/* ------------------------------------------------ обвязка Framework7 */

/**
 * Составляющая Framework7, заведённая на элементе и убранная за собой.
 *
 * Раньше это делал общий проход после каждой заплатки: он искал по документу
 * классы `*-init` и заводил то, чего ещё нет. Живая составляющая при этом
 * оставалась висеть на снятой странице -- убирать её было некому и негде. Здесь
 * жизнь составляющей -- это жизнь узла React, и уборка стоит там же, где
 * заведение.
 */
function useF7(ref, make, deps = []) {
  const instance = useRef(null);
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    instance.current = make(ref.current);
    return () => {
      try {
        instance.current?.destroy?.();
      } catch {
        // Составляющая могла уйти вместе с элементом -- это не беда.
      }
      instance.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return instance;
}

/**
 * Событие Framework7 на элементе.
 *
 * `texteditor:change` -- обычное событие DOM с двоеточием в имени. React знает
 * только свой список имён, поэтому такие вешаются напрямую. У остальных
 * составляющих событие приходит доводом готовой составляющей React
 * (`onStepperChange`, `onRangeChanged`), и обходить React там незачем.
 */
function useDomEvent(ref, name, handler) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const listener = (event) => latest.current(event);
    el.addEventListener(name, listener);
    return () => el.removeEventListener(name, listener);
  }, [ref, name]);
}

/**
 * Значение, которое набирают.
 *
 * Пока поле под пальцем, правда -- то, что в нём набрано; как только из него
 * ушли, правда снова у записи. Без этого разделения либо не набрать ни буквы
 * (каждое нажатие затиралось бы прежним значением), либо не увидеть чужую
 * правку, приехавшую обменом.
 */
function useTyped(value, commit) {
  const [text, setText] = useState(value ?? "");
  const focused = useRef(false);
  const shown = useRef(value);
  if (!focused.current && shown.current !== value) {
    shown.current = value;
    if (text !== (value ?? "")) setText(value ?? "");
  }
  return {
    value: text,
    // Значение уходит приложению **на каждой букве**, а не по потере фокуса.
    //
    // Раньше уходило по `onBlur`, и это было тихо неверно: `enabled=record.title`
    // и всё, что зависит от набираемого, отвечало по вчерашней записи. Кнопка
    // «Сохранить» на карточке черновика оставалась серой навсегда -- фокус с
    // поля не уходил, потому что ссылка Framework7 гасит нажатие и не отбирает
    // его. Человек видел заполненное поле и неработающую кнопку.
    onChange: (e) => {
      setText(e.target.value);
      if (e.target.value !== String(value ?? "")) commit(e.target.value);
    },
    onFocus: () => { focused.current = true; },
    onBlur: (e) => {
      focused.current = false;
      shown.current = value;
      if (e.target.value !== String(value ?? "")) commit(e.target.value);
    },
  };
}

/* --------------------------------------------------------------- раскладка */

/**
 * Строка поля Framework7, написанная один раз: одна коробка, четыре начинки.
 *
 * Здесь и ниже действует один договор: всякий орган управления принимает
 * `className` и произвольные `data-*` и кладёт их на свой корень. Нужен он
 * ровно для `help=`: истолкователь дописывает подсказку на то, что вернул
 * виджет, и не может знать, элемент это DOM или составляющая. Со snabbdom
 * вопроса не было -- там у всего были свойства узла.
 */
// Коробка поля -- `div.list.list-strong.inset` с `ul` внутри, руками.
//
// `<List>` сюда не подходит, и это проверено, а не предположено: он
// раскладывает детей по `displayName` и всё, что не его строка, выкладывает
// РЯДОМ с `ul`. Наши строки -- обычные `li`, он их за строки не признаёт, и
// `ul` не появляется вовсе: карточка остаётся без того самого элемента, на
// котором держатся и скругление, и разделители.
const Block = ({ children, className = "", ...rest }) => (
  <div className={`list list-strong inset pa-field ${className}`.trim()} {...rest}>
    <ul>{children}</ul>
  </div>
);

/**
 * Виджеты, которые рисуют `icon` сами -- флажок и есть свой глиф, и вторая его
 * копия рядом со строкой была бы бессмыслицей.
 */
const ICON_IS_THE_CONTROL = new Set(["checkbox", "toggle", "handle"]);

/** Органы управления, растущие вниз по странице: иконка метит первую строку. */
const MULTILINE = new Set(["textarea", "rich"]);

/**
 * Строка поля, с ведущей иконкой или без неё.
 *
 * `item-media` -- собственный ведущий слот Framework7, поэтому иконка садится
 * на сетку платформы без единого нашего правила.
 *
 * Разметку эту строит и `<ListInput>` (`f7r/components/list-input.js:315-345`)
 * -- то же дерево, до класса. Строка остаётся своей из-за четырёх мест, куда
 * она правит стиль, и три из них составляющая наружу не отдаёт: `style` она
 * кладёт только на `li`, а `.item-content`, `.item-media` и `.item-inner`
 * рисует с постоянными классами и без стиля. Перенести их значило бы завести
 * свои правила CSS -- и не простые, а перевешивающие правила Framework7
 * (`.md .item-input.item-content` -- три класса), -- ради разметки, которая и
 * так совпадает. Все четыре живые: карточка задачи в `examples/gtasks` снята с
 * телефона и стоит ровно на них. Само поле ввода тоже остаётся нашим: у
 * `<ListInput>` до него не дотянуться ни классом, ни `data-interactive`, а
 * буфер набора (`useTyped`) нужен потому, что между клавишей и записью лежит
 * воркер.
 */
function InputRow({ node, ctx, invalid = false, children, className = "", ...rest }) {
  // `icon` едет в `options` -- туда, куда поле кладёт всё, что выбранный им
  // виджет волен прочитать.
  const glyph = node.options?.icon;
  const leading = glyph && !ICON_IS_THE_CONTROL.has(node.widget);
  const bare = labelIsThePlaceholder(node);
  // `item-input-outline` Framework7 -- это поле в рамке из Material 3; простая
  // строка -- та подчёркнутая, которую он рисует иначе. Рамка нужна строке, в
  // которой нет ничего, кроме подсказки, и нет ведущей иконки, чтобы её
  // закрепить: сама по себе она была бы строкой текста, висящей над чертой.
  //
  // «Сама по себе» -- это всё условие: группа и так поверхность с краем, и
  // внутри неё рамка -- второй край, нарисованный на 16dp внутри первого.
  // Обходится это в обе стороны: Material 3 даёт рамке 16dp поля по бокам и
  // 24dp внутри, что ставит текст на 48dp от края, тогда как собственные строки
  // группы стоят на 24, и 8dp сверху и снизу под плавающую подпись, которой у
  // строки-подсказки нет, -- отчего строка в 48dp становится 72. Google рисует
  // такие простыми строками на карточке создания и рамкой -- на экране «новый
  // список», где поле единственное на странице.
  const outlined = bare && !leading && node.widget !== "headline" && !ctx.inGroup;
  // *Заполненное* поле материала -- это подпись над подкрашенной панелью с
  // чертой под ней, и Framework7 рисует его целиком: подложку с отступом 8dp
  // сверху и снизу, черту по её низу и 16dp по бокам, чтобы поле стояло внутри
  // строки. Строка без собственной подписи -- не это поле: она либо в рамке,
  // либо это строка формы, которую уже закрепляет иконка или заголовок, --
  // поэтому она не берёт из него ничего и стоит в тех же 48dp, на том же левом
  // краю, что и всякая другая строка карточки. Карточка Google меряет ровно
  // это. Подложка названа наравне с чертой: обе -- переменные Framework7, и
  // пока группа за ними была залита тем же тоном, подложка была не отсутствующей,
  // а невидимой.
  const filled = !bare || outlined;
  const plain = filled ? undefined : {
    "--f7-input-border-color": "transparent",
    "--f7-input-item-bg-color": "transparent",
  };
  const asRow = {
    paddingTop: 0, paddingBottom: 0, marginLeft: 0, marginRight: 0,
  };
  return (
    <li style={plain} className={className || undefined} {...rest}>
      <div
        className={"item-content item-input"
          + (outlined ? " item-input-outline" : "")
          + (invalid ? " item-input-invalid" : "")}
        style={filled ? undefined : asRow}
      >
        {leading && (
          <div
            className={"item-media"
              // Framework7 центрирует ведущий слот по строке. Против коробки,
              // растущей вниз по странице, это читается как «висит», поэтому
              // многострочный орган управления держит иконку на первой строке
              // -- его же утилитой.
              + (MULTILINE.has(node.widget) ? " align-self-flex-start" : "")}
          >
            <Glyph name={glyph} size={24} />
          </div>
        )}
        <div
          className="item-inner"
          // С соседом в ведущем слоте строка -- линия flex, и орган управления
          // уже строки был бы прижат к её концу. Остаток линии принадлежит полю.
          style={leading ? { width: "100%", flex: 1 } : undefined}
        >
          {!bare && (
            <div className="item-title item-label pa-field__label">{label(node)}</div>
          )}
          {children}
        </div>
      </div>
    </li>
  );
}

/**
 * Орган управления в подписанной строке; вне формы он стоит сам по себе.
 *
 * Внутри `Group` карточка принадлежит группе, поэтому строка отдаётся голой --
 * это и делает секцию одной поверхностью, а не стопкой из них.
 */
function wrap(node, ctx, control, invalid = false, extra = null) {
  if (ctx.mode !== "form") return extra ? React.cloneElement(control, extra) : control;
  const row = (
    <InputRow node={node} ctx={ctx} invalid={invalid} {...(ctx.inGroup ? extra : null)}>
      <div className="item-input-wrap">{control}</div>
    </InputRow>
  );
  return ctx.inGroup ? row : <Block {...extra}>{row}</Block>;
}

/** Целая строка, сделанная самим виджетом. */
function listRow(node, ctx, row, extra = null) {
  if (ctx.mode !== "form") return extra ? React.cloneElement(row, extra) : row;
  const li = <li {...(ctx.inGroup ? extra : null)}>{row}</li>;
  return ctx.inGroup ? li : <Block {...extra}>{li}</Block>;
}

/* --------------------------------------------------------------- controls */

/**
 * `type` выбирает клавиатуру; `auto` -- смысловая подсказка, которую читает
 * вебвью: `UITextContentType` на iOS, `autofillHints` на Android. Без неё
 * ничего никогда не предложат ни из связки ключей, ни из контактов.
 */
/** Что просит тип поля, когда виджет не сказал иного. */
const FALLBACK = {
  string: { type: "text" },
  integer: { type: "number" },
  float: { type: "number" },
  monetary: { type: "number" },
  duration: { type: "number" },
  date: { type: "date" },
  time: { type: "time" },
  datetime: { type: "datetime-local" },
};

const INPUT = {
  text: { type: "text" },
  email: { type: "email", auto: "email" },
  phone: { type: "tel", auto: "tel" },
  url: { type: "url", auto: "url" },
  password: { type: "password", auto: "current-password" },
  barcode: { type: "text", auto: "off" },
  number: { type: "number" },
  datetime: { type: "datetime-local" },
  time: { type: "time" },
};

function TextInput({ node, ctx, spec = {}, inputClass = "pa-input", style, className = "", ...rest }) {
  const { type = "text", auto } = spec;
  const numeric = type === "number";
  const typed = useTyped(node.value ?? "", (raw) => ctx.commit(node, numeric ? Number(raw) : raw));
  return (
    <input
      className={`${inputClass} ${className}`.trim()} type={type} data-interactive="1"
      autoComplete={auto} placeholder={placeholderOf(node, ctx)}
      // Поле, которое ведёт не человек: у вычисляемого поля колонки нет, и
      // напечатанное в него не запишется никуда. Орган управления, принимающий
      // ввод, обещал бы правку, которой не будет, -- а это хуже, чем её
      // отсутствие: человек видит, что печатается, и уходит уверенным.
      readOnly={node.readonly === true}
      style={style}
      {...rest}
      {...typed}
    />
  );
}

function TextAreaInput({ node, ctx, className = "", ...rest }) {
  const typed = useTyped(node.value ?? "", (raw) => ctx.commit(node, raw));
  return (
    <textarea
      // Framework7 растит `resizable` по содержимому и ужимает обратно; четыре
      // строки постоянной высоты -- дыра на странице, когда значение короче, и
      // полоса прокрутки, когда длиннее.
      className={`pa-input pa-textarea resizable ${className}`.trim()}
      rows="1" data-interactive="1"
      placeholder={placeholderOf(node, ctx)}
      {...rest}
      {...typed}
    />
  );
}

/** Число с единицей рядом -- деньги, проценты. */
function WithUnit({ node, ctx, unit, step, className = "", ...rest }) {
  const typed = useTyped(node.value ?? "", (raw) => ctx.commit(node, Number(raw || 0)));
  return (
    <div className={`pa-money display-flex align-items-baseline ${className}`.trim()} {...rest}>
      <input className="pa-input" type="number" step={step} data-interactive="1" {...typed} />
      <span className="pa-money__unit margin-left-half">{unit}</span>
    </div>
  );
}

/**
 * Записать, если правда изменилось.
 *
 * Проверка «то же самое?» стояла у каждого виджета своя, и это была не
 * прихоть: сравнивать приходится по-разному. Число из ползунка приходит
 * строкой, список меток -- новым массивом на каждый выбор, цвет Framework7
 * приводит к нижнему регистру. Общий здесь не *способ* сравнения, а то, что
 * без проверки виджет пишет в запись на каждой отрисовке -- а каждая запись
 * это ход рантайма, обмен и новый кадр.
 *
 * Поэтому способ -- признак, а не догадка помощника: `dequal` и подобные
 * приводить типы отказываются, и цвет им не сравнить.
 */
const КАК = {
  число: (a, b) => Number(a) === Number(b ?? 0),
  строка: (a, b) => String(a) === String(b ?? ""),
  список: (a, b) => [...(a || [])].join(",") === [...(b || [])].join(","),
  безРегистра: (a, b) => String(a).toLowerCase() === String(b ?? "").toLowerCase(),
};

const commitIf = (ctx, node, next, как = "строка") => {
  if (!КАК[как](next, node.value)) ctx.commit(node, как === "число" ? Number(next) : next);
};

const bounds = (node, min, max) => ({
  value: Number(node.value ?? 0),
  min: Number(node.options?.min ?? min),
  max: Number(node.options?.max ?? node.options?.maximum ?? max),
  step: Number(node.options?.step ?? 1),
});

function StepperInput({ node, ctx, className = "", ...rest }) {
  const params = bounds(node, -1e12, 1e12);
  return (
    <Stepper
      className={className} data-interactive="1" {...params} {...rest}
      // Поле степпера только показывает. Умолчание Framework7 -- обратное, а
      // набранное в него шло бы мимо буфера, которым живёт весь прочий ввод:
      // между клавишей и записью в модель у нас лежит воркер.
      inputReadonly
      onStepperChange={(v) => {
        commitIf(ctx, node, v, "число");
      }}
    />
  );
}

function RangeInput({ node, ctx, className = "", ...rest }) {
  const params = bounds(node, 0, 100);
  return (
    <Range
      className={className} data-interactive="1" {...params} {...rest}
      // Пузырёк над ползунком: без него у него нет ни одной цифры, и куда его
      // поставили -- видно только по строке списка где-то ещё.
      label
      onRangeChanged={(v) => {
        commitIf(ctx, node, v, "число");
      }}
    />
  );
}

function RichText({ node, ctx, className = "", ...rest }) {
  const ref = useRef(null);
  useF7(ref, (el) => ctx.f7.textEditor.create({
    el, value: node.value ?? "", placeholder: node.label ?? "",
  }));
  useDomEvent(ref, "texteditor:change", (e) => {
    if (e.detail !== (node.value ?? "")) ctx.commit(node, e.detail);
  });
  return (
    <div
      className={`text-editor text-editor-init ${className}`.trim()}
      data-interactive="1" ref={ref} {...rest}
    />
  );
}

/**
 * Составляющей Framework7 здесь нет вовсе: `<Gauge>` -- SVG на React с теми же
 * умолчаниями, и дуга на каждое значение больше не строится заново.
 */
function GaugeChart({ node, className = "", ...rest }) {
  // Признак процента -- единица, а не тип. `Percent` в объявлении это
  // `Float(unit="%")`: своего типа у него нет и на проводе не бывает
  // (`protocol/field-types.json` -- float, integer, monetary и прочие, но не
  // percent). Здесь до сих пор спрашивался `ftype === "percent"`, то есть
  // ветка не срабатывала ни разу: делителем оставалась единица, и `64`
  // рисовало полное кольцо с подписью «64» вместо 64 % дуги.
  const процент = node.options?.unit === "%";
  const max = Number(node.options?.maximum ?? (процент ? 100 : 1)) || 1;
  const value = Math.max(0, Math.min(1, Number(node.value || 0) / max));
  const valueText = процент
    ? `${Math.round(Number(node.value || 0))}%`
    : String(node.value ?? 0);
  return (
    <Gauge
      type="circle" size={96} borderWidth={8} valueFontSize={18}
      borderColor="var(--f7-theme-color)" value={value} valueText={valueText}
      className={`display-flex justify-content-center ${className}`.trim()} {...rest}
    />
  );
}

/* ------------------------------------------------------------------ chips */

/**
 * Цвет записи идёт на контур -- туда, куда Framework7 кладёт собственный цвет
 * фишки: читаемо в обеих темах, и никому не приходится считать цвет текста.
 */
const Chip = ({ value, text, color, selected, onPick }) => (
  // Нажимаемой фишке остаётся якорь, хотя `<Chip>` из framework7-react рисует
  // ту же разметку. Якорь несёт две вещи, которых у `div` нет: `a { cursor:
  // pointer }` из `framework7-bundle.css:235` (у `.chip` своего курсора нет
  // вовсе) и место в обходе клавишей, где Enter нажимает сам. Дать их
  // составляющей нечем: она пропускает наружу только `data-`, `aria-` и `role`
  // (`f7r/shared/utils.js:111-119`), то есть ни `tabIndex`, ни `onKeyDown` до
  // элемента не доходят. Разметка `.chip` -- одни правила CSS, своей
  // составляющей у Framework7 для неё нет (`components/chip/chip.js`), так что
  // теряется здесь ровно две строки, а не поведение.
  <a
    href="#" data-value={value} style={color ? outline(cssColor(color)) : undefined}
    className={`chip pa-chip margin-right-half${selected ? " is-active" : " chip-outline"}`}
    onClick={(e) => { e.preventDefault(); onPick(); }}
  >
    <div className="chip-label">{text}</div>
  </a>
);

const chipRow = (node, ctx, choices, isOn, pick, inForm) => {
  const row = (
    <div data-interactive="1" className={`pa-chips${inForm ? "" : " padding-half"}`}>
      {choices.map((c) => (
        <Chip
          key={String(c.key)} value={String(c.key)} text={c.label} color={c.color}
          selected={isOn(c)} onPick={() => pick(c)}
        />
      ))}
    </div>
  );
  return inForm ? wrap(node, ctx, row) : row;
};

/* -------------------------------------------------------------- relations */

/**
 * Контурная фишка Framework7, окрашенная цветом самой связанной записи.
 *
 * Здесь составляющая идёт в дело, в отличие от нажимаемой фишки выше: связь
 * нажатий не ловит и никогда не ловила, значит ни курсор, ни обход клавишей ей
 * не нужны, и `div` от неё ничем не отличается.
 */
const Tag = ({ rel }) =>
  // Совсем ничего, когда показывать нечего: `hidden` фишку не прячет, потому
  // что `.chip` несёт собственный `display`.
  rel ? (
    <F7Chip
      outline text={rel.display} className="pa-tag margin-right-half"
      style={outline(cssColor(rel.color || "#9e9e9e"))}
    />
  ) : <span />;

/** Текст текущего выбора, или "" когда не выбрано ничего. */
function chosenLabel(node, pairs) {
  const key = node.value == null ? "" : String(node.value);
  if (key === "") return "";
  return (pairs.find(([v]) => String(v) === key) || [])[1] || "";
}

function SmartSelect({ node, ctx, multiple = false, ...extra }) {
  const isSelection = node.ftype === "selection";
  const pairs = isSelection
    ? (node.choices || []).map((c) => [c.value, c.label])
    : [
        ...(multiple ? [] : [["", t("none")]]),
        ...(node.choices || []).map((c) => [String(c.id), c.display]),
      ];
  const bare = labelIsThePlaceholder(node);
  const chosen = chosenLabel(node, pairs);
  const ищет = pairs.length > 8;

  // Меню или лист -- решается тем, чем выбор кончается, а не вкусом.
  //
  // Лист Framework7 рисует поверх себя полосу с крестиком (`renderSheet`), и
  // убрать её параметром нельзя. Выбору одного из немногих крестик не нужен и
  // мешает: и Material, и HIG для такого предписывают меню у самой строки, а
  // уходит оно по выбору и по нажатию мимо.
  //
  // Двум случаям лист всё-таки нужен, и оба -- не про вид. Выбор нескольких
  // ничем, кроме крестика, не завершить: `closeOnSelect` при нём выключен.
  // А поиск живёт только в листе -- у `renderPopover` строки поиска нет вовсе,
  // и меню молча съело бы её вместе с длинным перечнем.
  const openIn = multiple || ищет ? "sheet" : "popover";

  // Ключ записи -- строка и ничего кроме строки: приводить его нельзя, иначе
  // связь пишется мимо.
  const onChange = (e) => {
    if (multiple) {
      const next = [...e.target.selectedOptions].map((o) => o.value);
      commitIf(ctx, node, next, "список");
      return;
    }
    const raw = e.target.value;
    const next = raw === "" ? null : raw;
    if (next !== (node.value ?? null)) ctx.commit(node, next);
  };

  const item = (
    <ListItem
      // Заводчиков было два. Наш -- в эффекте, и второй -- авто-инит
      // Framework7 по классу `smart-select-init` (`smart-select.js:94-100`),
      // которому известен только сам элемент: ни листа, ни заголовка, ни
      // поиска. Конструктор сторожем `if ($el[0].f7SmartSelect) return` отдаёт
      // первого, то есть чьи параметры доживут до экрана, решала очерёдность.
      // Хуже другое: `pageBeforeRemove` того же авто-инита убирает
      // составляющую и тогда, когда завели её не там, -- за спиной у React.
      // `<ListItem smartSelect>` заводит одного и убирает того же.
      smartSelect
      smartSelectParams={{
        openIn,
        closeOnSelect: !multiple,
        searchbar: ищет,
        searchbarPlaceholder: t("search"),
        pageTitle: node.label ?? "",
        // Framework7 повторяет выбранное в конце строки. Выбиральщик, чья
        // подпись живёт в подсказке, уже сказал, что он держит -- строка *и
        // есть* значение, -- поэтому повтор сказал бы то же самое дважды, а
        // пока пусто, повторил бы пустоту: «Добавить подзадачи — не указано».
        // Его же собственный выключатель, а не наше правило.
        setValueText: !bare,
      }}
      // Умолчание составляющей -- `<a>` вообще без `href`, а такой якорь
      // выпадает из обхода клавишей; собственная разметка выбиральщика у
      // Framework7 несёт `href="#"`, и наша несла.
      link="#"
      // Уголок говорит «эта строка продолжается дальше». Строка, которая есть
      // приглашение -- «Добавить подзадачи», -- исчерпывается собой.
      noChevron={bare}
      className="pa-select" data-interactive="1"
      // Выбиральщик с подсказкой называет себя так же, как поле ввода: пока
      // пусто, строка читается как то, что она добавит, а с выбором -- как
      // выбранная запись.
      title={bare && !chosen ? node.placeholder : node.label}
      // И красится он тоже как поле ввода: стоя пустым, слова -- приглашение, а
      // не значение. Цвет идёт переменной на `li`, а не стилем на `.item-title`
      // -- до самого заголовка составляющая добраться не даёт, но её же
      // переменная (`.list .item-title { color: var(--f7-list-item-title-text-color) }`)
      // спускается туда сверху. Своего правила CSS для этого не нужно.
      style={bare && !chosen
        ? { "--f7-list-item-title-text-color": "var(--f7-input-placeholder-color)" }
        : undefined}
      {...(ctx.mode !== "form" || ctx.inGroup ? extra : null)}
    >
      {/* Впереди строки -- там же, где его держит собственный smart select
          Framework7: элемент не виден никогда, но промежуток после ведущего
          слота задан правилом `.item-media + .item-inner`, и всё, что встанет
          между ними, этот промежуток отнимает. */}
      <select
        slot="content-start" multiple={multiple} onChange={onChange}
        value={multiple
          ? (node.value || []).map(String)
          : (node.value == null ? "" : String(node.value))}
      >
        {pairs.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>{text}</option>
        ))}
      </select>
      {/* Выбиральщик строит собственный `item-content`, а не идёт через
          подписанную строку, поэтому ведущий слот приходится вернуть здесь --
          `icon=` на связи терялся, и строка выходила непомеченной рядом с
          полями над ней. Тон тот же приглушённый, что и у всякой другой ведущей
          иконки; стоит он на самом глифе, потому что слот рисует составляющая,
          и другого содержимого в нём нет. */}
      {node.options?.icon && (
        <Glyph slot="media" name={node.options.icon} size={24} />
      )}
    </ListItem>
  );
  // Строка -- уже `li`, и `li` обязан стоять в списке: вне `ul` браузер рисует ему маркер --
  // единственное правило `list-style: none` у Framework7 висит на
  // `.list ul` (замерено в framework7-bundle.css), то есть достаётся `li` через
  // список, а не само по себе. В группе и в карточке список даёт обёртка, а в
  // строке -- никто, поэтому там он заводится здесь. Прежняя разметка обходилась
  // якорем и такой заботы не требовала; сегодня в строку выбиральщик не ставит
  // ни один пример, так что это задел, а не починка увиденного.
  if (ctx.inGroup) return item;
  if (ctx.mode !== "form") return <List>{item}</List>;
  return <Block {...extra}>{item}</Block>;
}

/* --------------------------------------------------------------- binaries */

function FileInput({ node, ctx, className = "", ...rest }) {
  const isImage = String(node.options?.accept || "").startsWith("image/");
  const inputRef = useRef(null);
  const pick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () =>
      ctx.commit(node, isImage ? String(reader.result) : `${file.name}|${reader.result}`);
    reader.readAsDataURL(file);
  };
  return (
    <div
      data-interactive="1" {...rest}
      className={`${isImage ? "pa-image" : "pa-file"} display-flex align-items-center ${className}`.trim()}
    >
      <button className="button button-tonal" type="button" onClick={() => inputRef.current?.click()}>
        {node.label}
      </button>
      {!isImage && (
        <span className="pa-file__name margin-left-half">
          {String(node.value || "").split("|")[0]}
        </span>
      )}
      <input ref={inputRef} type="file" hidden onChange={pick} accept={node.options?.accept} />
    </div>
  );
}

/** Две координаты и кнопка «где я»: значение -- одна строка "lat,lon". */
function GeoPoint({ node, ctx, className = "", ...rest }) {
  const [lat = "", lon = ""] = String(node.value || "").split(",");
  const [pair, setPair] = useState({ lat, lon });
  const shown = useRef(node.value);
  if (shown.current !== node.value) {
    shown.current = node.value;
    const [a = "", b = ""] = String(node.value || "").split(",");
    if (a !== pair.lat || b !== pair.lon) setPair({ lat: a, lon: b });
  }
  const push = (next) => {
    setPair(next);
    ctx.commit(
      node,
      next.lat === "" && next.lon === ""
        ? null
        : `${Number(next.lat || 0)},${Number(next.lon || 0)}`,
    );
  };
  return (
    <div className={`pa-geo display-flex align-items-center ${className}`.trim()} {...rest}>
      <input
        className="pa-input pa-geo__part" type="number" step="0.000001" placeholder="lat"
        data-interactive="1" value={pair.lat}
        onChange={(e) => setPair({ ...pair, lat: e.target.value })}
        onBlur={() => push(pair)}
      />
      <input
        className="pa-input pa-geo__part margin-left-half" type="number" step="0.000001"
        placeholder="lon" data-interactive="1" value={pair.lon}
        onChange={(e) => setPair({ ...pair, lon: e.target.value })}
        onBlur={() => push(pair)}
      />
      <a
        href="#" className="link icon-only margin-left-half" aria-label="locate"
        onClick={(e) => {
          e.preventDefault();
          navigator.geolocation?.getCurrentPosition((pos) =>
            push({
              lat: pos.coords.latitude.toFixed(6),
              lon: pos.coords.longitude.toFixed(6),
            }));
        }}
      >
        <Glyph name="my_location" size={20} />
      </a>
    </div>
  );
}

/** Поле JSON: показывает себя текстом, а Framework7 говорит, когда он сломан. */
function JsonArea({ node, ctx, ...extra }) {
  const asText = node.value == null ? "" : JSON.stringify(node.value, null, 2);
  const [text, setText] = useState(asText);
  const [invalid, setInvalid] = useState(false);
  const shown = useRef(asText);
  if (shown.current !== asText) {
    shown.current = asText;
    if (text !== asText) setText(asText);
  }
  const done = () => {
    try {
      ctx.commit(node, text.trim() ? JSON.parse(text) : null);
      setInvalid(false);
    } catch {
      setInvalid(true);
    }
  };
  return wrap(
    node, ctx,
    <textarea
      className="pa-input pa-textarea" rows="5" data-interactive="1"
      value={text} onChange={(e) => setText(e.target.value)} onBlur={done}
    />,
    invalid,
    extra,
  );
}

/**
 * Флажок, нарисованный своим глифом.
 *
 * `icon` меняет глиф и оставляет всё остальное -- то же, что Android называет
 * `android:button` у CompoundButton: всё ещё логический орган управления,
 * нарисованный иначе. Собственную коробку Framework7 для этого не переиспользовать
 * -- он красит `background-color` на самом глифе, когда тот отмечен, -- поэтому
 * вариант с иконкой это собственный маленький орган.
 */
function IconCheckbox({ node, ctx, ...extra }) {
  // Оба состояния называет приложение. У Material Icons нет правила, выводящего
  // одно из другого -- `star`/`star_border` выглядит таким правилом ровно до
  // `check_circle`/`radio_button_unchecked`, -- поэтому догадка была бы неверна
  // не реже, чем верна.
  const on = node.options.icon;
  const off = node.options.icon_off || on;
  // Отмеченный глиф -- цвета темы, потому что «отмечен» и есть то, что он
  // говорит. Неотмеченный -- не приглушённый акцент, а другая роль: Framework7
  // даёт акцент всякой ссылке, и это iOS, а материал рисует невыбранный орган
  // приглушённым тоном on-surface. В его палитре этот тон есть.
  //
  // Одно исключение, и оно Google, а не правило: неотмеченная звезда на задаче
  // в списке нарисована ещё на ступень тише -- on-surface на 38%, доля, которую
  // материал даёт неактивному органу. Снято с телефона: (92,98,91) на карточке
  // и (95,101,94) на карточке-модалке, и 0.38 от on-surface поверх каждой из
  // этих двух заливок ложится в пределах единицы от обоих. Это действительно
  // только тот глиф и только на том экране: кружок в той же строке и та же
  // самая `star_border` на карточке создания -- полный on-surface-variant, --
  // поэтому условие называет и глиф, и место, а не делает вид, что неотмеченный
  // флажок тускл вообще.
  const dim = !node.value && off === "star_border" && ctx.screenMode === "plain";
  return wrap(node, ctx, (
    <a
      className="link icon-only" data-interactive="1"
      style={dim ? { opacity: 0.38 } : undefined}
      onClick={() => ctx.commit(node, !node.value)}
    >
      <i className={`icon material-icons${node.value ? " text-color-primary" : ""}`}>
        {node.value ? on : off}
      </i>
    </a>
  ), false, extra);
}

/* ------------------------------------------------------------------ built-ins */

const WIDGETS = {
  /* --- text ------------------------------------------------------------ */
  "string:text": (n, c) => wrap(n, c, <TextInput node={n} ctx={c} spec={INPUT.text} />),
  // Пять смыслов, которые может нести строка: орган управления один, а
  // клавиатура и подсказка автозаполнения следуют из того, что значение значит.
  "string:email": (n, c) => wrap(n, c, <TextInput node={n} ctx={c} spec={INPUT.email} />),
  "string:phone": (n, c) => wrap(n, c, <TextInput node={n} ctx={c} spec={INPUT.phone} />),
  "string:url": (n, c) => wrap(n, c, <TextInput node={n} ctx={c} spec={INPUT.url} />),
  "string:password": (n, c) => wrap(n, c, <TextInput node={n} ctx={c} spec={INPUT.password} />),
  "string:barcode": (n, c) => wrap(n, c, <TextInput node={n} ctx={c} spec={INPUT.barcode} />),
  // `wrap` принадлежит полю, а не ячейке строки, в которой оно случайно
  // оказалось: внутри Col строка видит колонку, а не то, что в ней. Framework7
  // держит ячейку строки в одну линию и обрезает её -- это верно для таблицы и
  // неверно для предложения.
  "string:title": (n) => (
    <div className="item-title pa-title" style={n.options?.wrap ? { whiteSpace: "normal" } : undefined}>
      {n.value ?? ""}
    </div>
  ),
  // Та одна строка, *про которую* запись, и она всё ещё правится. Собственные
  // размеры крупного заголовка Framework7, чтобы это был тот же размер, каким
  // платформа пишет заголовок экрана, а не выдуманный здесь.
  "string:headline": (n, c) => wrap(n, c, (
    <TextInput
      node={n} ctx={c} spec={INPUT.text} inputClass="pa-input pa-headline"
      style={{
        fontSize: "var(--f7-block-title-large-font-size)",
        fontWeight: "var(--f7-block-title-large-font-weight)",
        lineHeight: "var(--f7-block-title-large-line-height)",
      }}
    />
  )),
  // Вторая строка строки списка, в собственном тусклом и мелком начертании
  // Framework7.
  "string:subtitle": (n) => (
    <div className="item-subtitle" style={n.options?.wrap ? { whiteSpace: "normal" } : undefined}>
      {n.value ?? ""}
    </div>
  ),
  // Хранимое значение ISO, показанное так, как его пишет локаль читателя.
  // Форматирует `Intl` -- API платформы, а не таблица названий месяцев здесь.
  // `flex-shrink-0`: дата -- содержимое постоянной ширины, и ужать её до
  // «1...» рядом с длинным заголовком значит потерять всё, что она говорит.
  "date:title": (n) => (
    <div className="item-title pa-title flex-shrink-0">{stamp(n.value, n.options?.format)}</div>
  ),
  "time:title": (n) => <div className="item-title pa-title">{n.value ?? ""}</div>,
  "string:textarea": (n, c) => wrap(n, c, <TextAreaInput node={n} ctx={c} />),
  // Запасной ход показывает себя текстом; собственное состояние ошибки
  // Framework7 говорит, когда этот текст перестал быть JSON.
  "json:textarea": (n, c) => <JsonArea node={n} ctx={c} />,
  "json:text": (n, c) => wrap(n, c, <TextInput node={n} ctx={c} spec={INPUT.text} />),
  "string:rich": (n, c) => wrap(n, c, <RichText node={n} ctx={c} />),

  /* --- numbers ---------------------------------------------------------- */
  "integer:stepper": (n, c) => wrap(n, c, <StepperInput node={n} ctx={c} />),
  "integer:range": (n, c) => wrap(n, c, <RangeInput node={n} ctx={c} />),
  "monetary:monetary": (n, c) =>
    wrap(n, c, <WithUnit node={n} ctx={c} unit={n.options?.currency || ""} step="0.01" />),
  // Единица -- это суффикс у числа, чем процент всегда и был.
  "float:unit": (n, c) =>
    wrap(n, c, <WithUnit node={n} ctx={c} unit={n.options?.unit || ""} step="any" />),

  "float:progress": (n, c) => {
    const pct = Math.max(0, Math.min(100, Number(n.value || 0)));
    return wrap(n, c, (
      <div className="pa-progresswrap display-flex align-items-center padding-vertical-half">
        <Progressbar progress={pct} />
        <span className="pa-progresswrap__value margin-left-half text-align-right">
          {`${Math.round(pct)}%`}
        </span>
      </div>
    ));
  },
  "float:gauge": (n, c) => wrap(n, c, <GaugeChart node={n} />),

  /* --- booleans and choices --------------------------------------------- */
  /* Перетаскивание держится составляющей, а её `<Toggle>` заводит сам. Пишем
     «наоборот от того, где стоял», а не то, что сказало событие: сменой значения
     у флажка React считает нажатие и к его концу вернул `checked` к свойствам, а
     `<Toggle>` слушает `change` живым слушателем -- уже после возврата. Соседнему
     `<Checkbox>` событие читать можно: там наш обработчик -- сам `onChange`. */
  "boolean:toggle": (n, c) => (
    <Toggle
      className="pa-toggle" data-interactive="1" checked={!!n.value}
      onChange={() => c.commit(n, !n.value)}
    />
  ),
  // У Framework7 их два: отдельный `.checkbox` для ячейки и `item-checkbox` на
  // целую строку списка. Ячейке строки нужен маленький.
  "boolean:checkbox": (n, c) => {
    if (n.options?.icon) return <IconCheckbox node={n} ctx={c} />;
    const flip = (e) => c.commit(n, e.target.checked);
    if (c.mode !== "form") {
      return (
        <Checkbox className="pa-checkbox" data-interactive="1" checked={!!n.value} onChange={flip} />
      );
    }
    // Строкой рисует `<ListItem checkbox>` -- его собственная составляющая для
    // этого и заведена: `li > label.item-checkbox.item-content` со своим
    // `input`, глифом и `item-inner` внутри.
    //
    // `<Checkbox>` сюда не годится и не годился: он всегда добавляет свой
    // `.checkbox`, а тот `display: inline-block`, и `item-content` перестаёт
    // быть линией flex. Он остаётся ячейке строки, где нужен маленький.
    //
    // `li` составляющая рисует сама, поэтому `listRow` здесь не зовётся --
    // он завернул бы её во второй. Обёртки те же, что у выбиральщика ниже.
    const item = (
      <ListItem
        checkbox checked={!!n.value} onChange={flip}
        className="pa-checkbox" data-interactive="1"
        title={n.label}
      />
    );
    if (c.inGroup) return item;
    return <Block>{item}</Block>;
  },
  "selection:select": (n, c) => <SmartSelect node={n} ctx={c} />,
  "selection:badge": (n) => (
    <span className="badge pa-tag">
      {(n.choices || []).find((x) => x.value === n.value)?.label ?? ""}
    </span>
  ),
  // `strong` -- это и класс, и подсветка под выбранным: её `<Segmented>`
  // дорисовывает сам, отдельным узлом её ставить не нужно.
  "selection:segmented": (n, c) => wrap(n, c, (
    <Segmented strong data-interactive="1">
      {(n.choices || []).map((x) => (
        <button
          key={x.value} type="button"
          className={`button${x.value === n.value ? " button-active" : ""}`}
          onClick={() => x.value !== n.value && c.commit(n, x.value)}
        >
          {x.label}
        </button>
      ))}
    </Segmented>
  )),
  "selection:radio": (n, c) => (
    <List strong inset className="pa-field" data-interactive="1">
      {(n.choices || []).map((x) => (
        <ListItem
          key={x.value} radio radioIcon="start" title={x.label}
          name={`r-${n.id}`} value={x.value}
          checked={String(n.value ?? "") === String(x.value)}
          onChange={() => c.commit(n, x.value)}
        />
      ))}
    </List>
  ),
  "selection:chips": (n, c) =>
    chipRow(
      n, c,
      (n.choices || []).map((x) => ({ key: x.value, label: x.label })),
      (x) => String(x.key) === String(n.value ?? ""),
      (x) => c.commit(n, String(x.key) === String(n.value ?? "") ? null : x.key),
      true,
    ),

  /* --- ordering ---------------------------------------------------------- */
  "integer:handle": () => <span className="sortable-handler" data-interactive="1" />,

  /* --- relations --------------------------------------------------------- */
  "many2one:select": (n, c) => <SmartSelect node={n} ctx={c} />,
  // Связь, названная там, где ей место, а не отдельной строкой: нажми-и-выбери,
  // который читается как ответ, с уголком, говорящим, что его можно сменить.
  // Обе платформы возглавляют карточку записи именно таким.
  "many2one:inline": (n, c) => listRow(n, c, (
    <a
      href="#" data-interactive="1"
      // `item-content` -- то, что несёт горизонтальные поля строки; без него
      // текст встаёт вплотную к краю карточки.
      // `item-link` рядом с `link` -- ради обрезки волны. Само по себе
      // прикосновение Framework7 ловит и по `.link`, но вместилище (`position:
      // relative; overflow: hidden`) он раздаёт только формам строки списка, а
      // `.link` получает одну лишь позицию. Уголок и поле под него `item-link`
      // здесь не приносит: те правила висят на `.item-inner`, которого у этой
      // строки нет.
      className={"link item-link item-content pa-inline-rel display-flex align-items-center "
        + "justify-content-flex-start text-color-primary"}
      style={{ width: "100%" }}
      onClick={(e) => { e.preventDefault(); c.pickRelation(n); }}
    >
      <span>{n.related?.display || n.label}</span>
      <Glyph name="arrow_drop_down" size={22} />
    </a>
  )),
  "many2many:list": (n, c) => <SmartSelect node={n} ctx={c} multiple />,
  "many2one:tag": (n) => <Tag rel={n.related} />,
  "many2one:chips": (n, c) =>
    chipRow(
      n, c,
      [
        { key: "", label: t("all") },
        ...(n.choices || []).map((x) => ({ key: x.id, label: x.display, color: x.color })),
      ],
      (x) => String(x.key) === (n.unset || n.value == null ? "" : String(n.value)),
      (x) => c.commit(n, x.key === "" ? null : x.key),
      false,
    ),
  "many2many:chips": (n, c) => {
    const linked = new Set((n.value || []).map(String));
    return chipRow(
      n, c,
      (n.choices || []).map((x) => ({ key: x.id, label: x.display, color: x.color })),
      (x) => linked.has(String(x.key)),
      (x) => {
        const id = x.key;
        const cur = n.value || [];
        c.commit(n, cur.includes(id) ? cur.filter((v) => v !== id) : [...cur, id]);
      },
      true,
    );
  },
  "many2many:tags": (n) => (
    <div className="pa-tags">
      {(n.related || []).map((r) => <Tag key={r.id} rel={r} />)}
    </div>
  ),
  "many2many:count": (n) => <span className="badge">{String((n.related || []).length)}</span>,

  /* --- binaries and geo --------------------------------------------------- */
  "binary:image": (n, c) => wrap(n, c, <FileInput node={n} ctx={c} />),
  "binary:file": (n, c) => wrap(n, c, <FileInput node={n} ctx={c} />),
  "geopoint:location": (n, c) => wrap(n, c, <GeoPoint node={n} ctx={c} />),
};

/**
 * Тот же виджет под другим типом поля.
 *
 * Счётчик рейтинга -- это счётчик целого; счёт One2many -- это счёт
 * Many2many. Сказанное данными, это держит таблицу выше на одной записи *на
 * отрисовку*, а не на одну на каждое сочетание.
 */
const ALIAS = {
  "datetime:title": "date:title",
  "duration:stepper": "integer:stepper",
  "float:range": "integer:range",
  "one2many:tags": "many2many:tags",
  "one2many:count": "many2many:count",
  "one2one:select": "many2one:select", "one2one:tag": "many2one:tag",
};

/* -------------------------------------------------- imperative extensions */

/** Виджеты, которых разметкой не выразить. Модули входят той же дверью. */
const IMPERATIVE = {};

/**
 * Зарегистрировать виджет из `static/*.js` модуля.
 *
 *     oneframework.registerWidget("selection:pill", {
 *       create(node, ctx) { ... return element },
 *       update(el, node, ctx) { ... },
 *       destroy(el) { ... },
 *     });
 *
 * `destroy` необязателен и нужен только тому, кто завёл живую составляющую
 * Framework7: узел уходит вместе со страницей, а составляющая -- нет.
 */
export function registerWidget(key, impl) {
  if (!impl || typeof impl.create !== "function") {
    throw new Error(`registerWidget(${key}): needs at least a create(node, ctx)`);
  }
  IMPERATIVE[key] = { update() {}, destroy() {}, ...impl };
  return key;
}

/**
 * Повелительный виджет внутри дерева React.
 *
 * React владеет гнездом и больше в него не заглядывает: элемент внутри создан
 * не им. Убирается он тем же эффектом, что и создал, -- и вместе с ним
 * убирается всё, что виджет за собой держит.
 *
 * Гнездом может быть что угодно: `<li>` для виджета, рисующего целую строку,
 * обёртка поля ввода -- для всех прочих. Поэтому здесь только ссылка на
 * элемент, а какой это элемент, решает раскладка ниже.
 */
function useImperative(impl, node, ctx) {
  const ref = useRef(null);
  const live = useRef(null);
  const latest = useRef(null);
  latest.current = { node, ctx };

  useLayoutEffect(() => {
    const seat = ref.current;
    let el = null;
    try {
      el = impl.create(latest.current.node, latest.current.ctx);
      seat.appendChild(el);
      live.current = el;
    } catch (err) {
      console.error(`[oneframework] виджет ${latest.current.node.name}`, err);
    }
    return () => {
      try {
        if (el) impl.destroy(el);
      } catch (err) {
        console.warn("[oneframework] виджет не убрался", err);
      }
      live.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impl]);

  useEffect(() => {
    if (!live.current) return;
    try {
      impl.update(live.current, node, ctx);
    } catch (err) {
      console.error(`[oneframework] виджет ${node.name}(${node.widget})`, err);
    }
  });

  return ref;
}

/**
 * Две формы, в которых приходят составляющие Framework7, привязанные к элементу.
 *
 * У Calendar, ColorPicker, Autocomplete, Picker и PhotoBrowser нет класса
 * `*-init`, поэтому они строятся против настоящего элемента. Различаются только
 * сам элемент и то, как показывается значение.
 */
const element = (markup) => {
  const box = document.createElement("div");
  box.innerHTML = markup;
  return box.firstElementChild;
};

/**
 * Поле ввода, из которого составляющая Framework7 открывается и в которое
 * пишет обратно.
 *
 * `show` -- как читается хранимое значение. Без него показывается собственная
 * форма колонки, что верно для текста и неверно для даты: составляющая
 * форматирует значение, когда его выбирают, и это обновление затёрло бы
 * форматированное лежащим под ним ISO на первой же отрисовке.
 */
const boundInput = (attach, cls = "", show = null) => ({
  create(node, ctx) {
    const input = element(
      `<input class="pa-input ${cls}" type="text" readonly data-interactive="1" />`,
    );
    input.placeholder = node.placeholder ?? node.label ?? "";
    input._node = node;
    input._live = attach(input, node, ctx);
    this.update(input, node);
    return input;
  },
  update(input, node) {
    input._node = node;
    input.placeholder = node.placeholder ?? node.label ?? "";
    // Набрать в нём нельзя, но фокус всё ещё значит, что лист открыт.
    if (document.activeElement !== input) {
      input.value = show ? show(node.value, node) : node.value ?? "";
    }
  },
  destroy(input) {
    input._live?.destroy?.();
    input._live = null;
  },
});

/**
 * Строка списка Framework7, из которой открывается составляющая: ColorPicker,
 * Autocomplete, PhotoBrowser. `show` заполняет хвостовой слот; та, что красит
 * этот слот сама, `show` не даёт и вместо этого ставит `row.sync` в `attach`.
 */
const boundRow = (attach, show) => ({
  row: true,
  create(node, ctx) {
    const row = element(
      '<a class="item-link item-content" href="#" data-interactive="1"><div class="item-inner">'
        + '<div class="item-title pa-field__label"></div>'
        + '<div class="item-after pa-select__value"></div></div></a>',
    );
    row._node = node;
    row._live = attach(row, node, ctx);
    this.update(row, node);
    return row;
  },
  update(row, node) {
    row._node = node;
    row.querySelector(".item-title").textContent = node.label;
    row.sync?.();
    if (!show) return;
    const text = show(node);
    const after = row.querySelector(".item-after");
    after.textContent = text;
    after.classList.toggle("pa-select__empty", text === t("none"));
  },
  destroy(row) {
    row._live?.destroy?.();
    row._live = null;
  },
});

/** Открывается по нажатию, как бы составляющая это ни называла. */
const opensOnClick = (row, open) =>
  row.addEventListener("click", (event) => {
    event.preventDefault();
    open();
  });

registerWidget(
  "color:color",
  boundRow((row, node, ctx) => {
    // Пустой значок Framework7 *и есть* цветная точка, а выбиральщик красит
    // свою цель сам -- значит на значение не нужно ни строки кода.
    const swatch = element('<span class="badge pa-swatch"></span>');
    row.querySelector(".item-after").appendChild(swatch);
    const picker = ctx.f7.colorPicker.create({
      targetEl: swatch,
      targetElSetBackgroundColor: true,
      openIn: "sheet",
      modules: ["palette", "hex"],
      sheetSwipeToClose: true,
      value: { hex: cssColor(node.value || "#6750A4") },
      on: {
        change: (_p, value) => {
          // Framework7 приводит к нижнему регистру; сравнение без учёта
          // регистра не даёт переписывать хранимое "#6750A4" на каждой
          // отрисовке.
          commitIf(ctx, row._node, value.hex, "безРегистра");
        },
      },
    });
    row.sync = () => {
      const hex = cssColor(row._node.value || "#6750A4");
      if (String(picker.getValue()?.hex || "").toLowerCase() !== hex.toLowerCase()) {
        picker.setValue({ hex });
      }
    };
    opensOnClick(row, () => picker.open());
    return picker;
  }),
);

const autocomplete = boundRow(
  (row, node, ctx) =>
    ctx.f7.autocomplete.create({
      openIn: "page",
      openerEl: row,
      pageTitle: node.label,
      searchbarPlaceholder: t("search"),
      valueProperty: "id",
      textProperty: "display",
      source(query, render) {
        const items = row._node.choices || [];
        const needle = (query || "").toLowerCase();
        render(
          needle ? items.filter((i) => String(i.display).toLowerCase().includes(needle)) : items,
        );
      },
      on: {
        change: (_a, value) => ctx.commit(row._node, value?.[0] ? value[0].id : null),
      },
    }),
  (node) => node.related?.display ?? t("none"),
);
registerWidget("many2one:autocomplete", autocomplete);
registerWidget("one2one:autocomplete", autocomplete);

registerWidget(
  "binary:browser",
  boundRow(
    (row, node, ctx) => {
      const browser = ctx.f7.photoBrowser.create({
        photos: [],
        theme: "dark",
        type: "popup",
        toolbar: false,
      });
      opensOnClick(row, () => {
        browser.params.photos = row._node.value ? [row._node.value] : [];
        if (browser.params.photos.length) browser.open();
      });
      return browser;
    },
    (node) => (node.value ? t("open") : t("none")),
  ),
);

/**
 * Picker Framework7: колесо в карточке.
 *
 * Из одной составляющей выходят две формы -- одна колонка выбора для Selection,
 * две колонки чисел для Time, -- поэтому виджет говорит только, каковы колонки,
 * а остальное делает фреймворк.
 */
const picker = (columns, read, write) =>
  boundInput((input, node, ctx) =>
    ctx.f7.picker.create({
      inputEl: input,
      openIn: "sheet",
      rotateEffect: true,
      cols: columns(node),
      value: read(node),
      formatValue: (values) => write(values),
      on: {
        change: (_p, values) => {
          const next = write(values);
          commitIf(ctx, input._node, next);
        },
      },
    }),
    "pa-picker",
  );

registerWidget(
  "selection:picker",
  picker(
    (node) => [
      {
        textAlign: "center",
        values: (node.choices || []).map((c) => c.value),
        displayValues: (node.choices || []).map((c) => c.label),
      },
    ],
    (node) => [node.value ?? ""],
    (values) => values[0] ?? null,
  ),
);

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
/**
 * Промежуток в минутах на том же колесе.
 *
 * Ни у одной платформы органа для длительности нет, но пишут длительность обе
 * одинаково -- две колонки, часы и минуты, ровно как таймер на iOS. Значение
 * остаётся целыми минутами; колесо только показывает их.
 */
registerWidget(
  "duration:picker",
  picker(
    () => [
      { values: HOURS, textAlign: "right" },
      { divider: true, content: " ч " },
      { values: MINUTES, textAlign: "left" },
      { divider: true, content: " мин" },
    ],
    (node) => {
      const total = Number(node.value || 0);
      return [String(Math.floor(total / 60)).padStart(2, "0"), String(total % 60).padStart(2, "0")];
    },
    (values) => Number(values[0]) * 60 + Number(values[1]),
  ),
);

registerWidget(
  "time:picker",
  picker(
    () => [
      { values: HOURS, textAlign: "right" },
      { divider: true, content: ":" },
      { values: MINUTES, textAlign: "left" },
    ],
    (node) => String(node.value || "00:00").split(":"),
    (values) => `${values[0]}:${values[1]}`,
  ),
);

registerWidget(
  "date:calendar",
  boundInput((input, node, ctx) =>
    ctx.f7.calendar.create({
      inputEl: input,
      openIn: "sheet",
      closeOnSelect: true,
      locale: locale(),
      dateFormat: node.options?.format || DATE_FORMAT,
      value: node.value ? [new Date(node.value)] : [],
      on: {
        change: (_c, values) => {
          if (!values.length) return;
          const d = values[0];
          const iso = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, "0"),
            String(d.getDate()).padStart(2, "0"),
          ].join("-");
          commitIf(ctx, input._node, iso);
        },
      },
    }),
    "",
    (value, node) => stamp(value, node?.options?.format),
  ),
);

/* -------------------------------------------------------------------- api */

export const imperativeWidget = (node) => IMPERATIVE[`${node.ftype}:${node.widget}`];

/**
 * Виджет разметки для узла.
 *
 * `undefined` значит «не разметка» -- либо для него зарегистрирован
 * повелительный виджет, либо у типа поля нет разумного поля ввода, и
 * истолкователь показывает значение только для чтения.
 */
export function reactWidget(node) {
  const asked = `${node.ftype}:${node.widget}`;
  const key = ALIAS[asked] ?? asked;
  if (WIDGETS[key]) return WIDGETS[key];
  if (IMPERATIVE[asked]) return undefined;
  // Всё остальное -- одно поле ввода; тип поля выбирает клавиатуру и подсказку
  // автозаполнения.
  const spec = INPUT[node.widget] || FALLBACK[node.ftype];
  if (spec) return (n, c) => wrap(n, c, <TextInput node={n} ctx={c} spec={spec} />);
  return undefined;
}

/**
 * Гнездо повелительного виджета -- со всей той же оглядкой на группу, что и у
 * подписанной строки: собственная карточка, вложенная в карточку группы, взяла
 * бы отступ дважды и встала бы уже соседних строк.
 */
export function ImperativeWidget({ node, ctx, impl, ...extra }) {
  const ref = useImperative(impl, node, ctx);
  if (ctx.mode !== "form") return <div ref={ref} {...extra} />;
  if (impl.row) {
    const li = <li ref={ref} {...(ctx.inGroup ? extra : null)} />;
    return ctx.inGroup ? li : <Block {...extra}>{li}</Block>;
  }
  const row = (
    <InputRow node={node} ctx={ctx} {...(ctx.inGroup ? extra : null)}>
      <div className="item-input-wrap" ref={ref} />
    </InputRow>
  );
  return ctx.inGroup ? row : <Block {...extra}>{row}</Block>;
}

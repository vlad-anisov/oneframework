/**
 * Иконка -- лигатура Material Icons, и ничего больше.
 *
 * Сам `<i>` рисует `<Icon>` Framework7 (`f7r/components/icon.js:69-81`), обёртка
 * осталась ради чистки имени и `aria-hidden` -- иначе их повторять в 15 местах.
 */
import React from "react";
import { Icon } from "framework7-react";

/** Имя чистится так же, как в `icon()`: в лигатуру попадает только имя. */
const clean = (name) => String(name || "").replace(/[^a-z0-9_]/gi, "");

/**
 * Дети попадают внутрь `<i>` -- это не вольность, а приём Framework7: значок с
 * числом он рисует вложенным в иконку, и по нему же располагает. Так сделан
 * счётчик неотправленного на признаке обмена.
 *
 * `material-icons` прибит явно: у `<Icon>` он держится на непустом имени
 * (`icon.js:49`), а прежний `<i>` нёс его всегда -- шрифт не должен зависеть
 * от того, доехало имя. `style` ложится поверх трёх свойств размера, не
 * отменяя их (`icon.js:71-75`): цвет ведущей иконки говорится на ней самой.
 */
export function Glyph({ name, size = 24, className = "", style, children = null }) {
  return (
    <Icon material={clean(name)} size={size} aria-hidden="true" style={style}
      className={`material-icons ${className}`.trim()}>{children}</Icon>
  );
}

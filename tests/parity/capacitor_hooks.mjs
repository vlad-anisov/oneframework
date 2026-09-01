/**
 * Переходник загрузчика: `@capacitor/app` -> подделка рядом.
 *
 * Иначе не подменить: `address.js` импортирует пакет по имени, и Node ищет его
 * от самого файла вверх по `node_modules` -- то есть находит настоящий, тот
 * самый, который в Node не заводится. Подмена именно здесь, а не доводом в
 * `bindAddress`: щель для подстановки, заведённая только ради проверки,
 * означала бы, что проверяется не то, что поедет в устройство.
 *
 * `module.register` -- Node 20.6 и новее.
 */

export async function resolve(specifier, context, next) {
  if (specifier === "@capacitor/app") {
    return { url: new URL("./capacitor_app.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}

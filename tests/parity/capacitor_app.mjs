/**
 * Подделка `@capacitor/app` -- ровно те две двери, которыми ходит `address.js`.
 *
 * Настоящий плагин в Node не завести: его веб-подкладка живёт на документе, а
 * нативной на этой машине нет вовсе. Подделан он целиком, как окно и склад
 * рядом (`tests/js/address.test.mjs`), и по той же причине: спор здесь не о том, что
 * умеет Capacitor, а о том, обе ли двери открыты и что в них входит.
 *
 * Состояние -- на `globalThis`, потому что подставляется этот модуль
 * переходником загрузчика (`capacitor_hooks.mjs`): достать его ссылкой
 * неоткуда, `address.js` импортирует по имени пакета.
 */

const state = () =>
  (globalThis.__capacitorApp ||= { listeners: {}, launch: null, removed: 0 });

export const App = {
  /** Возвращает снималку -- её и ждёт `address.js`, чтобы отвязаться. */
  async addListener(name, handler) {
    const app = state();
    (app.listeners[name] ||= []).push(handler);
    return {
      remove: async () => {
        app.removed += 1;
        app.listeners[name] = (app.listeners[name] || []).filter((f) => f !== handler);
      },
    };
  },

  //: Запуска без ссылки настоящий плагин описывает пустым ответом, а не
  //: отказом, -- отсюда и `launch?.url` на той стороне.
  async getLaunchUrl() {
    const app = state();
    return app.launch ? { url: app.launch } : {};
  },
};

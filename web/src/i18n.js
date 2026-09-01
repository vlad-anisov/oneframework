/**
 * UI chrome strings owned by the framework (not by the app).
 *
 * The app's own text always comes from the Python DSL -- labels, filter names,
 * sort names. Only framework-generated affordances need translating, so the
 * table stays tiny. Locale comes from the app metadata when it sets one, else
 * from the browser.
 */

const STRINGS = {
  en: {
    all: "All",
    search: "Search",
    sort: "Sort by",
    cancel: "Cancel",
    delete: "Delete",
    confirmDelete: "Delete this record?",
    none: "None",
    open: "Open",
    empty: "Nothing here yet",
    pickRecord: "Select a record",
    pickRecordHint: "Choose one on the left to see it here",
  },
  ru: {
    all: "Все",
    search: "Поиск",
    sort: "Сортировать",
    cancel: "Отмена",
    delete: "Удалить",
    confirmDelete: "Удалить запись?",
    none: "Не указано",
    open: "Открыть",
    empty: "Пока пусто",
    pickRecord: "Выберите запись",
    pickRecordHint: "Слева — список, здесь будет карточка",
  },
};

let current = "en";

function setLocale(locale) {
  const code = String(locale || "").slice(0, 2).toLowerCase();
  current = STRINGS[code] ? code : "en";
  return current;
}

export function detectLocale(preferred) {
  return setLocale(preferred || navigator.language || "en");
}

/**
 * The locale in force, for anything formatting a value rather than picking a
 * string: dates, numbers. Without it those follow the browser while the
 * framework's own words follow the app, and one screen ends up in two
 * languages.
 */
export function locale() {
  return current;
}

export function t(key) {
  return (STRINGS[current] && STRINGS[current][key]) || STRINGS.en[key] || key;
}

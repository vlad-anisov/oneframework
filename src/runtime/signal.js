/**
 * Зависимости находятся сами, в момент чтения: эффект, пока он выполняется,
 * лежит на стеке, и каждый прочитанный сигнал записывает его себе в подписчики.
 * Поэтому в приложении нигде нет `refresh()` -- и не должно появиться, иначе
 * половина экрана начнёт обновляться по чужому расписанию.
 *
 * Таблица базы -- тоже сигнал. Запись задачи двигает сигнал `Task`, а он
 * пересчитывает ровно те запросы, которые эту таблицу читали.
 */

const STACK = [];
let PENDING = [];
let BATCH_DEPTH = 0;

/**
 * Равенство «то же самое значение». Питоновский `_same` сначала пробует `is`,
 * потом `==`; здесь то же самое, только для массивов и простых объектов
 * сравнение поверхностное -- глубокого в питоне тоже нет, а значит и разойтись
 * они не могут.
 */
function same(a, b) {
  if (a === b) return true;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return false;
}

export class Signal {
  constructor(value = null, name = "") {
    this._value = value;
    this._subs = new Set();
    this.name = name;
  }

  get() {
    if (STACK.length) {
      const effect = STACK[STACK.length - 1];
      effect.deps.add(this);
      this._subs.add(effect);
    }
    return this._value;
  }

  /** Прочитать, не заводя зависимости. */
  peek() {
    return this._value;
  }

  set(value) {
    if (same(value, this._value)) return false;
    this._value = value;
    this.notify();
    return true;
  }

  update(fn) {
    return this.set(fn(this._value));
  }

  notify() {
    for (const effect of [...this._subs]) schedule(effect);
  }
}

export class Effect {
  constructor(fn, name = "", onError = null) {
    this.fn = fn;
    this.name = name;
    this.deps = new Set();
    this.disposed = false;
    this.onError = onError;
    this.result = null;
  }

  run() {
    if (this.disposed) return null;
    for (const dep of this.deps) dep._subs.delete(this);
    this.deps.clear();
    STACK.push(this);
    try {
      this.result = this.fn();
    } catch (err) {
      // Один сломанный экран не должен уносить приложение целиком.
      if (this.onError === null) throw err;
      this.onError(err);
    } finally {
      STACK.pop();
    }
    return this.result;
  }

  dispose() {
    this.disposed = true;
    for (const dep of this.deps) dep._subs.delete(this);
    this.deps.clear();
  }
}

function schedule(effect) {
  if (effect.disposed || PENDING.includes(effect)) return;
  PENDING.push(effect);
  if (BATCH_DEPTH === 0) flush();
}

function flush() {
  let guard = 0;
  while (PENDING.length) {
    guard += 1;
    if (guard > 10000) {
      throw new Error("реактивное обновление не сошлось (цикл зависимостей?)");
    }
    PENDING.shift().run();
  }
}

/** Собрать пачку изменений в один прогон эффектов. */
export function batch(fn) {
  BATCH_DEPTH += 1;
  try {
    return fn();
  } finally {
    BATCH_DEPTH -= 1;
    if (BATCH_DEPTH === 0) flush();
  }
}

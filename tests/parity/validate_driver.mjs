/**
 * Проверка набора, написанная на исходном языке, обязана быть отвергнута.
 *
 * Считается она внутри записи, а запись синхронна: транзакция не умеет
 * дождаться обещания. Действие на исходном языке обещание и возвращает --
 * значит `validator` прочитал бы у него поле с ошибками, которого нет, и
 * пропустил бы всё молча.
 *
 * Настоящей базы здесь не нужно: `register` спрашивает только объявления, и
 * подменяется ровно этот один вызов.
 */
import { register } from "../../src/runtime/logic.js";

const объявление = (носитель) => ({
  name: "Task.validate",
  model: "Task",
  args: [{ name: "records", type: "json" }],
  returns: [{ name: "errors", type: "json" }],
  ...носитель,
});

const база = (доки) => ({
  connect: () => ({
    execute: (sql) => (sql.includes("_oneframework_def")
      ? доки.map((d) => ({ kind: "action", name: d.name, doc: JSON.stringify(d) }))
      : []),
    one: () => null,
  }),
});

const попытка = async (носитель) => {
  try {
    await register(база([объявление(носитель)]), { actions: {}, models: {} });
    return { отвергнуто: false };
  } catch (err) {
    return { отвергнуто: true, слово: String(err.message) };
  }
};

const ответ = {
  python: await попытка({ python: { entry: "check", source: "def check(f): pass" } }),
  js: await попытка({ js: { entry: "check", source: "export function check() {}" } }),
  объявлением: await попытка({ rule: { name: "self" }, write: { set: {} } }),
};
process.stdout.write(JSON.stringify(ответ));

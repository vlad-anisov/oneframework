/**
 * Точка запуска сервера для `oneframework serve`.
 *
 * Настройки приходят окружением, а не строкой запуска: ключ обмена в ней виден
 * в списке процессов любому пользователю машины, и раз уж один параметр обязан
 * ехать так, пусть едут все -- одним способом, а не двумя.
 *
 * Файл тонкий нарочно: всё, что умеет сервер, лежит в `http.mjs`, а здесь
 * только чтение окружения и уход по сигналу. Так его можно запускать и не из
 * питоновской команды.
 */
import { serve } from "./http.mjs";

const s = await serve({
  file: process.env.OF_DB || null,
  dist: process.env.OF_DIST || null,
  host: process.env.OF_HOST || "127.0.0.1",
  port: Number(process.env.OF_PORT || 8765),
  standTitle: process.env.OF_TITLE || null,
});

const адрес = `http://${s.host}:${s.port}`;
console.log(`Обмен и клиент: ${адрес}`);
console.log(`База: ${process.env.OF_DB || "в памяти"} | журнал: ${s.server.logSize()}`);
if (!process.env.OF_DIST) console.log("Статики нет: отдаётся только точка обмена.");

// Выход по сигналу -- через `stop`: он дописывает базу. Без этого последняя
// правка осталась бы только в памяти умершего процесса.
for (const сигнал of ["SIGINT", "SIGTERM"]) {
  process.on(сигнал, async () => {
    await s.stop();
    process.exit(0);
  });
}

/**
 * Ничего нового про обмен сервер не знает: он знает **журнал** -- строки с
 * порядковыми номерами -- и раздаёт из него хвост. Всё остальное берётся из
 * `sync.js` и `defs.js`, то есть из того же кода, что стоит на устройстве.
 * Второй реализации обмена здесь нет нарочно: разойдясь, две реализации
 * показывают разное, а не отказывают.
 *
 * Чего здесь нет: областей видимости, ограничения хвоста и уплотнения журнала.
 * Правила -- в `tests/js/http.test.mjs`.
 */
import * as sync from "./core/runtime/sync.js";
import * as defs from "./core/runtime/defs.js";
import * as keys from "./core/runtime/keys.js";

export const LOG_TABLE = "_oneframework_sync_log";

//: Слово в слово те же, что у питона: их видит человек, и расходиться им
//: нельзя. Первая редакция была написана по памяти -- сверка это и поймала.
export const REFUSED_NOTE =
  "Виды, модели и модули логики публикует сервер -- они едут от него к "
  + "устройствам, а не обратно. Устройство таких строк не создаёт: "
  + "единственный писатель в эти таблицы на нём -- приём. Изменения этих "
  + "таблиц из конверта выброшены и не записаны; всё остальное в нём "
  + "принято.";

export const UNREADABLE_NOTE =
  "Этот changeset не прочитан: блоб не разбирается ни как base64, ни "
  + "как changeset. Он не записан и не наложен, а из очереди его надо "
  + "убрать -- повтор даст то же самое. Остальное из конверта принято.";

//: Таблицы, которые устройство не вправе править: это исполняемая настройка.
const GUARDED = ["_oneframework_def", "_oneframework_logic"].map(String);

const b64encode = (bytes) => Buffer.from(bytes).toString("base64");
const b64decode = (text) => new Uint8Array(Buffer.from(String(text), "base64"));

export class SyncServer {
  /**
   * @param db      `Database` из `src/runtime/db.js`
   * @param api     `sync.SessionApi` -- расширение session
   * @param signer  приватный ключ издателя или `null`
   */
  constructor(db, api, signer = null) {
    this.db = db;
    this.api = api;
    this.signer = signer;
    this._ensureLog();
    // Сервер и сам правит данные -- значит его правки обязаны попадать в
    // журнал тем же путём, что чужие.
    if (!db.tracker) sync.enable(db, api);
    //: Отпечаток -- после `enable`: тот заводит таблицы определений и логики.
    this.schema = sync.schemaVersion(db);
  }

  _ensureLog() {
    const con = this.db.connect();
    con.execute(
      `CREATE TABLE IF NOT EXISTS "${LOG_TABLE}" (`
      + '"seq" INTEGER PRIMARY KEY AUTOINCREMENT, '
      + '"id" TEXT NOT NULL UNIQUE, '
      + '"node" TEXT NOT NULL, '
      + '"stamp" TEXT NOT NULL, '
      + '"blob" BLOB NOT NULL)',
    );
    return con;
  }

  /** Сколько changeset'ов прошло через журнал -- для паспорта стенда. */
  logSize() {
    return this._ensureLog()
      .execute(`SELECT COUNT(*) AS n FROM "${LOG_TABLE}"`)[0].n;
  }

  /** `POST /sync`: принять чужое, отдать своё, вернуть курсор. */
  async sync(request) {
    const запрос = typeof request === "string" ? JSON.parse(request) : request;
    try {
      await this._check(запрос);
    } catch (err) {
      if (!(err instanceof sync.SyncError)) throw err;
      return this._sign({
        protocol: sync.PROTOCOL, schema: this.schema, error: String(err.message),
      });
    }

    const node = запрос.node || "?";
    const [accepted, refused] = this._accept(
      запрос.changes || [], node, this._guarding(запрос),
    );
    // Правки самого сервера попадают в журнал тем же путём, что чужие.
    this._absorbOwn();

    const [changes, top] = this._since(Number(запрос.cursor || 0), node);
    const ответ = {
      protocol: sync.PROTOCOL,
      schema: this.schema,
      accepted,
      changes,
      cursor: top,
      defs: sync.defsFor(this.db, запрос.defs),
    };
    // Отбраковка обязана быть слышна. Поле появляется, только когда есть о чём
    // говорить: пустой список в каждом ответе научил бы на него не смотреть.
    if (refused.length) ответ.refused = refused;
    return this._sign(ответ);
  }

  /**
   * Подписать ответ, если ключ есть. Подписывается и отказ.
   *
   * И отказ тоже: неподписанное «схемы разошлись» -- готовый способ остановить
   * обмен всему парку, не имея никакого ключа.
   */
  _sign(payload) {
    if (this.signer === null) return payload;
    const тело = { ...payload };
    delete тело.sig;
    return { ...тело, sig: { key: this.signer.publicHex, sig: this.signer.sign(тело) } };
  }

  async _check(запрос) {
    // Конверт от собеседника проверяется, **если он подписан**. Требовать
    // подпись нельзя: у устройства приватного ключа нет и быть не должно.
    // Смысл в другом -- вторым узлом бывает второй сервер, и его конверт
    // подписан; молча принять подделку от него было бы худшим исходом.
    if ((запрос || {}).sig && this.signer !== null) {
      const тело = { ...запрос };
      delete тело.sig;
      const сошлось = await keys.verify(
        this.signer.publicHex, keys.ENVELOPE, тело, запрос.sig.sig,
      );
      if (!сошлось) throw new sync.SyncError("Подпись конверта не сходится.");
    }
    if (запрос.protocol !== sync.PROTOCOL) {
      throw new sync.SyncError(
        `Формат обмена ${JSON.stringify(запрос.protocol)} против нашего ${sync.PROTOCOL}.`,
      );
    }
    // Правило про отпечаток одно на обе стороны провода и живёт в
    // `sync.checkSchema`. Записанное здесь второй раз, оно однажды разошлось с
    // клиентским -- и клиент принимал то, что сервер уже отвергал.
    sync.checkSchema(this.schema, запрос.schema);
    sync.checkStamps(запрос.changes);
  }

  /**
   * Отбраковывать ли определения и модули в этом конверте.
   *
   * Правило то же, что у подписи во всём каркасе: **ключа нет -- проверять
   * нечем**. Сервер без ключа не отличает издателя от прохожего ничем, и
   * запрет на одни таблицы при разрешённых остальных был бы не границей, а её
   * изображением.
   */
  _guarding(запрос) {
    if (this.signer === null) return false;
    return !(запрос || {}).sig;
  }

  /**
   * Записать чужие changeset'ы в журнал и наложить на общую базу.
   *
   * Отвергнутое попадает и в `accepted`, и в `refused`: отказ окончательный, а
   * не «попробуй позже», и changeset, оставленный в очереди, ездил бы кругами
   * вечно.
   */
  _accept(changes, node, guard = false) {
    const con = this._ensureLog();
    const accepted = [];
    const refused = [];
    for (const change of changes) {
      const key = change.id;
      accepted.push(key);
      const было = con.execute(
        `SELECT 1 AS x FROM "${LOG_TABLE}" WHERE "id" = ?`, [key],
      );
      if (было.length) continue;      // повтор: клиент не получил подтверждения

      let blob;
      try {
        blob = b64decode(change.blob);
        if (!blob.length) throw new Error("пусто");
      } catch (err) {
        // Нечитаемый блоб останавливает этот changeset и только его. Раньше он
        // останавливал круг целиком, и устройство переставало обмениваться
        // навсегда.
        refused.push({ id: key, reason: UNREADABLE_NOTE, error: String(err.message) });
        continue;
      }

      if (guard) {
        const задержано = this.api.tablesOf(blob).filter((t) => GUARDED.includes(t));
        if (задержано.length) {
          // **Разница с питоновским сервером, и она намеренная.** Тот вырезает
          // охраняемые таблицы и накладывает остальное; здесь отвергается весь
          // changeset. Причина в средствах: у apsw есть готовая пересборка
          // блоба, а в WASM её нет -- есть только обход (`tablesOf`) и
          // `changegroup`, которым пришлось бы переизлагать строки руками.
          //
          // Отказ целиком строже, а не слабее: ни одна охраняемая строка не
          // пройдёт. Цена -- честные правки того же конверта уедут заново
          // следующим кругом, потому что в `accepted` ключ всё равно попал.
          // Когда пересборку напишут, разница обязана уйти: сверка её ловит.
          refused.push({ id: key, tables: задержано, reason: REFUSED_NOTE });
          continue;
        }
      }
      // Кроме отвергнутого в конверте не было ничего: пустой блоб нечего
      // накладывать, а раздать его другим значило бы заставить их разбирать
      // пустоту.
      if (!blob || !blob.length) continue;

      // Журнал и наложение -- одна граница, и это условие безопасности.
      // Строка журнала означает «этот changeset уже принят»; записанная
      // отдельно от наложения, она отменяет повтор навсегда.
      this.db.transaction(() => {
        con.execute(
          `INSERT INTO "${LOG_TABLE}" ("id","node","stamp","blob") VALUES (?,?,?,?)`,
          [key, change.node || node, change.stamp, blob],
        );
        sync.applyChangeset(this.db, this.api, blob, change.stamp, node);
      });
    }
    return [accepted, refused];
  }

  _absorbOwn() {
    const con = this._ensureLog();
    const своё = sync.outgoing(this.db);
    if (!своё.length) return;
    const node = this.db.clock().node;
    this.db.transaction(() => {
      for (const change of своё) {
        con.execute(
          `INSERT OR IGNORE INTO "${LOG_TABLE}" ("id","node","stamp","blob") `
          + "VALUES (?,?,?,?)",
          [change.id, node, change.stamp, b64decode(change.blob)],
        );
      }
    });
    sync.forget(this.db, своё.map((c) => c.id));
  }

  /**
   * Что появилось после курсора -- и докуда клиент теперь дочитал.
   *
   * Курсор двигается до конца журнала, а не до последнего *отданного*
   * изменения: свои собственные changeset'ы клиенту не возвращаются, и считай
   * мы по отданным, он спрашивал бы о них вечно.
   */
  _since(cursor, node) {
    const con = this._ensureLog();
    const верх = con.execute(`SELECT MAX("seq") AS top FROM "${LOG_TABLE}"`)[0].top || 0;
    const строки = con.execute(
      `SELECT "seq","id","node","stamp","blob" FROM "${LOG_TABLE}" `
      + 'WHERE "seq" > ? AND "node" <> ? ORDER BY "seq" ASC',
      [cursor, node],
    );
    return [
      строки.map((r) => ({
        seq: r.seq, id: r.id, node: r.node, stamp: r.stamp, blob: b64encode(r.blob),
      })),
      верх,
    ];
  }
}

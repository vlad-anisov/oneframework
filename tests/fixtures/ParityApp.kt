/**
 * То же приложение, объявленное **на Kotlin**.
 *
 * Третий близнец `tests/fixtures/parity_app.py` и `parity_app.mjs`, и
 * существует ради того же: задеть каждый род узла и каждое умолчание, которое
 * у привязок может разойтись. Совпадение сторожит
 * `tests/test_three_languages.py`.
 *
 * Различия в записи -- законные и намеренные. Поле пишется `Книга.title()`, а
 * не `record.title()`: это настоящее свойство, которое проверяет компилятор.
 * Запись повторителя -- `item(Полка.имя)`, и опечатку тоже ловит он.
 * Одинаковым обязан быть **документ**, а не текст.
 */

package parity

import oneframework.Model
import oneframework.Screen
import oneframework.View
import oneframework.accordion
import oneframework.app
import oneframework.boolean
import oneframework.button
import oneframework.col
import oneframework.color
import oneframework.date
import oneframework.datetime
import oneframework.expr
import oneframework.filter
import oneframework.group
import oneframework.icon
import oneframework.integer
import oneframework.float
import oneframework.list
import oneframework.many2one
import oneframework.menu
import oneframework.monetary
import oneframework.pill
import oneframework.repeat
import oneframework.row
import oneframework.search
import oneframework.section
import oneframework.selection
import oneframework.sort
import oneframework.string
import oneframework.tab
import oneframework.tabs
import oneframework.text
import oneframework.time
import oneframework.Create
import oneframework.Delete
import oneframework.Save

object Полка : Model("Полка", table = "полка") {
    // `name` -- имя самой модели в Kotlin, поэтому колонка названа явно.
    // Отдать её нельзя: `display_field` ищет именно `name`, и без неё запись
    // рисовалась бы ключом.
    val имя by string("Название", required = true).named("name")
    val цвет by color("Цвет").named("color")
}

object Книга : Model("Книга", table = "книга") {
    val title by string("Заглавие", required = true)
    val notes by text("Заметки")
    val shelf by many2one(Полка, "Полка")
    val read by boolean("Прочитана")
    val sequence by integer("Порядок")
    val pages by integer("Страниц", maximum = 5000)
    val weight by float("Вес", digits = listOf(6, 2))
    val price by monetary("Цена", currency = "BYN")
    val kind by selection(listOf("proza" to "Проза", "stihi" to "Стихи"), "Род")
    val bought by date("Куплена")
    val opened by datetime("Открыта")
    val alarm by time("Напоминание")
}

object Строка : View("Строка", model = Книга) {
    override fun ui() = nodes(
        row(
            Книга.sequence(widget = "handle"),
            Книга.read(widget = "toggle"),
            Книга.title(widget = "title"),
            Книга.shelf(widget = "tag"),
            button(icon = "delete", action = Книга.delete()),
        ),
    )
}

object Карточка : View("Карточка", model = Книга, crumbs = false) {
    override fun ui() = nodes(
        section("Про книгу", "то, что видно с полки"),
        group(
            col(Книга.title(), span = 6),
            col(Книга.kind(), span = 6),
            label = "Главное",
            cols = 2,
        ),
        accordion(
            Книга.notes(widget = "textarea"),
            Книга.weight(),
            Книга.price(),
            label = "Подробности",
            open = true,
        ),
        button("Сохранить", action = Save()),
        button("Удалить", action = Книга.delete()),
    )
}

object Полки : View("Полки", title = "Полки") {
    val shelf by many2one(Полка, "Полка")

    override fun ui() = nodes(
        shelf(widget = "chips"),
        tabs(
            repeat(Полка) { item ->
                listOf(
                    tab(
                        "{item.name}",
                        icon("book"),
                        pill(
                            expr("count(Книга, record.shelf = item.id & !record.read)"),
                            shown = "closed",
                        ),
                        button(
                            place = "fab",
                            action = Create(Книга, open = Карточка,
                                            values = mapOf("shelf" to item.id)),
                        ),
                        list(
                            Книга,
                            item = Строка,
                            open = Карточка,
                            label = "{item.name}",
                            domain = expr("record.shelf = item.id & !record.read"),
                            menu = menu(
                                button("Новая книга",
                                       action = Create(Книга, open = Карточка, draft = true)),
                                button(
                                    "Удалить прочитанные",
                                    action = Delete(
                                        model = Книга,
                                        domain = expr("record.shelf = item.id & record.read"),
                                        confirm = "Удалить прочитанное с «{item.name}»?",
                                    ),
                                    enabled = expr("exists(Книга, record.shelf = item.id & record.read)"),
                                ),
                                icon = "more_horiz",
                            ),
                            search = search(
                                Книга.title,
                                filter("Непрочитанные", expr("!record.read"), default = true),
                                filter("Прочитанные", Книга.read),
                                sort("По порядку", Книга.sequence, default = true),
                                sort("Позже куплённые", Книга.bought.desc(), section = true),
                            ),
                        ),
                        accordion(
                            list(Книга, item = Строка,
                                 domain = expr("record.shelf = item.id & record.read")),
                            label = "Прочитанные",
                            visible = expr("exists(Книга, record.shelf = item.id & record.read)"),
                        ),
                    ),
                )
            },
            button("Полка", action = Create(Полка)),
            page = true,
        ),
    )
}

val application = app(
    screens = listOf(Screen(Полки, label = "Полки", icon = "shelves")),
    models = listOf(Полка, Книга),
    views = listOf(Строка, Карточка, Полки),
    title = "Полки",
)

/**
 * Две вещи, которые нужны всем и не передаются вниз по одной.
 *
 * `AppContext` -- то, что не меняется за жизнь приложения: сам Framework7,
 * отправка события, склад состояния. `ScreenContext` -- к какому разделу
 * принадлежит вид, в котором рисуется страница.
 *
 * Второй нужен потому, что страницу создаёт маршрутизатор Framework7, а не
 * React: компонент страницы приезжает параметром маршрута и по дереву React
 * оказывается внутри своего `View` -- значит, узнать раздел он может у
 * контекста, но не у родителя, которого в его собственном коде нет.
 */
import { createContext, useContext } from "react";

export const AppContext = createContext(null);
export const ScreenContext = createContext("");

export const useApp = () => useContext(AppContext);
export const useScreenKey = () => useContext(ScreenContext);

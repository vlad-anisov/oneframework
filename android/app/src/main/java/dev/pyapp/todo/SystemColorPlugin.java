package dev.pyapp.todo;

import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Цвет системы -- то, чего веб не отдаёт.
 *
 * Замерено и записано в docs/probe-system-color.md: живой Safari при красном
 * акценте отдаёт постоянное синее, а Chrome не знает ключа `AccentColor`
 * вовсе. Material You выставлен только родному коду -- палитрой ресурсов
 * `system_accent1_*`, начиная с Android 12 (API 31).
 *
 * Отдаётся строкой `#RRGGBB`, потому что дальше её ждёт Framework7: он строит
 * из семени всю тональную палитру сам.
 */
@CapacitorPlugin(name = "SystemColor")
public class SystemColorPlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        JSObject out = new JSObject();
        String color = read();
        out.put("color", color);
        Log.i("oneframework", "system accent: " + color);
        call.resolve(out);
    }

    /** `null` -- система цвета не даёт: до Android 12 его просто нет. */
    private String read() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null;
        int value = getContext().getColor(android.R.color.system_accent1_500);
        return String.format("#%06X", 0xFFFFFF & value);
    }
}

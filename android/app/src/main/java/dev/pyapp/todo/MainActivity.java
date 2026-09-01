package dev.pyapp.todo;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // До `super`: там заводится мост, и плагин должен быть уже объявлен.
        registerPlugin(SystemColorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

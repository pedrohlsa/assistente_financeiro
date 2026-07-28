package com.assistfin.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RideOverlayPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

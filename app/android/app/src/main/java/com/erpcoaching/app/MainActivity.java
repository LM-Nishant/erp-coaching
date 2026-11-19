package com.erpcoaching.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The app's own plugins; they must be registered before the bridge starts.
        registerPlugin(PaymentCheckoutPlugin.class);
        registerPlugin(PushConfigPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

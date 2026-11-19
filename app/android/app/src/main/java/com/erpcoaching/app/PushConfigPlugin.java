package com.erpcoaching.app;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the web app whether Firebase is built in: the google-services plugin turns google-services.json into the
 * google_app_id resource. Without it PushNotifications.register() crashes the app, so notifications/push.ts asks first.
 */
@CapacitorPlugin(name = "PushConfig")
public class PushConfigPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        Context context = getContext();
        int appId = context.getResources().getIdentifier("google_app_id", "string", context.getPackageName());
        JSObject result = new JSObject();
        result.put("configured", appId != 0);
        call.resolve(result);
    }
}

package com.erpcoaching.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Keeps a payment gateway's checkout inside the app while it is open, and hands UPI payments to the payer's UPI apps.
 * See core/payment-checkout.ts.
 *
 * Capacitor opens pages outside the app in the browser. Between begin() and the return to the app (at most 30 minutes)
 * the gateway's pages stay in the WebView, so the gateway's redirect brings the payer back to the app. intent: links
 * (UPI apps) are started as Android intents; upi: links already open through Capacitor's default handling. Capacitor's
 * bridge only serves the app's own origin, so the gateway's pages get no native access.
 */
@CapacitorPlugin(name = "PaymentCheckout")
public class PaymentCheckoutPlugin extends Plugin {

    private static final String TAG = "PaymentCheckout";
    private static final long MAX_ACTIVE_MS = 30 * 60 * 1000L;
    /** Schemes a gateway page may not open through openUpiApp: pages, intents and local content. */
    private static final Set<String> NOT_APP_SCHEMES = new HashSet<>(
        Arrays.asList("http", "https", "intent", "file", "content", "javascript", "data", "blob", "about")
    );
    private static final int GRANT_FLAGS =
        Intent.FLAG_GRANT_READ_URI_PERMISSION |
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
        Intent.FLAG_GRANT_PREFIX_URI_PERMISSION;

    /** elapsedRealtime() when the checkout opened; 0 when none is open. */
    private volatile long activeSince = 0;

    @Override
    public void load() {
        // Paytm's checkout opens UPI apps from a WebView through window.checkoutUpiIntent.openUpiApp(url).
        getBridge().getWebView().addJavascriptInterface(new UpiIntentInterface(this), "checkoutUpiIntent");
    }

    @PluginMethod
    public void begin(PluginCall call) {
        activeSince = SystemClock.elapsedRealtime();
        call.resolve();
    }

    @PluginMethod
    public void end(PluginCall call) {
        activeSince = 0;
        call.resolve();
    }

    boolean isActive() {
        long since = activeSince;
        if (since == 0) return false;
        if (SystemClock.elapsedRealtime() - since > MAX_ACTIVE_MS) {
            activeSince = 0;
            return false;
        }
        return true;
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (!isActive()) return null;
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
        if (scheme.equals("http") || scheme.equals("https")) {
            Uri app = Uri.parse(getBridge().getAppUrl());
            if (scheme.equals(app.getScheme()) && url.getHost() != null && url.getHost().equalsIgnoreCase(app.getHost())) {
                // Back in the app.
                activeSince = 0;
                return null;
            }
            return false;
        }
        if (scheme.equals("intent")) {
            startIntentLink(url.toString());
            return true;
        }
        return null;
    }

    /** Starts an intent: link the way Chrome does: only browsable activities, no explicit component or URI grants. */
    private void startIntentLink(String link) {
        Intent intent;
        try {
            intent = Intent.parseUri(link, Intent.URI_INTENT_SCHEME);
        } catch (URISyntaxException e) {
            Logger.warn(TAG, "Ignored a malformed intent: link");
            return;
        }
        String fallback = intent.getStringExtra("browser_fallback_url");
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setComponent(null);
        intent.setSelector(null);
        intent.setFlags(intent.getFlags() & ~GRANT_FLAGS);
        try {
            getActivity().startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Uri page = fallback == null ? null : Uri.parse(fallback);
            if (page == null || !"https".equalsIgnoreCase(page.getScheme())) return;
            try {
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, page).addCategory(Intent.CATEGORY_BROWSABLE));
            } catch (ActivityNotFoundException ignored) {
                // No browser either.
            }
        } catch (SecurityException e) {
            Logger.warn(TAG, "An intent: link was refused by Android");
        }
    }

    /** Exposed to the WebView's pages, so it only acts while a checkout is open. */
    public static final class UpiIntentInterface {

        private final PaymentCheckoutPlugin plugin;

        UpiIntentInterface(PaymentCheckoutPlugin plugin) {
            this.plugin = plugin;
        }

        @JavascriptInterface
        public boolean openUpiApp(String url) {
            if (url == null || !plugin.isActive()) return false;
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            if (scheme == null || NOT_APP_SCHEMES.contains(scheme.toLowerCase(Locale.ROOT))) return false;
            Intent intent = new Intent(Intent.ACTION_VIEW, uri)
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                plugin.getContext().startActivity(intent);
                return true;
            } catch (ActivityNotFoundException | SecurityException e) {
                return false;
            }
        }
    }
}

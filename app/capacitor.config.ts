import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.erpcoaching.app',
  appName: 'ERP Coaching',
  webDir: 'dist',
  server: {
    // Lets the WebView call a plain-http dev API (e.g. http://10.0.2.2:4000). Use HTTPS in production.
    androidScheme: 'https',
    cleartext: process.env.NODE_ENV !== 'production',
  },
  android: {
    // Dev only: the https WebView origin may call a plain-http LAN API.
    allowMixedContent: process.env.NODE_ENV !== 'production',
  },
  plugins: {
    SplashScreen: { launchShowDuration: 800 },
  },
};

export default config;

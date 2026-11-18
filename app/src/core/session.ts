import { watch } from 'vue';
import type { Router } from 'vue-router';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { api, sessionEnded, setSessionExpiredHandler } from './api';
import { idleMonitor } from './idle';
import { wipeUserData } from './modules';
import { sessionEndReason, useAuthStore } from '@/stores/auth';

/**
 * Session lifecycle (spec 4.18):
 *
 * - The API ends the session with 401 `SESSION_IDLE` / `SESSION_REVOKED` / `ACCOUNT_INACTIVE` (or an unusable refresh
 *   token). The app then locks (biometric unlock set up) or returns to the login page.
 * - A revoked device or deactivated account also loses the user's offline content (each module's `wipeUserData`), the
 *   biometric credential and the cached profile.
 * - Inactivity: the institute's timeout is enforced by the idle monitor here and by the API.
 * - When the app returns to the foreground the timeout is checked first, then the session is revalidated, so a device
 *   revoked while the app was in the background is wiped as soon as it is back online.
 */
export function installSession(router: Router) {
  const auth = useAuthStore();

  setSessionExpiredHandler(async (code) => {
    idleMonitor.stop();
    const reason = sessionEndReason(code);
    const userId = await auth.endSession(reason);
    if (reason === 'revoked' || reason === 'inactive') await wipeUserData(userId);
    // During start-up the router guard redirects once auth.init() has finished (it waits for this handler).
    const route = router.currentRoute.value;
    if (!auth.ready || route.meta.public) return;
    // Not awaited: a pending navigation may be waiting for this handler.
    void router.replace({ name: auth.canUnlock ? 'unlock' : 'login', query: { redirect: route.fullPath } });
  });

  idleMonitor.configure({
    timeoutMinutes: () => auth.idleTimeoutMinutes,
    onIdle: () => void sessionEnded('SESSION_IDLE'),
    heartbeat: () => api.post('/auth/activity'),
  });

  // Sync: `ready` tells a sign-in or unlock (the clock restarts) from the session restored at start-up (time spent
  // closed counts as inactivity).
  watch(
    () => auth.me?.user.id ?? null,
    (id) => (id ? idleMonitor.start({ fresh: auth.ready }) : idleMonitor.stop()),
    { flush: 'sync' },
  );

  const resumed = () => {
    if (!auth.me || idleMonitor.check()) return;
    void auth.revalidate();
  };
  if (Capacitor.isNativePlatform()) {
    void App.addListener('appStateChange', ({ isActive }) => isActive && resumed());
  } else {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && auth.me) idleMonitor.check();
    });
  }
  window.addEventListener('online', () => auth.offline && resumed());
}

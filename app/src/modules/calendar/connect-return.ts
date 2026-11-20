import { onBeforeUnmount, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { toast } from '@/core/toast';
import { connectResultMessage } from './api';

/**
 * Picks up the end of the consent flow. The web app comes back from Google with `?calendar=<result>`,
 * shown once and then dropped from the URL. The mobile app is resumed from the system browser, so it
 * reloads whenever it becomes active again.
 */
export function useConnectReturn(reload: () => unknown) {
  const route = useRoute();
  const router = useRouter();
  let handle: PluginListenerHandle | null = null;
  let unmounted = false;

  onMounted(async () => {
    if (route.query.calendar !== undefined) {
      const message = connectResultMessage(route.query.calendar);
      const query = { ...route.query };
      delete query.calendar;
      await router.replace({ query });
      if (message) await toast(...message);
    }
    if (!Capacitor.isNativePlatform()) return;
    const h = await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void reload();
    });
    if (unmounted) void h.remove();
    else handle = h;
  });

  onBeforeUnmount(() => {
    unmounted = true;
    void handle?.remove();
  });
}

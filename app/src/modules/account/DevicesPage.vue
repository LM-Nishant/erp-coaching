<template>
  <AppPage :title="t('account.devices.title')" :on-refresh="load">
    <p class="muted">{{ t('account.devices.intro') }}</p>

    <ion-list v-if="bio.available && auth.me?.session" inset>
      <ion-item>
        <ion-toggle
          :key="toggleKey"
          :checked="biometricOn"
          :disabled="busy"
          @ion-change="toggleBiometric($event.detail.checked)"
        >
          <ion-label>
            {{ t('account.devices.unlockWith', { method: bio.label }) }}
            <p>{{ t('account.devices.unlockHint', { method: bio.label }) }}</p>
          </ion-label>
        </ion-toggle>
      </ion-item>
    </ion-list>

    <ion-list>
      <ion-item v-for="d in devices" :key="d.id">
        <ion-icon slot="start" :icon="d.platform === 'web' ? desktopOutline : phonePortraitOutline" />
        <ion-label>
          <h2>
            {{ d.name ?? d.platform ?? t('account.devices.device') }}
            <ion-badge v-if="d.current" color="success">{{ t('account.devices.thisDevice') }}</ion-badge>
          </h2>
          <p>
            {{
              t(d.status === 'active' ? 'account.devices.signedInSeen' : 'account.devices.signedOutSeen', {
                when: formatDateTime(d.lastSeenAt),
              })
            }}<template v-if="d.biometricUnlock && d.status === 'active'">{{
              t('account.devices.biometricOn')
            }}</template>
          </p>
        </ion-label>
        <ion-button
          v-if="!d.current && d.status === 'active'"
          slot="end"
          fill="clear"
          color="danger"
          @click="revoke(d)"
          >{{ t('account.devices.signOut') }}</ion-button
        >
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  alertController,
  IonBadge,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonToggle,
} from '@ionic/vue';
import { desktopOutline, phonePortraitOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { DeviceDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { api } from '@/core/api';
import { BiometricError, biometricAvailability } from '@/core/biometric';
import { formatDateTime } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const auth = useAuthStore();
const devices = ref<DeviceDto[]>([]);
const bio = reactive({ available: false, label: '' });
const busy = ref(false);
const toggleKey = ref(0);
const biometricOn = computed(() => !!auth.me && auth.biometric?.userId === auth.me.user.id);

async function load() {
  devices.value = await api.get<DeviceDto[]>('/auth/devices');
}

async function revoke(d: DeviceDto) {
  const alert = await alertController.create({
    header: t('account.devices.confirmTitle'),
    message: t('account.devices.confirmMessage', { name: d.name ?? t('account.devices.theDevice') }),
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      { text: t('account.devices.signOut'), role: 'destructive' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'destructive') return;
  try {
    await api.delete(`/auth/devices/${d.id}`);
    await toast(t('account.devices.signedOut'));
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function toggleBiometric(on: boolean) {
  if (on === biometricOn.value) return;
  busy.value = true;
  try {
    if (on) await auth.enableBiometric();
    else await auth.disableBiometric();
    await toast(t(on ? 'account.devices.unlockOn' : 'account.devices.unlockOff', { method: bio.label }));
    await load();
  } catch (e) {
    if (!(e instanceof BiometricError && e.reason === 'cancelled')) await toastError(e);
  } finally {
    busy.value = false;
    // The toggle flips itself; re-render it so it shows the real state after a failure.
    toggleKey.value++;
  }
}

onMounted(async () => {
  Object.assign(bio, await biometricAvailability());
  await load().catch(toastError);
});
</script>

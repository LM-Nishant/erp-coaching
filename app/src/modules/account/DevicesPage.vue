<template>
  <AppPage title="My devices" :on-refresh="load">
    <p class="muted">
      Signing in on a new device requires an OTP, and you can be signed in on a limited number of devices at a
      time. Sign out of devices you no longer use; their downloaded lectures are removed.
    </p>

    <ion-list v-if="bio.available && auth.me?.session" inset>
      <ion-item>
        <ion-toggle
          :key="toggleKey"
          :checked="biometricOn"
          :disabled="busy"
          @ion-change="toggleBiometric($event.detail.checked)"
        >
          <ion-label>
            Unlock with {{ bio.label }}
            <p>Use {{ bio.label }} instead of your password when the app is locked on this device.</p>
          </ion-label>
        </ion-toggle>
      </ion-item>
    </ion-list>

    <ion-list>
      <ion-item v-for="d in devices" :key="d.id">
        <ion-icon slot="start" :icon="d.platform === 'web' ? desktopOutline : phonePortraitOutline" />
        <ion-label>
          <h2>
            {{ d.name ?? d.platform ?? 'Device' }}
            <ion-badge v-if="d.current" color="success">This device</ion-badge>
          </h2>
          <p>
            {{ d.status === 'active' ? 'Signed in' : 'Signed out' }} · last seen
            {{ d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—'
            }}<template v-if="d.biometricUnlock && d.status === 'active'"> · biometric unlock on</template>
          </p>
        </ion-label>
        <ion-button
          v-if="!d.current && d.status === 'active'"
          slot="end"
          fill="clear"
          color="danger"
          @click="revoke(d)"
          >Sign out</ion-button
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
import type { DeviceDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { api } from '@/core/api';
import { BiometricError, biometricAvailability } from '@/core/biometric';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';

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
    header: 'Sign out this device?',
    message: `${d.name ?? 'The device'} will be signed out at once and its downloaded lectures removed.`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Sign out', role: 'destructive' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'destructive') return;
  try {
    await api.delete(`/auth/devices/${d.id}`);
    await toast('Device signed out');
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
    await toast(on ? `${bio.label} unlock is on` : `${bio.label} unlock is off`);
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

<template>
  <ion-modal :is-open="!!user" @did-dismiss="emit('close')">
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ user?.name }}</ion-title>
        <ion-buttons slot="end"><ion-button @click="emit('close')">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <p class="muted">
        {{ user?.mobile }} · Signing a device out ends its session at once, turns off biometric unlock and
        deletes its downloaded lectures. The user is notified and needs an OTP to sign in on that device
        again.
      </p>
      <ion-list>
        <ion-item v-for="d in devices" :key="d.id">
          <ion-icon slot="start" :icon="d.platform === 'web' ? desktopOutline : phonePortraitOutline" />
          <ion-label>
            <h2>{{ d.name ?? d.platform ?? 'Device' }}</h2>
            <p>{{ describe(d) }}</p>
          </ion-label>
          <ion-button
            v-if="canRevoke && d.status === 'active'"
            slot="end"
            fill="clear"
            color="danger"
            :disabled="busy"
            @click="revoke(d)"
            >Sign out</ion-button
          >
        </ion-item>
        <ion-item v-if="loaded && !devices.length"
          ><ion-label class="muted">Not signed in on any device yet.</ion-label></ion-item
        >
      </ion-list>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  alertController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { desktopOutline, phonePortraitOutline } from 'ionicons/icons';
import type { DeviceDto } from '@erp/shared';
import { api } from '@/core/api';
import { toast, toastError } from '@/core/toast';

/**
 * A member's sign-in devices for administrators (spec 4.18). `basePath` is the user resource: `/users/:id` for
 * institute and branch admins, `/admin/users/:id` for the super admin.
 */
const props = defineProps<{
  user: { id: number; name: string; mobile: string } | null;
  basePath: string;
  canRevoke: boolean;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();

const devices = ref<DeviceDto[]>([]);
const loaded = ref(false);
const busy = ref(false);

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
function describe(d: DeviceDto) {
  if (d.status !== 'active') return `Signed out ${when(d.revokedAt)}`;
  return `Signed in · last seen ${when(d.lastSeenAt)}${d.biometricUnlock ? ' · biometric unlock on' : ''}`;
}

async function load() {
  if (!props.user) return;
  loaded.value = false;
  devices.value = [];
  try {
    devices.value = await api.get<DeviceDto[]>(`${props.basePath}/${props.user.id}/devices`);
    loaded.value = true;
  } catch (e) {
    await toastError(e);
  }
}

async function revoke(d: DeviceDto) {
  const user = props.user;
  if (!user) return;
  const alert = await alertController.create({
    header: 'Sign out this device?',
    message: `${user.name} will be signed out of ${d.name ?? 'the device'} at once.`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Sign out', role: 'destructive' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'destructive') return;
  busy.value = true;
  try {
    await api.delete(`${props.basePath}/${user.id}/devices/${d.id}`);
    await toast('Device signed out');
    emit('changed');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

watch(() => props.user?.id, load, { immediate: true });
</script>

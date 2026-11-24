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
      <ion-item v-if="locked" lines="none" color="warning">
        <ion-icon slot="start" :icon="lockClosedOutline" />
        <ion-label class="ion-text-wrap">
          <h2>Sign-in locked</h2>
          <p>Too many failed sign-in attempts. Locked until {{ when(lockedUntil) }}.</p>
        </ion-label>
        <ion-button v-if="canRevoke" slot="end" fill="clear" :disabled="busy" @click="unlock"
          >Unlock sign-in</ion-button
        >
      </ion-item>
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
import { formatDateTime } from '@/core/format';
import { computed, ref, watch } from 'vue';
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
import { desktopOutline, lockClosedOutline, phonePortraitOutline } from 'ionicons/icons';
import type { DeviceDto } from '@erp/shared';
import { api, ApiError } from '@/core/api';
import { toast, toastError } from '@/core/toast';

/**
 * A member's sign-in devices for administrators (spec 4.18). `basePath` is the user resource: `/users/:id` for
 * institute and branch admins, `/admin/users/:id` for the super admin. Also shows and ends a sign-in lock
 * after repeated failed attempts.
 */
const props = defineProps<{
  user: { id: number; name: string; mobile: string; signInLockedUntil?: string | null } | null;
  basePath: string;
  canRevoke: boolean;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();

const devices = ref<DeviceDto[]>([]);

/** The member left the caller's branch scope (403) or is gone (404): close and let the list refresh. */
function outOfScope(e: unknown) {
  if (!(e instanceof ApiError) || (e.status !== 403 && e.status !== 404)) return false;
  emit('changed');
  emit('close');
  return true;
}
const loaded = ref(false);
const busy = ref(false);
const lockedUntil = ref<string | null>(null);
const locked = computed(() => !!lockedUntil.value && new Date(lockedUntil.value).getTime() > Date.now());

const when = (iso: string | null) => (iso ? formatDateTime(iso) : '—');
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
    outOfScope(e);
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
    outOfScope(e);
  } finally {
    busy.value = false;
  }
}

async function unlock() {
  const user = props.user;
  if (!user) return;
  busy.value = true;
  try {
    await api.delete(`${props.basePath}/${user.id}/sign-in-lock`);
    lockedUntil.value = null;
    await toast('Sign-in unlocked');
    emit('changed');
  } catch (e) {
    await toastError(e);
    outOfScope(e);
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.user,
  (u) => (lockedUntil.value = u?.signInLockedUntil ?? null),
  { immediate: true },
);
watch(() => props.user?.id, load, { immediate: true });
</script>

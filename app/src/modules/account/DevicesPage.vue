<template>
  <AppPage title="My devices" :on-refresh="load">
    <p class="muted">You can be signed in on up to 2 devices. Signing in on a new device requires an OTP.</p>
    <ion-list>
      <ion-item v-for="d in devices" :key="d.id">
        <ion-icon slot="start" :icon="d.platform === 'web' ? desktopOutline : phonePortraitOutline" />
        <ion-label>
          <h2>
            {{ d.name ?? d.platform }} <ion-badge v-if="d.current" color="success">This device</ion-badge>
          </h2>
          <p>{{ d.status }} · last seen {{ d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—' }}</p>
        </ion-label>
        <ion-button
          v-if="!d.current && d.status === 'active'"
          slot="end"
          fill="clear"
          color="danger"
          @click="revoke(d.id)"
          >Sign out</ion-button
        >
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonBadge, IonButton, IonIcon, IonItem, IonLabel, IonList } from '@ionic/vue';
import { desktopOutline, phonePortraitOutline } from 'ionicons/icons';
import AppPage from '@/components/AppPage.vue';
import { api } from '@/core/api';
import { toast, toastError } from '@/core/toast';

interface DeviceRow {
  id: number;
  name: string | null;
  platform: string;
  status: string;
  lastSeenAt: string | null;
  current: boolean;
}

const devices = ref<DeviceRow[]>([]);

async function load() {
  devices.value = await api.get<DeviceRow[]>('/auth/devices');
}

async function revoke(id: number) {
  try {
    await api.delete(`/auth/devices/${id}`);
    await toast('Device signed out');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(() => load().catch(toastError));
</script>

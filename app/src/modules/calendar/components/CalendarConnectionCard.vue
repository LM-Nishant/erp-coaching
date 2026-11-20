<template>
  <ion-list v-if="data && data.provider === 'google' && data.configured">
    <ion-list-header><ion-label>Google Calendar</ion-label></ion-list-header>
    <ion-item v-if="!conn">
      <ion-icon slot="start" :icon="calendarOutline" color="medium" aria-hidden="true" />
      <ion-label class="ion-text-wrap">
        <h2>Not connected</h2>
        <p>
          Connect your Google Calendar to get the meetings you accept in it, with a Google Meet link for
          online meetings and the parent invited.
        </p>
        <p v-if="data.organiserConnected" class="muted">
          Until then they go to your institute's Google Calendar, with you invited.
        </p>
        <p v-else class="muted">Your institute hasn't connected a Google Calendar either.</p>
      </ion-label>
    </ion-item>
    <ion-item v-else>
      <ion-icon
        slot="start"
        :icon="active ? checkmarkCircleOutline : warningOutline"
        :color="active ? 'success' : 'warning'"
        aria-hidden="true"
      />
      <ion-label class="ion-text-wrap">
        <h2>{{ connectionLabel(conn) }}</h2>
        <p v-if="!active">
          Google access was removed or has expired. Reconnect to keep your meetings in your calendar.
        </p>
        <p v-if="conn.lastError" class="muted">{{ conn.lastError }}</p>
      </ion-label>
    </ion-item>
    <div class="actions">
      <ion-button v-if="!conn || !active" size="small" :disabled="busy" @click="connect">
        {{ conn ? 'Reconnect' : 'Connect Google Calendar' }}
      </ion-button>
      <ion-button v-if="conn && active" size="small" fill="outline" :disabled="busy" @click="test">
        Test connection
      </ion-button>
      <ion-button v-if="conn" size="small" fill="outline" color="danger" :disabled="busy" @click="disconnect">
        Disconnect
      </ion-button>
    </div>
  </ion-list>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonButton, IonIcon, IonItem, IonLabel, IonList, IonListHeader, alertController } from '@ionic/vue';
import { calendarOutline, checkmarkCircleOutline, warningOutline } from 'ionicons/icons';
import type { MyCalendarDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { calendarApi, connectionLabel, openConsent } from '../api';
import { useConnectReturn } from '../connect-return';

/** A teacher's own Google Calendar. Hidden while the platform uses the test (mock) calendar. */
const data = ref<MyCalendarDto | null>(null);
const busy = ref(false);
const conn = computed(() => data.value?.connection ?? null);
const active = computed(() => conn.value?.status === 'active');

let inflight: Promise<void> | null = null;
/** Concurrent calls share one request (the page reloads the card while it mounts). */
function load(): Promise<void> {
  inflight ??= (async () => {
    try {
      data.value = await calendarApi.mine();
    } catch (e) {
      await toastError(e);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function run(action: () => Promise<unknown>) {
  busy.value = true;
  try {
    await action();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

const connect = () => run(async () => openConsent(await calendarApi.connectMine()));

const test = () =>
  run(async () => {
    const r = await calendarApi.testMine();
    await toast(r.message, r.ok ? 'success' : 'danger');
    await load();
  });

async function disconnect() {
  const a = await alertController.create({
    header: 'Disconnect Google Calendar?',
    message:
      'Meetings already in your calendar stay there. New and changed meetings go to the institute calendar, if it is connected.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Disconnect', role: 'confirm' },
    ],
  });
  await a.present();
  if ((await a.onDidDismiss()).role !== 'confirm') return;
  await run(async () => {
    await calendarApi.disconnectMine();
    await toast('Google Calendar disconnected');
    await load();
  });
}

onMounted(load);
useConnectReturn(load);
defineExpose({ load });
</script>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 16px 12px;
}
</style>

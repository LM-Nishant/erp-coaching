<template>
  <AppPage title="Calendar sync" :on-refresh="load">
    <div v-if="!data" class="center"><ion-spinner /></div>
    <template v-else>
      <p v-if="data.provider !== 'google' || !data.configured" class="muted hint">
        Google Calendar is turned off on this platform, so meetings are kept in the app only (a test
        calendar). Your platform administrator can turn it on.
      </p>
      <template v-else>
        <p class="muted hint">
          Confirmed parent-teacher meetings are added to Google Calendar, with a Google Meet link for online
          meetings and the teacher and parent invited. Changes and cancellations made in the app update the
          event. Teachers can connect their own calendar from My availability; meetings of the other teachers
          go to the institute calendar below.
        </p>

        <ion-list>
          <ion-list-header><ion-label>Institute calendar</ion-label></ion-list-header>
          <ion-item>
            <ion-icon
              slot="start"
              :icon="
                !org ? calendarOutline : org.status === 'active' ? checkmarkCircleOutline : warningOutline
              "
              :color="!org ? 'medium' : org.status === 'active' ? 'success' : 'warning'"
              aria-hidden="true"
            />
            <ion-label class="ion-text-wrap">
              <h2>{{ org ? connectionLabel(org) : 'Not connected' }}</h2>
              <p v-if="!org">
                Connect a Google account (for example a shared office account) to hold the meetings of
                teachers who haven't connected their own calendar.
              </p>
              <p v-else-if="org.status !== 'active'">
                Google access was removed or has expired. Reconnect to keep meetings in sync.
              </p>
              <p v-if="org?.connectedBy" class="muted">Connected by {{ org.connectedBy.name }}</p>
              <p v-if="org?.lastError" class="muted">{{ org.lastError }}</p>
            </ion-label>
          </ion-item>
          <div class="actions">
            <ion-button v-if="!org || org.status !== 'active'" size="small" :disabled="busy" @click="connect">
              {{ org ? 'Reconnect' : 'Connect Google Calendar' }}
            </ion-button>
            <ion-button
              v-if="org && org.status === 'active'"
              size="small"
              fill="outline"
              :disabled="busy"
              @click="test(org)"
            >
              Test connection
            </ion-button>
            <ion-button
              v-if="org"
              size="small"
              fill="outline"
              color="danger"
              :disabled="busy"
              @click="disconnect(org)"
            >
              Disconnect
            </ion-button>
          </div>
        </ion-list>

        <ion-list>
          <ion-list-header><ion-label>Teachers' calendars</ion-label></ion-list-header>
          <ion-item v-for="c in data.teachers" :key="c.id">
            <ion-label class="ion-text-wrap">
              <h2>{{ c.userName ?? `User #${c.userId}` }}</h2>
              <p :class="{ warn: c.status !== 'active' }">{{ connectionLabel(c) }}</p>
              <p v-if="c.lastError" class="muted">{{ c.lastError }}</p>
            </ion-label>
            <ion-button
              slot="end"
              fill="clear"
              :disabled="busy"
              :aria-label="`Test ${c.userName ?? 'teacher'}'s calendar`"
              @click="test(c)"
            >
              <ion-icon slot="icon-only" :icon="pulseOutline" />
            </ion-button>
            <ion-button
              slot="end"
              fill="clear"
              color="danger"
              :disabled="busy"
              :aria-label="`Disconnect ${c.userName ?? 'teacher'}'s calendar`"
              @click="disconnect(c)"
            >
              <ion-icon slot="icon-only" :icon="unlinkOutline" />
            </ion-button>
          </ion-item>
          <ion-item v-if="!data.teachers.length">
            <ion-label class="muted ion-text-wrap">No teacher has connected their own calendar.</ion-label>
          </ion-item>
        </ion-list>

        <ion-list v-if="syncTotal">
          <ion-list-header><ion-label>Upcoming meetings</ion-label></ion-list-header>
          <ion-item>
            <ion-label>In Google Calendar</ion-label>
            <ion-note slot="end">{{ data.sync.synced }}</ion-note>
          </ion-item>
          <ion-item>
            <ion-label class="ion-text-wrap">Waiting to sync (retried automatically)</ion-label>
            <ion-note slot="end">{{ data.sync.pending }}</ion-note>
          </ion-item>
          <ion-item>
            <ion-label class="ion-text-wrap">
              Not in Google Calendar
              <p>Open a meeting to see why. Connecting a calendar adds its upcoming meetings.</p>
            </ion-label>
            <ion-note slot="end" :color="data.sync.failed ? 'warning' : undefined">{{
              data.sync.failed
            }}</ion-note>
          </ion-item>
        </ion-list>
      </template>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSpinner,
  alertController,
  onIonViewWillEnter,
} from '@ionic/vue';
import {
  calendarOutline,
  checkmarkCircleOutline,
  pulseOutline,
  unlinkOutline,
  warningOutline,
} from 'ionicons/icons';
import type { CalendarConnectionDto, CalendarSettingsDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { calendarApi, connectionLabel, openConsent } from './api';
import { useConnectReturn } from './connect-return';

const data = ref<CalendarSettingsDto | null>(null);
const busy = ref(false);
const org = computed(() => data.value?.organiser ?? null);
const syncTotal = computed(() => {
  const s = data.value?.sync;
  return s ? s.synced + s.pending + s.failed : 0;
});

async function load() {
  try {
    data.value = await calendarApi.settings();
  } catch (e) {
    await toastError(e);
  }
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

const connect = () => run(async () => openConsent(await calendarApi.connectOrganiser()));

const test = (c: CalendarConnectionDto) =>
  run(async () => {
    const r = await calendarApi.test(c.id);
    await toast(r.message, r.ok ? 'success' : 'danger');
    await load();
  });

async function disconnect(c: CalendarConnectionDto) {
  const whose = c.userId === null ? 'the institute calendar' : `${c.userName ?? 'this teacher'}'s calendar`;
  const a = await alertController.create({
    header: 'Disconnect Google Calendar?',
    message: `This removes the app's access to ${whose}. Meetings already in it stay there; new and changed meetings go to the calendar that is connected then.`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Disconnect', role: 'confirm' },
    ],
  });
  await a.present();
  if ((await a.onDidDismiss()).role !== 'confirm') return;
  await run(async () => {
    await calendarApi.disconnect(c.id);
    await toast('Google Calendar disconnected');
    await load();
  });
}

onIonViewWillEnter(load);
useConnectReturn(load);
</script>

<style scoped>
.hint {
  font-size: 13px;
  margin: 12px 16px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 16px 12px;
}
.warn {
  color: var(--ion-color-warning-shade);
}
.center {
  display: flex;
  justify-content: center;
  padding: 32px;
}
</style>

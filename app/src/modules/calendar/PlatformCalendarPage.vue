<template>
  <AppPage title="Google Calendar" :on-refresh="load">
    <div v-if="!data" class="center"><ion-spinner /></div>
    <ion-card v-else>
      <ion-card-header>
        <ion-card-title>Google OAuth client</ion-card-title>
        <div>
          <ion-badge :color="data.configured ? 'success' : 'medium'">{{
            data.configured ? 'Google Calendar on' : 'Test calendar (CALENDAR_PROVIDER=mock)'
          }}</ion-badge>
        </div>
      </ion-card-header>
      <ion-card-content>
        <ion-list>
          <ion-item>
            <ion-label class="ion-text-wrap">
              <p>Client ID</p>
              <h3 class="mono">{{ data.clientId ?? 'Not set' }}</h3>
            </ion-label>
          </ion-item>
          <ion-item>
            <ion-label class="ion-text-wrap">
              <p>Authorised redirect URI (register exactly this in Google Cloud)</p>
              <h3 class="mono">{{ data.redirectUri }}</h3>
            </ion-label>
            <ion-button
              slot="end"
              fill="clear"
              aria-label="Copy redirect URI"
              @click="copy(data.redirectUri)"
            >
              <ion-icon slot="icon-only" :icon="copyOutline" />
            </ion-button>
          </ion-item>
          <ion-item>
            <ion-label class="ion-text-wrap">
              <p>Scopes (add them to the OAuth consent screen)</p>
              <h3 v-for="s in data.scopes" :key="s" class="mono">{{ s }}</h3>
            </ion-label>
          </ion-item>
          <ion-item>
            <ion-label>Connected calendars</ion-label>
            <ion-note slot="end">{{ data.connections.active }}</ion-note>
          </ion-item>
          <ion-item>
            <ion-label class="ion-text-wrap">Calendars that need reconnecting</ion-label>
            <ion-note slot="end" :color="data.connections.needsReconnect ? 'warning' : undefined">{{
              data.connections.needsReconnect
            }}</ion-note>
          </ion-item>
        </ion-list>
        <p class="muted note">
          Set <code>CALENDAR_PROVIDER=google</code>, <code>GOOGLE_OAUTH_CLIENT_ID</code> and
          <code>GOOGLE_OAUTH_CLIENT_SECRET</code> in the server environment (the secret never leaves it), then
          register the redirect URI above. Institutes connect their calendars under Calendar sync, and
          teachers under My availability. Setup steps: docs/integrations/google-calendar.md.
        </p>
        <p v-if="result" :class="['note', result.ok ? 'ok' : 'bad']">{{ result.message }}</p>
        <div class="actions">
          <ion-button fill="outline" :disabled="busy" @click="test">Check client</ion-button>
        </div>
      </ion-card-content>
    </ion-card>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
} from '@ionic/vue';
import { copyOutline } from 'ionicons/icons';
import type { CalendarPlatformStatusDto, CalendarTestResultDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { calendarApi } from './api';

const data = ref<CalendarPlatformStatusDto | null>(null);
const result = ref<CalendarTestResultDto | null>(null);
const busy = ref(false);

async function load() {
  try {
    data.value = await calendarApi.platform();
  } catch (e) {
    await toastError(e);
  }
}

async function test() {
  busy.value = true;
  try {
    result.value = await calendarApi.testPlatform();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    await toast('Copied');
  } catch {
    await toast('Copy it from the text above', 'medium');
  }
}

onMounted(load);
</script>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.note {
  font-size: 13px;
  margin: 12px 0;
}
.ok {
  color: var(--ion-color-success-shade);
}
.bad {
  color: var(--ion-color-danger);
}
.actions {
  display: flex;
  justify-content: flex-end;
}
.center {
  display: flex;
  justify-content: center;
  padding: 32px;
}
</style>

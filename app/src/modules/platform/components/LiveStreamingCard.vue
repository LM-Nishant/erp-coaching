<template>
  <ion-card>
    <ion-card-header>
      <ion-card-title>Live classes</ion-card-title>
      <div v-if="dto" class="chip-row">
        <ion-badge color="success">Provider: {{ PROVIDER_LABELS[dto.provider] ?? dto.provider }}</ion-badge>
        <ion-badge color="light">{{
          dto.transport === 'vendor-sdk' ? 'Media server' : 'Peer-to-peer (development)'
        }}</ion-badge>
      </div>
    </ion-card-header>
    <ion-card-content>
      <div v-if="!dto" class="center"><ion-spinner /></div>
      <template v-else>
        <ion-list v-if="settings.length">
          <ion-item v-for="[key, value] in settings" :key="key">
            <ion-label class="ion-text-wrap">
              <p>{{ SETTING_LABELS[key] ?? key }}</p>
              <h3>
                <code>{{ value ?? '—' }}</code>
              </h3>
            </ion-label>
          </ion-item>
        </ion-list>
        <p v-if="dto.transport === 'vendor-sdk'" class="muted note">
          Set on the server with <code>STREAMING_PROVIDER</code> and the <code>LIVEKIT_*</code> settings (see
          docs/integrations/live-streaming.md). Secrets are never shown here.
        </p>
        <p v-else class="muted note">
          The built-in development provider connects browsers to each other through the classroom socket with
          public STUN servers only, so it works on one network but not across most mobile or office networks.
          Set <code>STREAMING_PROVIDER=livekit</code> on the server for production classes.
        </p>
        <p v-if="dto.webhookUrl" class="muted note">
          Webhook URL to configure on the LiveKit server or Cloud project — attendance and recordings come
          from it: <code>{{ dto.webhookUrl }}</code>
          <ion-button size="small" fill="clear" @click="copyWebhook">Copy</ion-button>
          <br />Last verified webhook:
          {{ dto.lastWebhookAt ? new Date(dto.lastWebhookAt).toLocaleString('en-IN') : 'none received yet' }}
        </p>
        <div v-if="result" class="test-result" :class="result.ok ? 'ok' : 'fail'">
          <ion-icon :icon="result.ok ? checkmarkCircle : alertCircle" />
          <span
            >{{ result.ok ? 'Test passed' : 'Test failed' }}: {{ result.message }}
            <span class="muted">({{ new Date(result.testedAt).toLocaleString('en-IN') }})</span></span
          >
        </div>
        <div class="actions">
          <ion-button fill="outline" :disabled="busy" @click="test">Test connection</ion-button>
        </div>
      </template>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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
  IonSpinner,
} from '@ionic/vue';
import { alertCircle, checkmarkCircle } from 'ionicons/icons';
import type { LiveStreamingStatusDto, LiveStreamingTestResultDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { platformApi } from '../api';

const PROVIDER_LABELS: Record<string, string> = { mock: 'Built-in (development)', livekit: 'LiveKit' };
const SETTING_LABELS: Record<string, string> = {
  url: 'Client URL (LIVEKIT_URL)',
  apiUrl: 'Server API URL',
  apiKey: 'API key',
  roomPrefix: 'Room name prefix',
  recordingOutput: 'Recording output',
  recordingLocation: 'Recordings location',
};

const dto = ref<LiveStreamingStatusDto | null>(null);
const result = ref<LiveStreamingTestResultDto | null>(null);
const busy = ref(false);
const settings = computed(() => Object.entries(dto.value?.settings ?? {}));

async function load() {
  try {
    dto.value = await platformApi.liveStreaming();
  } catch (e) {
    await toastError(e);
  }
}

async function test() {
  busy.value = true;
  try {
    result.value = await platformApi.testLiveStreaming();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function copyWebhook() {
  try {
    await navigator.clipboard.writeText(dto.value!.webhookUrl!);
    await toast('Webhook URL copied');
  } catch {
    await toast('Copy failed; select the URL instead', 'warning');
  }
}

onMounted(load);
defineExpose({ load });
</script>

<style scoped>
.chip-row {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.note {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.center {
  display: flex;
  justify-content: center;
  padding: 16px;
}
.test-result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin: 8px 0;
  border-radius: 6px;
  font-size: 14px;
}
.test-result.ok {
  background: rgba(var(--ion-color-success-rgb), 0.12);
  color: var(--ion-color-success-shade);
}
.test-result.fail {
  background: rgba(var(--ion-color-danger-rgb), 0.1);
  color: var(--ion-color-danger);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

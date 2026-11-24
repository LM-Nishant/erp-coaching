<template>
  <ion-card>
    <ion-card-header>
      <ion-card-title>{{ t('platform.tabs.live') }}</ion-card-title>
      <div v-if="dto" class="chip-row">
        <StatusChip
          :label="t('platform.live.provider', { name: providerLabel(dto.provider) })"
          tone="success"
        />
        <StatusChip
          :label="
            dto.transport === 'vendor-sdk' ? t('platform.live.mediaServer') : t('platform.live.peerToPeer')
          "
        />
      </div>
    </ion-card-header>
    <ion-card-content>
      <div v-if="!dto" class="center"><ion-spinner /></div>
      <template v-else>
        <ion-list v-if="settings.length">
          <ion-item v-for="[key, value] in settings" :key="key">
            <ion-label class="ion-text-wrap">
              <p>{{ settingLabel(key) }}</p>
              <h3>
                <code>{{ value ?? '—' }}</code>
              </h3>
            </ion-label>
          </ion-item>
        </ion-list>
        <p v-if="dto.transport === 'vendor-sdk'" class="muted note">{{ t('platform.live.vendorNote') }}</p>
        <p v-else class="muted note">{{ t('platform.live.devNote') }}</p>
        <p v-if="dto.webhookUrl" class="muted note">
          {{ t('platform.live.webhookNote') }} <code>{{ dto.webhookUrl }}</code>
          <ion-button size="small" fill="clear" @click="copyWebhook">{{
            t('common.actions.copy')
          }}</ion-button>
          <br />{{
            t('platform.live.lastWebhook', {
              when: dto.lastWebhookAt ? formatDateTime(dto.lastWebhookAt) : t('platform.live.noWebhook'),
            })
          }}
        </p>
        <div v-if="result" class="test-result" :class="result.ok ? 'ok' : 'fail'">
          <ion-icon :icon="result.ok ? checkmarkCircle : alertCircle" />
          <span
            >{{
              t('platform.test.result', {
                outcome: result.ok ? t('platform.test.passed') : t('platform.test.failed'),
                message: result.message,
              })
            }}
            <span class="muted">({{ formatDateTime(result.testedAt) }})</span></span
          >
        </div>
        <div class="actions">
          <ion-button fill="outline" :disabled="busy" @click="test">{{
            t('platform.test.connection')
          }}</ion-button>
        </div>
      </template>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { platformApi } from '../api';

const { t, te } = useI18n();

const providerLabel = (p: string) =>
  p === 'mock' ? t('platform.live.builtIn') : p === 'livekit' ? 'LiveKit' : p;
const settingLabel = (key: string) =>
  te(`platform.live.settings.${key}`, 'en') ? t(`platform.live.settings.${key}`) : key;

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
    await toast(t('platform.webhookCopied'));
  } catch {
    await toast(t('platform.copyFailed'), 'warning');
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

<template>
  <ion-card>
    <ion-card-header>
      <ion-card-title>{{ label }}</ion-card-title>
      <div class="chip-row">
        <ion-badge :color="dto.enabled ? 'success' : 'medium'">{{
          dto.enabled ? 'Enabled' : 'Disabled'
        }}</ion-badge>
        <ion-badge v-if="dto.isDefault" color="primary">Subscription payments</ion-badge>
        <ion-badge v-if="dto.useForInstitutes" color="tertiary">Institute fallback</ion-badge>
        <ion-badge v-if="dto.updatedAt" color="light">{{ dto.sandbox ? 'Sandbox' : 'Live' }}</ion-badge>
      </div>
    </ion-card-header>
    <ion-card-content>
      <p v-if="isMock" class="muted note">
        Simulated payments for development and testing. It can't be enabled in production.
      </p>
      <ion-list>
        <template v-if="!isMock">
          <p class="muted hint">{{ fields.hint }}</p>
          <ion-item>
            <ion-input
              v-model="form.merchantId"
              :label="fields.merchantId"
              label-placement="stacked"
              autocomplete="off"
              :maxlength="120"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.secretKey"
              :label="fields.secretKey"
              label-placement="stacked"
              type="password"
              autocomplete="off"
              :placeholder="savedSecretHint(dto.hasSecret, dto.keyHint)"
            />
          </ion-item>
          <ion-item v-if="fields.webhookSecret">
            <ion-input
              v-model="form.webhookSecret"
              :label="fields.webhookSecret"
              label-placement="stacked"
              type="password"
              autocomplete="off"
              :placeholder="savedSecretHint(dto.hasWebhookSecret)"
            />
          </ion-item>
          <ion-item v-if="fields.website">
            <ion-input
              v-model="form.website"
              :label="fields.website"
              label-placement="stacked"
              autocomplete="off"
              :maxlength="60"
              placeholder="Blank: WEBSTAGING (test) or DEFAULT (live)"
            />
          </ion-item>
          <ion-item><ion-toggle v-model="form.sandbox">Sandbox (test) mode</ion-toggle></ion-item>
        </template>
        <ion-item>
          <ion-toggle v-model="form.isDefault">Use for SaaS subscription payments</ion-toggle>
        </ion-item>
        <ion-item>
          <ion-toggle v-model="form.useForInstitutes"
            >Offer to institutes without their own fee gateway</ion-toggle
          >
        </ion-item>
        <ion-item><ion-toggle v-model="form.enabled">Enabled</ion-toggle></ion-item>
      </ion-list>
      <div v-if="secretAgain" class="notice warning">
        Sandbox and live use different keys: enter the {{ fields.secretKey?.toLowerCase() }} for
        {{ form.sandbox ? 'sandbox' : 'live' }} mode.
      </div>
      <p class="muted note">
        Subscription payment webhook URL: <code>{{ dto.webhookUrl }}</code>
        <ion-button size="small" fill="clear" aria-label="Copy webhook URL" @click="copyWebhook"
          >Copy</ion-button
        >
      </p>
      <TestStatus :status="dto" :result="result" />
      <div class="actions">
        <ion-button v-if="dto.updatedAt" fill="clear" color="danger" :disabled="busy" @click="remove"
          >Remove</ion-button
        >
        <ion-button fill="outline" :disabled="busy" @click="test">Test connection</ion-button>
        <ion-button :disabled="busy" @click="save">Save</ion-button>
      </div>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonInput,
  IonItem,
  IonList,
  IonToggle,
  alertController,
} from '@ionic/vue';
import type { IntegrationTestResultDto, PaymentGatewayKey, PlatformGatewayDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { GATEWAY_FIELDS, savedSecretHint } from '@/modules/fees/api';
import { GATEWAY_LABELS, platformApi } from '../api';
import TestStatus from './TestStatus.vue';

const props = defineProps<{ dto: PlatformGatewayDto }>();
const emit = defineEmits<{ saved: [] }>();

const label = computed(() => GATEWAY_LABELS[props.dto.gateway as PaymentGatewayKey] ?? props.dto.gateway);
const isMock = computed(() => props.dto.gateway === 'mock');
const fields = computed(() => GATEWAY_FIELDS[props.dto.gateway as PaymentGatewayKey] ?? GATEWAY_FIELDS.mock);

const toForm = (d: PlatformGatewayDto) => ({
  enabled: d.enabled,
  isDefault: d.isDefault,
  useForInstitutes: d.useForInstitutes,
  sandbox: d.sandbox,
  merchantId: d.merchantId ?? '',
  secretKey: '',
  webhookSecret: '',
  website: d.website ?? '',
});

const form = ref(toForm(props.dto));
const result = ref<IntegrationTestResultDto | null>(null);
const busy = ref(false);
// The server refuses to reuse a saved key in the other mode (SECRET_REQUIRED).
const secretAgain = computed(
  () =>
    !isMock.value &&
    props.dto.hasSecret &&
    form.value.sandbox !== props.dto.sandbox &&
    !String(form.value.secretKey ?? '').trim(),
);

// Only this gateway's saved configuration resets the form (other cards keep their edits).
watch(
  () => JSON.stringify(props.dto),
  () => {
    form.value = toForm(props.dto);
    result.value = null;
  },
);

/** Connection fields as typed; blank secrets keep the saved ones. */
const connection = () => ({
  sandbox: form.value.sandbox,
  merchantId: String(form.value.merchantId ?? '').trim() || null,
  secretKey: String(form.value.secretKey ?? '').trim() || undefined,
  webhookSecret: String(form.value.webhookSecret ?? '').trim() || undefined,
  ...(fields.value.website ? { website: String(form.value.website ?? '').trim() || null } : {}),
});

async function test() {
  busy.value = true;
  try {
    result.value = await platformApi.testGateway(props.dto.gateway, connection());
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function save() {
  busy.value = true;
  try {
    await platformApi.saveGateway(props.dto.gateway, {
      ...connection(),
      enabled: form.value.enabled,
      isDefault: form.value.isDefault,
      useForInstitutes: form.value.useForInstitutes,
    });
    await toast(`${label.value} saved`);
    emit('saved');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  const alert = await alertController.create({
    header: `Remove ${label.value}?`,
    message: 'Its saved credentials are deleted and it stops taking payments.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Remove', role: 'destructive' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'destructive') return;
  try {
    await platformApi.removeGateway(props.dto.gateway);
    await toast(`${label.value} removed`);
    emit('saved');
  } catch (e) {
    await toastError(e);
  }
}

async function copyWebhook() {
  try {
    await navigator.clipboard.writeText(props.dto.webhookUrl);
    await toast('Webhook URL copied');
  } catch {
    await toast('Copy failed; select the URL instead', 'warning');
  }
}
</script>

<style scoped>
.chip-row {
  margin-top: 6px;
}
.note {
  font-size: 13px;
  word-break: break-all;
}
.hint {
  font-size: 13px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
</style>

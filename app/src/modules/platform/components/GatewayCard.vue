<template>
  <ion-card>
    <ion-card-header>
      <ion-card-title>{{ label }}</ion-card-title>
      <div class="chip-row">
        <StatusChip
          :label="dto.enabled ? t('platform.status.enabled') : t('platform.status.disabled')"
          :tone="dto.enabled ? 'success' : 'medium'"
        />
        <StatusChip v-if="dto.isDefault" :label="t('platform.gateway.subscriptionPayments')" tone="primary" />
        <StatusChip
          v-if="dto.useForInstitutes"
          :label="t('platform.gateway.instituteFallback')"
          tone="primary"
        />
        <StatusChip
          v-if="dto.updatedAt"
          :label="dto.sandbox ? t('platform.status.sandbox') : t('platform.status.live')"
          :tone="dto.sandbox ? 'warning' : 'medium'"
        />
      </div>
    </ion-card-header>
    <ion-card-content>
      <p v-if="isMock" class="muted note">{{ t('platform.gateway.mockNote') }}</p>
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
              :placeholder="t('platform.gateway.websitePlaceholder')"
            />
          </ion-item>
          <ion-item
            ><ion-toggle v-model="form.sandbox">{{ t('platform.gateway.sandboxMode') }}</ion-toggle></ion-item
          >
        </template>
        <ion-item>
          <ion-toggle v-model="form.isDefault">{{ t('platform.gateway.useForSubscriptions') }}</ion-toggle>
        </ion-item>
        <ion-item>
          <ion-toggle v-model="form.useForInstitutes">{{
            t('platform.gateway.offerToInstitutes')
          }}</ion-toggle>
        </ion-item>
        <ion-item
          ><ion-toggle v-model="form.enabled">{{ t('platform.status.enabled') }}</ion-toggle></ion-item
        >
      </ion-list>
      <div v-if="secretAgain" class="notice warning">
        {{
          t('platform.gateway.secretAgain', {
            field: fields.secretKey?.toLowerCase(),
            mode: form.sandbox ? t('platform.gateway.modeSandbox') : t('platform.gateway.modeLive'),
          })
        }}
      </div>
      <p class="muted note">
        {{ t('platform.gateway.webhookUrl') }} <code>{{ dto.webhookUrl }}</code>
        <ion-button size="small" fill="clear" :aria-label="t('platform.copyWebhook')" @click="copyWebhook">{{
          t('common.actions.copy')
        }}</ion-button>
      </p>
      <TestStatus :status="dto" :result="result" />
      <div class="actions">
        <ion-button v-if="dto.updatedAt" fill="clear" color="danger" :disabled="busy" @click="remove">{{
          t('common.actions.remove')
        }}</ion-button>
        <ion-button fill="outline" :disabled="busy" @click="test">{{
          t('platform.test.connection')
        }}</ion-button>
        <ion-button :disabled="busy" @click="save">{{ t('common.actions.save') }}</ion-button>
      </div>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { toast, toastError } from '@/core/toast';
import { GATEWAY_FIELDS, savedSecretHint } from '@/modules/fees/api';
import { gatewayLabel, platformApi } from '../api';
import TestStatus from './TestStatus.vue';

const props = defineProps<{ dto: PlatformGatewayDto }>();
const emit = defineEmits<{ saved: [] }>();

const { t } = useI18n();
const label = computed(() => gatewayLabel(props.dto.gateway));
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
    await toast(t('platform.saved', { name: label.value }));
    emit('saved');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  const alert = await alertController.create({
    header: t('platform.removeTitle', { name: label.value }),
    message: t('platform.gateway.removeMessage'),
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      { text: t('common.actions.remove'), role: 'destructive' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'destructive') return;
  try {
    await platformApi.removeGateway(props.dto.gateway);
    await toast(t('platform.removed', { name: label.value }));
    emit('saved');
  } catch (e) {
    await toastError(e);
  }
}

async function copyWebhook() {
  try {
    await navigator.clipboard.writeText(props.dto.webhookUrl);
    await toast(t('platform.webhookCopied'));
  } catch {
    await toast(t('platform.copyFailed'), 'warning');
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

<template>
  <AppPage :title="t('admin.ai.title')">
    <div class="title-row">
      <h2><ion-icon :icon="sparkles" color="primary" /> {{ t('admin.ai.provider') }}</h2>
      <div v-if="settings" class="badges">
        <StatusChip v-if="settings.effectiveProvider === 'mock'" :label="t('admin.ai.mock')" tone="warning" />
        <code class="model-badge">{{ settings.effectiveModel }}</code>
      </div>
    </div>

    <div v-if="notice" class="notice" :class="notice.color">
      <ion-icon :icon="notice.color === 'danger' ? alertCircle : informationCircle" />
      <span>{{ notice.text }}</span>
    </div>

    <div v-if="settings" class="ai-card">
      <div class="card-title">{{ t('admin.ai.cardTitle') }}</div>

      <div class="chip-row presets">
        <ion-chip
          v-for="p in presets"
          :key="p.id"
          :outline="form.provider !== p.id"
          :color="form.provider === p.id ? 'primary' : undefined"
          @click="applyPreset(p)"
        >
          {{ p.label }}
        </ion-chip>
      </div>
      <p v-if="presetHint" class="muted hint">{{ presetHint }}</p>

      <div class="grid">
        <ion-input
          v-model="form.baseUrl"
          class="span-wide"
          fill="outline"
          :label="t('admin.ai.baseUrl')"
          label-placement="stacked"
          type="url"
          :readonly="isMock"
          @ion-input="form.provider = 'custom'"
        />
        <ion-input
          v-model="form.model"
          fill="outline"
          :label="t('admin.ai.model')"
          label-placement="stacked"
        />
        <ion-input
          v-if="!isMock"
          v-model="apiKey"
          class="span-wide"
          fill="outline"
          :label="t('admin.ai.apiKey')"
          label-placement="stacked"
          type="password"
          autocomplete="off"
          :placeholder="keyPlaceholder"
        />
        <div class="toggles">
          <ion-toggle v-model="form.jsonMode" label-placement="end">{{ t('admin.ai.jsonMode') }}</ion-toggle>
          <ion-button
            v-if="settings.keySource === 'database'"
            fill="clear"
            color="danger"
            size="small"
            @click="removeKey"
            >{{ t('admin.ai.removeKey') }}</ion-button
          >
        </div>
      </div>

      <div class="grid prices">
        <ion-input
          v-model="prices.input"
          fill="outline"
          :label="t('admin.ai.inputPrice')"
          label-placement="stacked"
          type="number"
          min="0"
          :placeholder="pricePlaceholder('inputUsdPer1M')"
        />
        <ion-input
          v-model="prices.output"
          fill="outline"
          :label="t('admin.ai.outputPrice')"
          label-placement="stacked"
          type="number"
          min="0"
          :placeholder="pricePlaceholder('outputUsdPer1M')"
        />
      </div>

      <p class="muted note">
        <template v-if="isMock">{{ t('admin.ai.mockNote') }}</template>
        <template v-else>
          {{ t('admin.ai.keyNote') }}
          <template v-if="settings.keySource === 'env'"><br />{{ t('admin.ai.envKeyNote') }}</template>
        </template>
        <br />{{ t('admin.ai.priceNote') }}
      </p>

      <div v-if="testResult" class="test-result" :class="testResult.ok ? 'ok' : 'fail'">
        <ion-icon :icon="testResult.ok ? checkmarkCircle : alertCircle" />
        <span
          >{{ testResult.message }}
          <span class="muted">{{
            t('admin.ai.latency', { ms: formatNumber(testResult.latencyMs) })
          }}</span></span
        >
      </div>

      <div class="actions">
        <ion-button fill="clear" color="dark" :disabled="busy" @click="test">{{
          t('admin.ai.testConnection')
        }}</ion-button>
        <ion-button color="primary" :disabled="busy" @click="save">{{ t('common.actions.save') }}</ion-button>
      </div>
    </div>

    <h3 class="usage-title">{{ t('admin.ai.usageTitle') }}</h3>
    <ion-list v-if="usage?.byInstitute.length">
      <ion-list-header>{{ t('admin.ai.byInstitute') }}</ion-list-header>
      <ion-item v-for="u in usage.byInstitute" :key="String(u.instituteId)">
        <ion-label>
          <h3>
            {{
              u.instituteId === null
                ? t('admin.ai.platform')
                : (instituteNames[u.instituteId] ?? t('admin.ai.instituteId', { id: u.instituteId }))
            }}
          </h3>
          <p>{{ usageLine(u) }}</p>
        </ion-label>
      </ion-item>
      <ion-list-header>{{ t('admin.ai.byProvider') }}</ion-list-header>
      <ion-item v-for="u in usage.byProvider" :key="`${u.provider}/${u.model}`">
        <ion-label>
          <h3>
            {{ u.provider }} · {{ u.model }}
            <StatusChip v-if="u.provider === 'mock'" :label="t('admin.ai.simulated')" tone="warning" />
          </h3>
          <p>{{ usageLine(u) }}</p>
        </ion-label>
      </ion-item>
    </ion-list>
    <p v-else class="muted">{{ t('admin.ai.noCalls') }}</p>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonChip,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonToggle,
  alertController,
} from '@ionic/vue';
import { alertCircle, checkmarkCircle, informationCircle, sparkles } from 'ionicons/icons';
import {
  AI_PROVIDER_PRESETS,
  type AiAdminUsageDto,
  type AiAdminUsageRow,
  type AiProviderId,
  type AiProviderPreset,
  type AiSettingsDto,
  type AiSettingsUpdate,
  type AiTestResult,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatNumber } from '@/core/format';
import { formatTokens, formatUsd } from '@/core/ai';
import { toast, toastError } from '@/core/toast';
import { adminApi } from './api';

type PriceKey = 'inputUsdPer1M' | 'outputUsdPer1M';

const { t } = useI18n();

const settings = ref<AiSettingsDto | null>(null);
const form = reactive<Omit<AiSettingsUpdate, 'apiKey' | PriceKey>>({
  provider: 'openai',
  baseUrl: '',
  model: '',
  jsonMode: false,
});
const apiKey = ref('');
/** Price overrides; empty = the preset's list price. */
const prices = reactive<{ input: string | number | null; output: string | number | null }>({
  input: '',
  output: '',
});
const busy = ref(false);
const testResult = ref<AiTestResult | null>(null);
const usage = ref<AiAdminUsageDto | null>(null);
const instituteNames = ref<Record<number, string>>({});

const isMock = computed(() => form.provider === 'mock');
const presets = computed(() =>
  AI_PROVIDER_PRESETS.filter((p) => p.id !== 'mock' || settings.value?.mockAllowed),
);
const presetHint = computed(() => AI_PROVIDER_PRESETS.find((p) => p.id === form.provider)?.hint);
const providerLabel = (id: AiProviderId) => AI_PROVIDER_PRESETS.find((p) => p.id === id)?.label ?? id;
const needsKey = (id: AiProviderId) => id !== 'ollama' && id !== 'mock';

/** Mirrors the server: mock in use (and why), or no key for a provider that needs one. */
const notice = computed<{ color: 'danger' | 'warning'; text: string } | null>(() => {
  const s = settings.value;
  if (!s) return null;
  if (s.provider === 'mock' && !s.mockAllowed)
    return {
      color: 'danger',
      text: t('admin.ai.notices.mockBlocked'),
    };
  if (s.mockReason === 'selected')
    return {
      color: 'warning',
      text: t('admin.ai.notices.mockSelected'),
    };
  if (s.mockReason === 'fallback')
    return {
      color: 'warning',
      text: t('admin.ai.notices.mockFallback', { provider: providerLabel(s.provider), model: s.model }),
    };
  if (!s.hasKey && needsKey(s.provider)) return { color: 'danger', text: t('admin.ai.notices.noKey') };
  return null;
});

/** The preset list price applies to the preset model (any model for mock and Ollama), as on the server. */
const presetPrice = computed(() => {
  const p = AI_PROVIDER_PRESETS.find((x) => x.id === form.provider);
  const anyModel = form.provider === 'mock' || form.provider === 'ollama';
  return p?.inputUsdPer1M != null && (anyModel || p.model === form.model) ? p : null;
});
const pricePlaceholder = (k: PriceKey) =>
  presetPrice.value
    ? t('admin.ai.presetPrice', { price: presetPrice.value[k] ?? 0 })
    : t('admin.ai.priceNotSet');
const toPrice = (v: string | number | null) => (v === '' || v === null ? null : Number(v));

function usageLine(u: Omit<AiAdminUsageRow, 'instituteId'>) {
  const parts = [t('admin.ai.calls', { n: formatNumber(u.calls) })];
  if (u.errors) parts.push(t('admin.ai.failed', { n: formatNumber(u.errors) }));
  parts.push(t('admin.ai.tokens', { n: formatTokens(u.totalTokens) }));
  if (u.images) parts.push(t('admin.ai.images', { n: formatNumber(u.images) }));
  parts.push(t('admin.ai.estimate', { cost: formatUsd(u.estimatedCostUsd) }));
  return parts.join(' · ');
}
const keyPlaceholder = computed(() => {
  const s = settings.value;
  if (!s?.hasKey) return t('admin.ai.keyNotSet');
  if (s.keySource === 'env') return t('admin.ai.keyFromEnv', { hint: s.keyHint });
  return t('admin.ai.keySaved', { hint: s.keyHint });
});

function fill(s: AiSettingsDto) {
  settings.value = s;
  Object.assign(form, { provider: s.provider, baseUrl: s.baseUrl, model: s.model, jsonMode: s.jsonMode });
  const own = s.pricingSource === 'settings';
  Object.assign(prices, { input: own ? s.inputUsdPer1M : '', output: own ? s.outputUsdPer1M : '' });
  apiKey.value = '';
}

function applyPreset(p: AiProviderPreset) {
  // Price overrides belong to the previous provider's model.
  if (p.id !== form.provider) Object.assign(prices, { input: '', output: '' });
  Object.assign(form, { provider: p.id, baseUrl: p.baseUrl, model: p.model });
  testResult.value = null;
}

const payload = (): AiSettingsUpdate => ({
  ...form,
  apiKey: isMock.value ? undefined : apiKey.value.trim() || undefined,
  inputUsdPer1M: toPrice(prices.input),
  outputUsdPer1M: toPrice(prices.output),
});

async function save() {
  busy.value = true;
  try {
    fill(await adminApi.saveAiSettings(payload()));
    await toast(t('admin.ai.saved'));
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function test() {
  busy.value = true;
  testResult.value = null;
  try {
    testResult.value = await adminApi.testAi(payload());
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function removeKey() {
  const alert = await alertController.create({
    header: t('admin.ai.removeTitle'),
    message: t('admin.ai.removeMessage'),
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      {
        text: t('common.actions.remove'),
        role: 'destructive',
        handler: () => adminApi.removeAiKey().then(fill).catch(toastError),
      },
    ],
  });
  await alert.present();
}

async function loadUsage() {
  const [u, inst] = await Promise.all([
    adminApi.aiUsage(30),
    adminApi.institutes({ page: 1 }).catch(() => null),
  ]);
  usage.value = u;
  instituteNames.value = Object.fromEntries((inst?.items ?? []).map((i) => [i.id, i.name]));
}

onMounted(async () => {
  try {
    fill(await adminApi.aiSettings());
    await loadUsage();
  } catch (e) {
    await toastError(e);
  }
});
</script>

<style scoped>
.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.title-row h2 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.badges {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-badge {
  background: var(--ion-color-light);
  padding: 6px 12px;
  border-radius: 6px;
}
.ai-card {
  border: 1px solid var(--ion-color-step-150, #ddd);
  border-radius: 8px;
  padding: 16px 20px;
}
.card-title {
  font-size: 17px;
  margin-bottom: 8px;
}
.presets ion-chip {
  margin: 0;
}
.hint {
  font-size: 13px;
  margin: 6px 0 0;
}
.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  margin-top: 16px;
}
@media (min-width: 768px) {
  .grid {
    grid-template-columns: 3fr 2fr;
  }
  .grid.prices {
    grid-template-columns: 1fr 1fr;
  }
}
.toggles {
  display: flex;
  align-items: center;
  gap: 16px;
}
.note {
  font-size: 13px;
}
.test-result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
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
.usage-title {
  margin-top: 32px;
}
</style>

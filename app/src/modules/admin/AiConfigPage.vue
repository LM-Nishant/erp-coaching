<template>
  <AppPage title="AI configuration">
    <div class="title-row">
      <h2><ion-icon :icon="sparkles" color="primary" /> AI provider</h2>
      <div v-if="settings" class="badges">
        <ion-badge v-if="settings.effectiveProvider === 'mock'" color="warning">mock</ion-badge>
        <code class="model-badge">{{ settings.effectiveModel }}</code>
      </div>
    </div>

    <div v-if="notice" class="notice" :class="notice.color">
      <ion-icon :icon="notice.color === 'danger' ? alertCircle : informationCircle" />
      <span>{{ notice.text }}</span>
    </div>

    <div v-if="settings" class="ai-card">
      <div class="card-title">AI provider (any OpenAI-compatible chat completions API)</div>

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
          label="Base URL"
          label-placement="stacked"
          type="url"
          :readonly="isMock"
          @ion-input="form.provider = 'custom'"
        />
        <ion-input v-model="form.model" fill="outline" label="Model" label-placement="stacked" />
        <ion-input
          v-if="!isMock"
          v-model="apiKey"
          class="span-wide"
          fill="outline"
          label="API key"
          label-placement="stacked"
          type="password"
          autocomplete="off"
          :placeholder="keyPlaceholder"
        />
        <div class="toggles">
          <ion-toggle v-model="form.jsonMode" label-placement="end">JSON mode</ion-toggle>
          <ion-button
            v-if="settings.keySource === 'database'"
            fill="clear"
            color="danger"
            size="small"
            @click="removeKey"
            >Remove key</ion-button
          >
        </div>
      </div>

      <div class="grid prices">
        <ion-input
          v-model="prices.input"
          fill="outline"
          label="Input price (USD per 1M tokens)"
          label-placement="stacked"
          type="number"
          min="0"
          :placeholder="pricePlaceholder('inputUsdPer1M')"
        />
        <ion-input
          v-model="prices.output"
          fill="outline"
          label="Output price (USD per 1M tokens)"
          label-placement="stacked"
          type="number"
          min="0"
          :placeholder="pricePlaceholder('outputUsdPer1M')"
        />
      </div>

      <p class="muted note">
        <template v-if="isMock"
          >The mock provider runs inside the API server: no key, no network calls.</template
        >
        <template v-else>
          The key is stored on the server and never sent back to the browser. Defaults come from env
          AI_BASE_URL / AI_MODEL / AI_API_KEY.
          <template v-if="settings.keySource === 'env'"
            ><br />Currently using the key from the server environment.</template
          >
        </template>
        <br />Prices are used to estimate the cost of each AI call. Leave them empty to use the preset's list
        price.
      </p>

      <div v-if="testResult" class="test-result" :class="testResult.ok ? 'ok' : 'fail'">
        <ion-icon :icon="testResult.ok ? checkmarkCircle : alertCircle" />
        <span
          >{{ testResult.message }} <span class="muted">({{ testResult.latencyMs }} ms)</span></span
        >
      </div>

      <div class="actions">
        <ion-button fill="clear" color="dark" :disabled="busy" @click="test">Test connection</ion-button>
        <ion-button color="primary" :disabled="busy" @click="save">Save</ion-button>
      </div>
    </div>

    <h3 class="usage-title">Usage (last 30 days)</h3>
    <ion-list v-if="usage?.byInstitute.length">
      <ion-list-header>By institute</ion-list-header>
      <ion-item v-for="u in usage.byInstitute" :key="String(u.instituteId)">
        <ion-label>
          <h3>
            {{
              u.instituteId === null
                ? 'Platform'
                : (instituteNames[u.instituteId] ?? `Institute #${u.instituteId}`)
            }}
          </h3>
          <p>{{ usageLine(u) }}</p>
        </ion-label>
      </ion-item>
      <ion-list-header>By provider and model</ion-list-header>
      <ion-item v-for="u in usage.byProvider" :key="`${u.provider}/${u.model}`">
        <ion-label>
          <h3>
            {{ u.provider }} · {{ u.model }}
            <ion-badge v-if="u.provider === 'mock'" color="warning">simulated</ion-badge>
          </h3>
          <p>{{ usageLine(u) }}</p>
        </ion-label>
      </ion-item>
    </ion-list>
    <p v-else class="muted">No AI calls yet.</p>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  IonBadge,
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
import { formatTokens, formatUsd } from '@/core/ai';
import { toast, toastError } from '@/core/toast';
import { adminApi } from './api';

type PriceKey = 'inputUsdPer1M' | 'outputUsdPer1M';

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
      text: 'The mock provider is saved but cannot run in production, so AI features are off. Configure a real provider.',
    };
  if (s.mockReason === 'selected')
    return {
      color: 'warning',
      text: 'The offline mock provider is active: AI grading, OCR and generated questions are simulated. Pick a real provider before going live.',
    };
  if (s.mockReason === 'fallback')
    return {
      color: 'warning',
      text: `No API key is configured for ${providerLabel(s.provider)}, so AI features use the offline mock provider (simulated results). Add a key to use ${s.model}.`,
    };
  if (!s.hasKey && needsKey(s.provider))
    return { color: 'danger', text: 'No API key is configured, so AI features are unavailable.' };
  return null;
});

/** The preset list price applies to the preset model (any model for mock and Ollama), as on the server. */
const presetPrice = computed(() => {
  const p = AI_PROVIDER_PRESETS.find((x) => x.id === form.provider);
  const anyModel = form.provider === 'mock' || form.provider === 'ollama';
  return p?.inputUsdPer1M != null && (anyModel || p.model === form.model) ? p : null;
});
const pricePlaceholder = (k: PriceKey) =>
  presetPrice.value ? `${presetPrice.value[k] ?? 0} (preset)` : 'Not set: cost is not estimated';
const toPrice = (v: string | number | null) => (v === '' || v === null ? null : Number(v));

function usageLine(u: Omit<AiAdminUsageRow, 'instituteId'>) {
  const parts = [`${u.calls} calls`];
  if (u.errors) parts.push(`${u.errors} failed`);
  parts.push(`${formatTokens(u.totalTokens)} tokens`);
  if (u.images) parts.push(`${u.images} images`);
  parts.push(`est. ${formatUsd(u.estimatedCostUsd)}`);
  return parts.join(' · ');
}
const keyPlaceholder = computed(() => {
  const s = settings.value;
  if (!s?.hasKey) return 'Not set';
  if (s.keySource === 'env') return `from env (${s.keyHint}) - enter a key to override`;
  return `saved (${s.keyHint}) - leave empty to keep`;
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
    await toast('AI settings saved');
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
    header: 'Remove stored API key?',
    message: 'AI features fall back to AI_API_KEY from the server environment, if set.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Remove',
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

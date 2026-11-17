<template>
  <AppPage title="AI configuration">
    <div class="title-row">
      <h2><ion-icon :icon="sparkles" color="primary" /> AI provider</h2>
      <code v-if="settings" class="model-badge">{{ settings.model }}</code>
    </div>

    <div v-if="settings" class="ai-card">
      <div class="card-title">AI provider (any OpenAI-compatible chat completions API)</div>

      <div class="chip-row presets">
        <ion-chip
          v-for="p in AI_PROVIDER_PRESETS"
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
          @ion-input="form.provider = 'custom'"
        />
        <ion-input v-model="form.model" fill="outline" label="Model" label-placement="stacked" />
        <ion-input
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

      <p class="muted note">
        The key is stored on the server and never sent back to the browser. Defaults come from env AI_BASE_URL
        / AI_MODEL / AI_API_KEY.
        <template v-if="settings.keySource === 'env'"
          ><br />Currently using the key from the server environment.</template
        >
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
    <ion-list v-if="usage.length">
      <ion-item v-for="u in usage" :key="String(u.instituteId)">
        <ion-label>
          <h3>
            {{
              u.instituteId === null
                ? 'Platform'
                : (instituteNames[u.instituteId] ?? `Institute #${u.instituteId}`)
            }}
          </h3>
          <p>{{ u.calls }} calls · {{ Number(u.totalTokens ?? 0).toLocaleString() }} tokens</p>
        </ion-label>
      </ion-item>
    </ion-list>
    <p v-else class="muted">No AI calls yet.</p>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  IonButton,
  IonChip,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonToggle,
  alertController,
} from '@ionic/vue';
import { alertCircle, checkmarkCircle, sparkles } from 'ionicons/icons';
import {
  AI_PROVIDER_PRESETS,
  type AiProviderPreset,
  type AiSettingsDto,
  type AiSettingsUpdate,
  type AiTestResult,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { api } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { adminApi } from './api';

interface UsageRow {
  instituteId: number | null;
  calls: number;
  totalTokens: number | string | null;
}

const settings = ref<AiSettingsDto | null>(null);
const form = reactive<Omit<AiSettingsUpdate, 'apiKey'>>({
  provider: 'openai',
  baseUrl: '',
  model: '',
  jsonMode: false,
});
const apiKey = ref('');
const busy = ref(false);
const testResult = ref<AiTestResult | null>(null);
const usage = ref<UsageRow[]>([]);
const instituteNames = ref<Record<number, string>>({});

const presetHint = computed(() => AI_PROVIDER_PRESETS.find((p) => p.id === form.provider)?.hint);
const keyPlaceholder = computed(() => {
  const s = settings.value;
  if (!s?.hasKey) return 'Not set';
  if (s.keySource === 'env') return `from env (${s.keyHint}) - enter a key to override`;
  return `saved (${s.keyHint}) - leave empty to keep`;
});

function fill(s: AiSettingsDto) {
  settings.value = s;
  Object.assign(form, { provider: s.provider, baseUrl: s.baseUrl, model: s.model, jsonMode: s.jsonMode });
  apiKey.value = '';
}

function applyPreset(p: AiProviderPreset) {
  Object.assign(form, { provider: p.id, baseUrl: p.baseUrl, model: p.model });
  testResult.value = null;
}

const payload = (): AiSettingsUpdate => ({ ...form, apiKey: apiKey.value.trim() || undefined });

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
    api.get<{ byInstitute: UsageRow[] }>('/admin/ai/usage'),
    adminApi.institutes({ page: 1 }).catch(() => null),
  ]);
  usage.value = u.byInstitute;
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

<template>
  <ion-card>
    <ion-card-header>
      <ion-card-title>{{ CHANNEL_LABELS[dto.channel] }}</ion-card-title>
      <div class="chip-row">
        <ion-badge :color="dto.enabled ? 'success' : 'medium'">{{
          dto.enabled ? 'Enabled' : dto.configured ? 'Disabled' : 'Built-in console'
        }}</ion-badge>
        <ion-badge v-if="dto.configured" color="light">{{ providerLabel(dto.provider) }}</ion-badge>
      </div>
    </ion-card-header>
    <ion-card-content>
      <ion-list>
        <ion-item>
          <ion-select v-model="form.provider" label="Provider" label-placement="stacked" interface="popover">
            <ion-select-option v-for="k in kinds" :key="k" :value="k">{{
              MESSAGING_PROVIDER_KINDS[k].label
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-for="f in PROVIDER_FIELDS[form.provider]" :key="`${form.provider}-${f.key}`">
          <ion-input
            v-model="form.values[f.key]"
            :label="f.label + (f.required ? ' *' : '')"
            label-placement="stacked"
            :type="f.secret ? 'password' : 'text'"
            autocomplete="off"
            :placeholder="secretPlaceholder(f.key, !!f.secret)"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.testTo"
            :label="TEST_TO_LABELS[dto.channel]"
            label-placement="stacked"
            helper-text="Send test uses it; enabling an untested configuration sends a test here first"
          />
        </ion-item>
        <ion-item><ion-toggle v-model="form.enabled">Enabled</ion-toggle></ion-item>
      </ion-list>
      <TestStatus :status="dto" :result="result" />
      <div class="actions">
        <ion-button v-if="dto.configured" fill="clear" color="danger" :disabled="busy" @click="remove"
          >Remove</ion-button
        >
        <ion-button fill="outline" :disabled="busy" @click="test">Send test</ion-button>
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
  IonSelect,
  IonSelectOption,
  IonToggle,
  alertController,
} from '@ionic/vue';
import {
  MESSAGING_PROVIDER_KINDS,
  PROVIDER_FIELDS,
  type ExternalChannel,
  type IntegrationTestResultDto,
  type MessagingProviderKind,
  type PlatformMessagingDto,
} from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { CHANNEL_LABELS, platformApi } from '../api';
import TestStatus from './TestStatus.vue';

const props = defineProps<{ dto: PlatformMessagingDto }>();
const emit = defineEmits<{ saved: [] }>();

const TEST_TO_LABELS: Record<ExternalChannel, string> = {
  sms: 'Test mobile number',
  whatsapp: 'Test WhatsApp number',
  email: 'Test email address',
  push: 'Test device token',
};

const kinds = computed(() =>
  (Object.keys(MESSAGING_PROVIDER_KINDS) as MessagingProviderKind[]).filter((k) =>
    (MESSAGING_PROVIDER_KINDS[k].channels as readonly ExternalChannel[]).includes(props.dto.channel),
  ),
);
const providerLabel = (p: string) => MESSAGING_PROVIDER_KINDS[p as MessagingProviderKind]?.label ?? p;

const toForm = (d: PlatformMessagingDto) => ({
  provider: d.provider as MessagingProviderKind,
  enabled: d.enabled,
  values: { ...d.settings } as Record<string, string>,
  testTo: '',
});

const form = ref(toForm(props.dto));
const result = ref<IntegrationTestResultDto | null>(null);
const busy = ref(false);

watch(
  () => JSON.stringify(props.dto),
  () => {
    form.value = { ...toForm(props.dto), testTo: form.value.testTo };
    result.value = null;
  },
);
// Another provider starts from its saved fields (if it is the saved one) or blank.
watch(
  () => form.value.provider,
  (provider, previous) => {
    if (provider !== previous)
      form.value.values = provider === props.dto.provider ? { ...props.dto.settings } : {};
  },
);

/** Saved secrets apply only while the saved provider is selected. */
function secretPlaceholder(key: string, secret: boolean) {
  const hint = secret && form.value.provider === props.dto.provider ? props.dto.secretHints[key] : undefined;
  return hint ? `Saved (${hint}); blank keeps it` : '';
}

const settings = () =>
  Object.fromEntries(
    PROVIDER_FIELDS[form.value.provider].map((f) => [f.key, String(form.value.values[f.key] ?? '').trim()]),
  );

async function test() {
  const to = String(form.value.testTo ?? '').trim();
  if (to.length < 3) {
    await toast(`Enter a ${TEST_TO_LABELS[props.dto.channel].toLowerCase()} first`, 'warning');
    return;
  }
  busy.value = true;
  try {
    result.value = await platformApi.testMessaging(props.dto.channel, {
      provider: form.value.provider,
      settings: settings(),
      to,
    });
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function save() {
  busy.value = true;
  try {
    const to = String(form.value.testTo ?? '').trim();
    await platformApi.saveMessaging(props.dto.channel, {
      provider: form.value.provider,
      enabled: form.value.enabled,
      settings: settings(),
      testTo: to.length >= 3 ? to : undefined,
    });
    await toast(`${CHANNEL_LABELS[props.dto.channel]} provider saved`);
    emit('saved');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  const alert = await alertController.create({
    header: `Remove the ${CHANNEL_LABELS[props.dto.channel]} provider?`,
    message: 'Its saved credentials are deleted and messages fall back to the built-in console provider.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Remove', role: 'destructive' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'destructive') return;
  try {
    await platformApi.removeMessaging(props.dto.channel);
    await toast('Provider removed');
    emit('saved');
  } catch (e) {
    await toastError(e);
  }
}
</script>

<style scoped>
.chip-row {
  margin-top: 6px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
</style>

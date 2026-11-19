<template>
  <div>
    <p class="muted">
      Credentials are encrypted and never shown again; leave a secret blank to keep the saved value. Until a
      provider is configured, messages go to the development console.
    </p>
    <ion-card v-for="p in forms" :key="p.channel">
      <ion-card-header>
        <ion-card-title>{{ CHANNEL_LABELS[p.channel] }}</ion-card-title>
        <ion-card-subtitle>{{
          p.updatedAt ? `Updated ${formatDate(p.updatedAt)}` : 'Default (console)'
        }}</ion-card-subtitle>
      </ion-card-header>
      <ion-card-content>
        <ion-list>
          <ion-item>
            <ion-select v-model="p.provider" label="Provider" label-placement="stacked" interface="popover">
              <ion-select-option v-for="k in kindsFor(p.channel)" :key="k" :value="k">{{
                MESSAGING_PROVIDER_KINDS[k].label
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ProviderFields
            v-model="p.values"
            :kind="p.provider"
            :channel="p.channel"
            :secret-hints="p.provider === p.savedProvider ? p.secretHints : {}"
          />
          <ion-item>
            <ion-input
              v-model.number="p.retryMaxAttempts"
              type="number"
              label="Max attempts"
              label-placement="stacked"
              min="1"
              max="10"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model.number="p.retryBaseDelaySeconds"
              type="number"
              label="First retry after (seconds, doubles each time)"
              label-placement="stacked"
              min="5"
              max="3600"
            />
          </ion-item>
          <ion-item><ion-toggle v-model="p.isActive">Active</ion-toggle></ion-item>
        </ion-list>
        <MessagingWebhook
          v-if="p.webhook && p.provider === p.savedProvider"
          :kind="p.provider"
          :webhook="p.webhook"
        />
        <ion-button :disabled="saving" @click="save(p)">Save</ion-button>
        <ion-button fill="outline" @click="test(p.channel)">Send test</ion-button>
        <ion-button
          v-if="p.updatedAt && p.savedProvider !== 'console'"
          fill="outline"
          @click="verify(p.channel)"
          >Check keys</ion-button
        >
        <ion-button v-if="p.updatedAt" fill="clear" color="medium" @click="reset(p.channel)"
          >Reset</ion-button
        >
      </ion-card-content>
    </ion-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
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
  providerFieldsFor,
  type ExternalChannel,
  type MessagingProviderKind,
  type NotificationProviderDto,
} from '@erp/shared';
import MessagingWebhook from '@/components/MessagingWebhook.vue';
import ProviderFields from '@/components/ProviderFields.vue';
import { toast, toastError } from '@/core/toast';
import { CHANNEL_LABELS, commsApi, formatDate } from '../api';

/** Saved secrets and the webhook belong to the saved provider (`savedProvider`). */
type ProviderForm = NotificationProviderDto & {
  values: Record<string, string>;
  savedProvider: MessagingProviderKind;
};

const forms = ref<ProviderForm[]>([]);
const saving = ref(false);

const kindsFor = (channel: ExternalChannel) =>
  (Object.keys(MESSAGING_PROVIDER_KINDS) as MessagingProviderKind[]).filter((k) =>
    (MESSAGING_PROVIDER_KINDS[k].channels as readonly ExternalChannel[]).includes(channel),
  );

const toForm = (p: NotificationProviderDto): ProviderForm => ({
  ...p,
  values: { ...p.settings },
  savedProvider: p.provider,
});

async function load() {
  try {
    forms.value = (await commsApi.providers()).map(toForm);
  } catch (e) {
    await toastError(e);
  }
}

async function save(p: ProviderForm) {
  saving.value = true;
  try {
    const saved = await commsApi.saveProvider(p.channel, {
      provider: p.provider,
      isActive: p.isActive,
      settings: Object.fromEntries(
        providerFieldsFor(p.provider, p.channel).map((f) => [f.key, String(p.values[f.key] ?? '')]),
      ),
      retryMaxAttempts: Number(p.retryMaxAttempts),
      retryBaseDelaySeconds: Number(p.retryBaseDelaySeconds),
    });
    forms.value = forms.value.map((f) => (f.channel === p.channel ? toForm(saved) : f));
    await toast('Provider saved');
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function reset(channel: ExternalChannel) {
  try {
    const saved = await commsApi.resetProvider(channel);
    forms.value = forms.value.map((f) => (f.channel === channel ? toForm(saved) : f));
  } catch (e) {
    await toastError(e);
  }
}

/** WhatsApp sends approved templates only; Indian SMS must match a DLT template. */
const TEST_TEMPLATE_HINT: Partial<Record<ExternalChannel, string>> = {
  whatsapp: 'Approved template, e.g. hello_world:en_US',
  sms: 'DLT template id (optional)',
};

async function test(channel: ExternalChannel) {
  const template = TEST_TEMPLATE_HINT[channel];
  const alert = await alertController.create({
    header: `Send a test ${CHANNEL_LABELS[channel]}`,
    message: 'Uses the active provider (saved settings).',
    inputs: [
      {
        name: 'to',
        placeholder:
          channel === 'email' ? 'Email address' : channel === 'push' ? 'Device token' : 'Mobile number',
      },
      ...(template ? [{ name: 'templateId', placeholder: template }] : []),
      ...(channel === 'sms' ? [{ name: 'body', placeholder: 'Text of that template (optional)' }] : []),
    ],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Send',
        handler: async (v: { to: string; templateId?: string; body?: string }) => {
          try {
            const r = await commsApi.testProvider(channel, v.to, {
              templateId: v.templateId?.trim() || undefined,
              body: v.body?.trim() || undefined,
            });
            await toast(
              r.ok ? `Sent via ${r.provider}` : `Failed: ${r.error ?? 'unknown error'}`,
              r.ok ? 'success' : 'danger',
            );
          } catch (e) {
            await toastError(e);
          }
        },
      },
    ],
  });
  await alert.present();
}

async function verify(channel: ExternalChannel) {
  try {
    const r = await commsApi.verifyProvider(channel);
    await toast(r.message, r.ok ? 'success' : 'danger');
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>

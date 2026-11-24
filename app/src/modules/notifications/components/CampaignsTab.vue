<template>
  <div>
    <ion-button v-can="'notifications.create'" expand="block" @click="openCompose">
      <ion-icon slot="start" :icon="sendOutline" /> {{ t('notifications.compose.open') }}
    </ion-button>

    <ion-list>
      <ion-list-header
        ><ion-label>{{ t('notifications.compose.listTitle') }}</ion-label></ion-list-header
      >
      <ion-item v-for="c in campaigns" :key="c.id">
        <ion-label>
          <h3>
            {{ c.title }}
            <ion-badge :color="statusColor(c.status)">{{
              t(`notifications.compose.status.${c.status}`)
            }}</ion-badge>
          </h3>
          <p>{{ c.channels.map((ch) => CHANNEL_LABELS[ch]).join(', ') }} · {{ audienceLabel(c.audience) }}</p>
          <p>
            {{
              c.scheduledAt
                ? t('notifications.compose.scheduledOn', { date: formatDate(c.scheduledAt) })
                : t('notifications.compose.sentOn', { date: formatDate(c.createdAt) })
            }}
            <span v-if="c.status === 'sent'">
              · {{ t('notifications.compose.recipients', { n: c.recipientCount }, c.recipientCount) }}</span
            >
          </p>
        </ion-label>
        <ion-button
          v-if="c.status === 'scheduled'"
          slot="end"
          v-can="'notifications.create'"
          fill="clear"
          color="danger"
          @click="cancel(c)"
          >{{ t('common.actions.cancel') }}</ion-button
        >
      </ion-item>
      <EmptyState
        v-if="!loading && !campaigns.length"
        :icon="megaphoneOutline"
        :title="t('notifications.compose.emptyTitle')"
        :message="t('notifications.compose.emptyMessage')"
      />
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ t('notifications.compose.title') }}</ion-title>
          <ion-buttons slot="end"
            ><ion-button @click="form = null">{{ t('common.actions.close') }}</ion-button></ion-buttons
          >
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="send">
          <AudiencePicker v-model="form.audience" :batches="batches" class="audience" />
          <p class="reach" role="status">
            <template v-if="reach !== null">{{
              t('notifications.compose.reach', { n: reach }, reach)
            }}</template>
          </p>

          <FormSection :title="t('notifications.compose.message')">
            <ion-list>
              <ion-item>
                <ion-input
                  v-model="form.title"
                  :label="t('notifications.compose.subjectLine')"
                  label-placement="stacked"
                  :placeholder="t('notifications.compose.subjectPlaceholder')"
                  required
                />
              </ion-item>
              <ion-item>
                <ion-textarea
                  v-model="form.body"
                  :label="t('notifications.compose.body')"
                  label-placement="stacked"
                  auto-grow
                  :rows="4"
                  :counter="true"
                  :maxlength="4000"
                  required
                />
              </ion-item>
            </ion-list>
          </FormSection>

          <FormSection :title="t('notifications.compose.alsoSend')">
            <p class="muted small">{{ t('notifications.compose.appAlways') }}</p>
            <div class="chips">
              <button
                v-for="c in EXTRA_CHANNELS"
                :key="c"
                type="button"
                :class="['chip', { on: form.extra.includes(c) }]"
                :aria-pressed="form.extra.includes(c)"
                @click="toggleExtra(c)"
              >
                {{ CHANNEL_LABELS[c] }}
              </button>
            </div>
            <ion-item v-if="form.extra.includes('email')">
              <ion-input
                v-model="form.subject"
                :label="t('notifications.compose.emailSubject')"
                label-placement="stacked"
              />
            </ion-item>
          </FormSection>

          <FormSection v-model:open="form.schedule" advanced :title="t('notifications.compose.schedule')">
            <ion-item>
              <ion-input
                v-model="form.scheduledAt"
                type="datetime-local"
                :label="t('notifications.compose.sendAt')"
                label-placement="stacked"
              />
            </ion-item>
          </FormSection>

          <ion-button expand="block" type="submit" class="send" :disabled="saving">
            <ion-icon slot="start" :icon="sendOutline" />
            {{
              form.schedule
                ? t('notifications.compose.scheduleSubmit')
                : reach !== null
                  ? t('notifications.compose.sendTo', { n: reach }, reach)
                  : t('notifications.compose.sendNow')
            }}
          </ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonTextarea,
  IonTitle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { megaphoneOutline, sendOutline } from 'ionicons/icons';
import type {
  BatchDto,
  CampaignAudience,
  CampaignDto,
  CampaignStatus,
  NotificationChannel,
} from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import FormSection from '@/components/FormSection.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi } from '../../academics/api';
import { CHANNEL_LABELS, commsApi, formatDate } from '../api';
import { toCampaignAudience, whoOfRoles, type AudienceChoice } from '../audience';
import AudiencePicker from './AudiencePicker.vue';

const EXTRA_CHANNELS: NotificationChannel[] = ['sms', 'whatsapp', 'email'];

interface ComposeForm {
  title: string;
  subject: string;
  body: string;
  audience: AudienceChoice;
  extra: NotificationChannel[];
  schedule: boolean;
  scheduledAt: string;
}

const { t, te } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const branches = computed(() => auth.me?.branches ?? []);
const branchLimited = computed(() => !!auth.me?.allowedBranchIds);
const campaigns = ref<CampaignDto[]>([]);
const batches = ref<BatchDto[]>([]);
const loading = ref(true);
const saving = ref(false);
const form = ref<ComposeForm | null>(null);
const reach = ref<number | null>(null);

const statusColor = (s: CampaignStatus) =>
  ({ scheduled: 'warning', processing: 'primary', sent: 'success', cancelled: 'medium', failed: 'danger' })[
    s
  ];

function audienceLabel(a: CampaignAudience) {
  const parts: string[] = [];
  const who = (keys: string[]) =>
    keys
      .map((k) => (te(`notifications.audience.who.${k}`) ? t(`notifications.audience.who.${k}`) : k))
      .join(', ');
  if (a.roles?.length) parts.push(who(whoOfRoles(a.roles)));
  if (a.branchIds?.length)
    parts.push(a.branchIds.map((id) => branches.value.find((b) => b.id === id)?.name ?? `#${id}`).join(', '));
  if (a.batchIds?.length) {
    const n = a.batchIds.length;
    parts.push(
      `${t('notifications.audience.batchCount', { n }, n)} (${who(a.batchRecipients ?? ['students', 'teachers'])})`,
    );
  }
  if (a.userIds?.length)
    parts.push(t('notifications.audience.userCount', { n: a.userIds.length }, a.userIds.length));
  return parts.join(' · ') || t('notifications.audience.everyone');
}

async function load() {
  loading.value = true;
  try {
    campaigns.value = (await commsApi.campaigns()).items;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

const defaultBranch = () =>
  branchLimited.value
    ? (auth.activeBranchId ?? auth.me?.allowedBranchIds?.[0] ?? branches.value[0]?.id ?? null)
    : null;

async function openCompose() {
  form.value = {
    title: '',
    subject: '',
    body: '',
    audience: {
      scope: 'institute',
      who: ['students', 'parents'],
      batchIds: [],
      branchId: defaultBranch(),
    },
    extra: [],
    schedule: false,
    scheduledAt: '',
  };
  if (!batches.value.length && auth.can('academics.view') && auth.moduleEnabled('academics')) {
    batches.value = (await academicsApi.batches().catch(() => ({ items: [] as BatchDto[] }))).items.filter(
      (b) => b.status === 'active' || b.status === 'planned',
    );
  }
}

function toggleExtra(c: NotificationChannel) {
  const f = form.value;
  if (!f) return;
  f.extra = f.extra.includes(c) ? f.extra.filter((x) => x !== c) : [...f.extra, c];
}

let previewSeq = 0;
watch(
  () => (form.value ? JSON.stringify(form.value.audience) : null),
  async () => {
    reach.value = null;
    const a = form.value && toCampaignAudience(form.value.audience);
    if (!a) return;
    const seq = ++previewSeq;
    const r = await commsApi.previewAudience(a).catch(() => null);
    if (seq === previewSeq && r) reach.value = r.recipients;
  },
);

async function send() {
  const f = form.value;
  if (!f) return;
  const audience = toCampaignAudience(f.audience);
  if (!audience) return toast(t('notifications.compose.chooseAudience'), 'warning');
  if (f.schedule && !f.scheduledAt) return toast(t('notifications.compose.chooseTime'), 'warning');
  saving.value = true;
  try {
    await commsApi.createCampaign({
      title: f.title,
      channels: ['in_app', 'push', ...f.extra],
      subject: f.extra.includes('email') ? f.subject || null : null,
      body: f.body,
      audience,
      scheduledAt: f.schedule ? new Date(f.scheduledAt).toISOString() : null,
    });
    form.value = null;
    await toast(f.schedule ? t('notifications.compose.scheduled') : t('notifications.compose.sending'));
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

// From the staff home: `?compose=1` opens the composer.
watch(
  () => route.query.compose,
  (c) => {
    if (c !== '1') return;
    if (auth.can('notifications.create')) void openCompose();
    void router.replace({ query: { ...route.query, compose: undefined } });
  },
  { immediate: true },
);

async function cancel(c: CampaignDto) {
  const alert = await alertController.create({
    header: t('notifications.compose.cancelHeader', { title: c.title }),
    buttons: [
      { text: t('notifications.compose.keep'), role: 'cancel' },
      {
        text: t('notifications.compose.cancelMessage'),
        role: 'destructive',
        handler: () => commsApi.cancelCampaign(c.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

onMounted(load);
</script>

<style scoped>
.reach {
  min-height: 20px;
  margin: 8px 2px 12px;
  font-weight: 600;
  color: var(--ion-color-primary);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.chip {
  min-height: var(--app-tap-target);
  padding: 0 16px;
  border: 1px solid var(--ion-color-step-200, #ccc);
  border-radius: 999px;
  background: var(--ion-item-background, #fff);
  color: var(--ion-text-color);
  font: inherit;
  cursor: pointer;
}
.chip.on {
  border-color: var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary);
  font-weight: 600;
}
.muted {
  color: var(--ion-color-medium);
}
.small {
  font-size: 13px;
  margin: 0 0 8px;
}
.send {
  min-height: var(--app-tap-target);
  margin-top: 8px;
}
</style>

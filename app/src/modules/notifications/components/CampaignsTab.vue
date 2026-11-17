<template>
  <div>
    <ion-button v-can="'notifications.create'" expand="block" @click="openCompose">
      <ion-icon slot="start" :icon="sendOutline" /> Compose message
    </ion-button>

    <ion-list>
      <ion-list-header><ion-label>Bulk &amp; scheduled messages</ion-label></ion-list-header>
      <ion-item v-for="c in campaigns" :key="c.id">
        <ion-label>
          <h3>
            {{ c.title }} <ion-badge :color="statusColor(c.status)">{{ c.status }}</ion-badge>
          </h3>
          <p>{{ c.channels.map((ch) => CHANNEL_LABELS[ch]).join(', ') }} · {{ audienceLabel(c.audience) }}</p>
          <p>
            {{ c.scheduledAt ? `Scheduled ${formatDate(c.scheduledAt)}` : `Sent ${formatDate(c.createdAt)}` }}
            <span v-if="c.status === 'sent'">
              · {{ c.recipientCount }} recipients · {{ c.messageCount }} messages</span
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
          >Cancel</ion-button
        >
      </ion-item>
      <ion-item v-if="!loading && !campaigns.length"
        ><ion-label class="muted">Nothing sent yet.</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Compose</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="send">
          <ion-list>
            <ion-item
              ><ion-input v-model="form.title" label="Title" label-placement="stacked" required
            /></ion-item>
            <ion-item>
              <ion-select v-model="form.channels" label="Channels" label-placement="stacked" multiple>
                <ion-select-option v-for="c in NOTIFICATION_CHANNELS" :key="c" :value="c">{{
                  CHANNEL_LABELS[c]
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="form.channels.includes('email')">
              <ion-input v-model="form.subject" label="Email subject" label-placement="stacked" />
            </ion-item>
            <ion-item>
              <ion-textarea
                v-model="form.body"
                label="Message"
                label-placement="stacked"
                auto-grow
                :counter="true"
                :maxlength="4000"
                required
              />
            </ion-item>
            <ion-list-header><ion-label>Audience</ion-label></ion-list-header>
            <ion-item>
              <ion-select v-model="form.roles" label="Roles" label-placement="stacked" multiple>
                <ion-select-option v-for="r in ROLES" :key="r.slug" :value="r.slug">{{
                  r.label
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="branches.length">
              <ion-select
                v-model="form.branchIds"
                label="Branches"
                label-placement="stacked"
                :multiple="!branchLimited"
                :placeholder="branchLimited ? 'Choose your branch' : 'All branches'"
              >
                <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.batchIds"
                label="Batch ids (comma separated, optional)"
                label-placement="stacked"
                inputmode="numeric"
              />
            </ion-item>
            <ion-item>
              <ion-toggle v-model="form.schedule">Schedule for later</ion-toggle>
            </ion-item>
            <ion-item v-if="form.schedule">
              <ion-input
                v-model="form.scheduledAt"
                type="datetime-local"
                label="Send at"
                label-placement="stacked"
              />
            </ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">
            {{ form.schedule ? 'Schedule' : 'Send now' }}
          </ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { sendOutline } from 'ionicons/icons';
import {
  NOTIFICATION_CHANNELS,
  type CampaignAudience,
  type CampaignDto,
  type CampaignStatus,
  type NotificationChannel,
} from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { CHANNEL_LABELS, commsApi, formatDate } from '../api';

const ROLES = [
  { slug: 'student', label: 'Students' },
  { slug: 'parent', label: 'Parents' },
  { slug: 'teacher', label: 'Teachers' },
  { slug: 'accountant', label: 'Accountants' },
  { slug: 'branch-admin', label: 'Branch admins' },
];

interface ComposeForm {
  title: string;
  channels: NotificationChannel[];
  subject: string;
  body: string;
  roles: string[];
  branchIds: number[] | number | null;
  batchIds: string;
  schedule: boolean;
  scheduledAt: string;
}

const auth = useAuthStore();
const branches = computed(() => auth.me?.branches ?? []);
const branchLimited = computed(() => !!auth.me?.allowedBranchIds);
const campaigns = ref<CampaignDto[]>([]);
const loading = ref(true);
const saving = ref(false);
const form = ref<ComposeForm | null>(null);

const statusColor = (s: CampaignStatus) =>
  ({ scheduled: 'warning', processing: 'primary', sent: 'success', cancelled: 'medium', failed: 'danger' })[
    s
  ];

function audienceLabel(a: CampaignAudience) {
  const parts: string[] = [];
  if (a.roles?.length) parts.push(a.roles.map((r) => ROLES.find((x) => x.slug === r)?.label ?? r).join(', '));
  if (a.branchIds?.length)
    parts.push(a.branchIds.map((id) => branches.value.find((b) => b.id === id)?.name ?? `#${id}`).join(', '));
  if (a.batchIds?.length) parts.push(`${a.batchIds.length} batch(es)`);
  if (a.userIds?.length) parts.push(`${a.userIds.length} user(s)`);
  return parts.join(' · ') || 'Everyone';
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

function openCompose() {
  form.value = {
    title: '',
    channels: ['in_app', 'push'],
    subject: '',
    body: '',
    roles: [],
    branchIds: branchLimited.value ? (auth.activeBranchId ?? branches.value[0]?.id ?? null) : [],
    batchIds: '',
    schedule: false,
    scheduledAt: '',
  };
}

async function send() {
  const f = form.value;
  if (!f) return;
  const branchIds = (Array.isArray(f.branchIds) ? f.branchIds : f.branchIds ? [f.branchIds] : []).filter(
    Boolean,
  );
  const batchIds = f.batchIds
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!f.channels.length) return toast('Choose at least one channel', 'warning');
  if (f.schedule && !f.scheduledAt) return toast('Choose when to send', 'warning');
  saving.value = true;
  try {
    await commsApi.createCampaign({
      title: f.title,
      channels: f.channels,
      subject: f.subject || null,
      body: f.body,
      audience: {
        ...(f.roles.length ? { roles: f.roles } : {}),
        ...(branchIds.length ? { branchIds } : {}),
        ...(batchIds.length ? { batchIds } : {}),
      },
      scheduledAt: f.schedule ? new Date(f.scheduledAt).toISOString() : null,
    });
    form.value = null;
    await toast(f.schedule ? 'Message scheduled' : 'Message is being sent');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function cancel(c: CampaignDto) {
  const alert = await alertController.create({
    header: `Cancel "${c.title}"?`,
    buttons: [
      { text: 'Keep', role: 'cancel' },
      {
        text: 'Cancel message',
        role: 'destructive',
        handler: () => commsApi.cancelCampaign(c.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

onMounted(load);
</script>

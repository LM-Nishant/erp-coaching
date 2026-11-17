<template>
  <AppPage :title="t ? t.ticketNumber : 'Complaint'" :back-href="backHref" :on-refresh="load">
    <template v-if="t">
      <ion-card>
        <ion-card-header>
          <ion-card-subtitle>
            <ion-badge :color="STATUS_COLORS[t.status]">{{ statusLabel(t.status) }}</ion-badge>
            <ion-badge :color="PRIORITY_COLORS[t.priority]">{{ t.priority }}</ion-badge>
            <ion-badge v-if="t.slaBreached || isOverdue(t)" color="danger">SLA breached</ion-badge>
            <ion-badge v-if="t.escalationLevel" color="danger"
              >Escalation level {{ t.escalationLevel }}</ion-badge
            >
          </ion-card-subtitle>
          <ion-card-title>{{ t.subject }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <p class="pre">{{ t.description }}</p>
          <ion-list lines="none">
            <ion-item
              ><ion-label>Category</ion-label><ion-note slot="end">{{ t.categoryName }}</ion-note></ion-item
            >
            <ion-item>
              <ion-label>Raised by</ion-label>
              <ion-note slot="end">
                {{ t.requester?.name }} ({{ t.requesterType }})<template v-if="t.onBehalfOf">
                  for {{ t.onBehalfOf.name }}</template
                >
              </ion-note>
            </ion-item>
            <ion-item>
              <ion-label>Assigned to</ion-label
              ><ion-note slot="end">{{ t.assignee?.name ?? 'Unassigned' }}</ion-note>
            </ion-item>
            <ion-item
              ><ion-label>Raised on</ion-label
              ><ion-note slot="end">{{ formatDate(t.createdAt) }}</ion-note></ion-item
            >
            <ion-item v-if="t.status !== 'closed'">
              <ion-label>Due by</ion-label><ion-note slot="end">{{ formatDate(t.dueAt) }}</ion-note>
            </ion-item>
            <ion-item v-if="t.resolvedAt">
              <ion-label>Resolved on</ion-label><ion-note slot="end">{{ formatDate(t.resolvedAt) }}</ion-note>
            </ion-item>
            <ion-item v-if="t.satisfactionRating">
              <ion-label>Rating</ion-label
              ><ion-note slot="end">{{ '★'.repeat(t.satisfactionRating) }}</ion-note>
            </ion-item>
          </ion-list>
          <div v-if="t.resolutionNotes" class="resolution">
            <strong>Resolution</strong>
            <p class="pre">{{ t.resolutionNotes }}</p>
          </div>
        </ion-card-content>
      </ion-card>

      <!-- Requester actions -->
      <ion-card v-if="isRequester && t.status === 'resolved'">
        <ion-card-header><ion-card-title>Is your issue resolved?</ion-card-title></ion-card-header>
        <ion-card-content>
          <div class="stars">
            <ion-button
              v-for="n in 5"
              :key="n"
              fill="clear"
              size="small"
              :color="n <= rating ? 'warning' : 'medium'"
              @click="rating = n"
              ><ion-icon slot="icon-only" :icon="n <= rating ? star : starOutline"
            /></ion-button>
          </div>
          <ion-textarea v-model="feedback" placeholder="Feedback (optional)" :auto-grow="true" />
          <ion-button expand="block" :disabled="busy" @click="confirm">Yes, close the complaint</ion-button>
          <ion-button expand="block" fill="outline" color="danger" :disabled="busy" @click="reopen">
            No, reopen it
          </ion-button>
        </ion-card-content>
      </ion-card>
      <ion-button
        v-else-if="t.status === 'closed' && (isRequester || t.canManage)"
        expand="block"
        fill="outline"
        :disabled="busy"
        @click="reopen"
        >Reopen complaint</ion-button
      >

      <!-- Staff actions -->
      <ion-card v-if="t.canManage">
        <ion-card-header><ion-card-title>Manage</ion-card-title></ion-card-header>
        <ion-card-content>
          <ion-list>
            <ion-item>
              <ion-select
                :value="t.assignee?.id ?? null"
                label="Assignee"
                interface="popover"
                @ion-change="assign($event.detail.value)"
              >
                <ion-select-option :value="null">Unassigned</ion-select-option>
                <ion-select-option v-for="a in assignees" :key="a.id" :value="a.id">{{
                  a.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                :value="t.priority"
                label="Priority"
                interface="popover"
                @ion-change="setPriority($event.detail.value)"
              >
                <ion-select-option v-for="p in GRIEVANCE_PRIORITIES" :key="p" :value="p">{{
                  p
                }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-button
            v-for="s in nextStatuses"
            :key="s"
            size="small"
            :color="STATUS_COLORS[s]"
            :disabled="busy"
            @click="changeStatus(s)"
            >{{ s === 'open' ? 'Reopen' : `Mark ${statusLabel(s)}` }}</ion-button
          >
        </ion-card-content>
      </ion-card>

      <!-- Attachments -->
      <ion-list v-if="t.attachments.length">
        <ion-list-header><ion-label>Attachments</ion-label></ion-list-header>
        <ion-item v-for="a in t.attachments" :key="a.id" button @click="openAttachment(a.id)">
          <ion-icon slot="start" :icon="attachOutline" />
          <ion-label>
            {{ a.originalName }}
            <p>{{ Math.ceil(a.sizeBytes / 1024) }} KB · {{ formatDate(a.createdAt) }}</p>
          </ion-label>
          <ion-badge v-if="a.isInternal" slot="end" color="warning">internal</ion-badge>
        </ion-item>
      </ion-list>

      <!-- Timeline -->
      <ion-list>
        <ion-list-header><ion-label>Activity</ion-label></ion-list-header>
        <ion-item v-for="a in t.activities" :key="a.id" :class="{ internal: a.isInternal }">
          <ion-label class="ion-text-wrap">
            <h3>
              {{ a.author?.name ?? 'System' }}
              <ion-badge v-if="a.isInternal" color="warning">internal note</ion-badge>
              <span class="muted"> · {{ activityTitle(a) }} · {{ formatDate(a.createdAt) }}</span>
            </h3>
            <p v-if="a.body" class="pre">{{ a.body }}</p>
          </ion-label>
        </ion-item>
      </ion-list>

      <!-- Reply -->
      <ion-card v-if="t.status !== 'closed'">
        <ion-card-content>
          <ion-textarea
            v-model="reply"
            :placeholder="internal ? 'Internal note (staff only)' : 'Write a reply'"
            :auto-grow="true"
            :rows="3"
          />
          <ion-checkbox v-if="t.canManage" v-model="internal"
            >Internal note (hidden from requester)</ion-checkbox
          >
          <input type="file" multiple @change="pickFiles" />
          <ion-button expand="block" :disabled="busy || (!reply.trim() && !files.length)" @click="send"
            >Send</ion-button
          >
        </ion-card-content>
      </ion-card>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonCheckbox,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  alertController,
} from '@ionic/vue';
import { attachOutline, star, starOutline } from 'ionicons/icons';
import {
  GRIEVANCE_PRIORITIES,
  GRIEVANCE_TRANSITIONS,
  type GrievanceActivityDto,
  type GrievancePriority,
  type GrievanceStatus,
  type GrievanceTicketDetailDto,
  type GrievanceUserRef,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { PRIORITY_COLORS, STATUS_COLORS, formatDate, grievancesApi, isOverdue, statusLabel } from './api';

const route = useRoute();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id));
const t = ref<GrievanceTicketDetailDto | null>(null);
const assignees = ref<GrievanceUserRef[]>([]);
const reply = ref('');
const internal = ref(false);
const files = ref<File[]>([]);
const rating = ref(0);
const feedback = ref('');
const busy = ref(false);

const isRequester = computed(() => !!t.value && t.value.requester?.id === auth.me?.user.id);
const backHref = computed(() => (t.value?.canManage ? '/grievances' : '/grievances/my'));
const nextStatuses = computed<readonly GrievanceStatus[]>(() =>
  t.value ? GRIEVANCE_TRANSITIONS[t.value.status] : [],
);

function activityTitle(a: GrievanceActivityDto) {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  switch (a.type) {
    case 'status_change':
      return `${statusLabel(String(m.from ?? ''))} → ${statusLabel(String(m.to ?? ''))}`;
    case 'assignment':
      return 'assignment';
    case 'escalation':
      return 'escalated';
    case 'internal_note':
      return 'note';
    default:
      return a.type.replace('_', ' ');
  }
}

async function load() {
  try {
    t.value = await grievancesApi.get(id.value);
    if (t.value.canManage && !assignees.value.length) assignees.value = await grievancesApi.assignees();
  } catch (e) {
    await toastError(e);
  }
}

async function run(fn: () => Promise<unknown>, message?: string) {
  busy.value = true;
  try {
    await fn();
    if (message) await toast(message);
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

function pickFiles(ev: Event) {
  files.value = Array.from((ev.target as HTMLInputElement).files ?? []);
}

async function send() {
  await run(async () => {
    let commentId: number | undefined;
    if (reply.value.trim())
      commentId = (await grievancesApi.comment(id.value, reply.value.trim(), internal.value)).id;
    for (const f of files.value)
      await grievancesApi.attach(id.value, f, { internal: internal.value, commentId });
    reply.value = '';
    files.value = [];
  }, 'Sent');
}

const assign = (userId: number | null) => {
  if (userId === (t.value?.assignee?.id ?? null)) return;
  return run(() => grievancesApi.assign(id.value, userId), 'Assignment updated');
};
const setPriority = (priority: GrievancePriority) => {
  if (priority === t.value?.priority) return;
  return run(() => grievancesApi.update(id.value, { priority }), 'Priority updated');
};

async function prompt(header: string, placeholder: string, required: boolean): Promise<string | null> {
  const alert = await alertController.create({
    header,
    inputs: [{ name: 'text', type: 'textarea', placeholder }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'OK', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { text: string } }>();
  if (role !== 'confirm') return null;
  const text = data?.values.text?.trim() ?? '';
  if (required && !text) {
    await toast('This field is required', 'warning');
    return null;
  }
  return text;
}

async function changeStatus(status: GrievanceStatus) {
  if (status === 'resolved') {
    const notes = await prompt('Resolution notes', 'What was done to resolve this?', true);
    if (notes === null) return;
    return run(
      () => grievancesApi.setStatus(id.value, { status, resolutionNotes: notes }),
      'Marked resolved',
    );
  }
  const note = await prompt(`Mark ${statusLabel(status)}`, 'Note (optional)', false);
  if (note === null) return;
  return run(() => grievancesApi.setStatus(id.value, { status, note: note || undefined }), 'Status updated');
}

async function reopen() {
  const reason = await prompt('Reopen complaint', 'Why is the issue not resolved?', true);
  if (reason === null) return;
  await run(() => grievancesApi.reopen(id.value, reason), 'Complaint reopened');
}

const confirm = () =>
  run(
    () =>
      grievancesApi.confirmClosure(id.value, {
        rating: rating.value || undefined,
        feedback: feedback.value.trim() || undefined,
      }),
    'Thank you for your feedback',
  );

async function openAttachment(attachmentId: number) {
  try {
    const { url } = await grievancesApi.attachmentUrl(id.value, attachmentId);
    window.open(url, '_blank');
  } catch (e) {
    await toastError(e);
  }
}

watch(id, (v) => v && load(), { immediate: true });
</script>

<style scoped>
ion-badge {
  margin-right: 4px;
  text-transform: capitalize;
}
.pre {
  white-space: pre-wrap;
}
.resolution {
  margin-top: 12px;
  padding: 8px 12px;
  border-left: 3px solid var(--ion-color-success);
}
.internal {
  --background: rgba(var(--ion-color-warning-rgb), 0.08);
}
.stars {
  display: flex;
  justify-content: center;
}
</style>

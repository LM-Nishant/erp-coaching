<template>
  <AppPage
    :title="ticket ? ticket.ticketNumber : t('grievances.detail.title')"
    :back-href="backHref"
    :on-refresh="load"
  >
    <template v-if="ticket">
      <ion-card>
        <ion-card-header>
          <ion-card-subtitle class="chips">
            <StatusChip :label="t(statusKey(ticket.status))" :tone="STATUS_TONES[ticket.status]" />
            <StatusChip :label="t(priorityKey(ticket.priority))" :tone="PRIORITY_TONES[ticket.priority]" />
            <StatusChip
              v-if="ticket.slaBreached || isOverdue(ticket)"
              :label="t('grievances.slaBreached')"
              tone="danger"
            />
            <StatusChip
              v-if="ticket.escalationLevel"
              :label="t('grievances.detail.escalationLevel', { n: ticket.escalationLevel })"
              tone="danger"
            />
          </ion-card-subtitle>
          <ion-card-title>{{ ticket.subject }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <p class="pre">{{ ticket.description }}</p>
          <ion-list lines="none">
            <ion-item>
              <ion-label>{{ t('grievances.fields.category') }}</ion-label>
              <ion-note slot="end">{{ ticket.categoryName }}</ion-note>
            </ion-item>
            <ion-item>
              <ion-label>{{ t('grievances.detail.raisedBy') }}</ion-label>
              <ion-note slot="end">
                {{
                  t('grievances.detail.raisedByValue', {
                    name: ticket.requester?.name ?? '',
                    type: t(`grievances.requesterType.${ticket.requesterType}`),
                  })
                }}<template v-if="ticket.onBehalfOf">
                  {{ t('grievances.detail.forName', { name: ticket.onBehalfOf.name }) }}</template
                >
              </ion-note>
            </ion-item>
            <ion-item>
              <ion-label>{{ t('grievances.detail.assignedTo') }}</ion-label>
              <ion-note slot="end">{{ ticket.assignee?.name ?? t('grievances.unassigned') }}</ion-note>
            </ion-item>
            <ion-item>
              <ion-label>{{ t('grievances.detail.raisedOn') }}</ion-label>
              <ion-note slot="end">{{ formatDateTime(ticket.createdAt) }}</ion-note>
            </ion-item>
            <ion-item v-if="ticket.status !== 'closed'">
              <ion-label>{{ t('grievances.detail.dueBy') }}</ion-label>
              <ion-note slot="end">{{ formatDateTime(ticket.dueAt) }}</ion-note>
            </ion-item>
            <ion-item v-if="ticket.resolvedAt">
              <ion-label>{{ t('grievances.detail.resolvedOn') }}</ion-label>
              <ion-note slot="end">{{ formatDateTime(ticket.resolvedAt) }}</ion-note>
            </ion-item>
            <ion-item v-if="ticket.satisfactionRating">
              <ion-label>{{ t('grievances.detail.rating') }}</ion-label>
              <ion-note slot="end">{{ '★'.repeat(ticket.satisfactionRating) }}</ion-note>
            </ion-item>
          </ion-list>
          <div v-if="ticket.resolutionNotes" class="resolution">
            <strong>{{ t('grievances.detail.resolution') }}</strong>
            <p class="pre">{{ ticket.resolutionNotes }}</p>
          </div>
        </ion-card-content>
      </ion-card>

      <!-- Requester actions -->
      <ion-card v-if="isRequester && ticket.status === 'resolved'">
        <ion-card-header>
          <ion-card-title>{{ t('grievances.detail.resolvedQuestion') }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <div class="stars">
            <ion-button
              v-for="n in 5"
              :key="n"
              fill="clear"
              size="small"
              :color="n <= rating ? 'warning' : 'medium'"
              :aria-label="t('grievances.detail.rateAria', { n })"
              @click="rating = n"
              ><ion-icon slot="icon-only" :icon="n <= rating ? star : starOutline"
            /></ion-button>
          </div>
          <ion-textarea
            v-model="feedback"
            :placeholder="t('grievances.detail.feedbackPlaceholder')"
            :auto-grow="true"
          />
          <ion-button expand="block" :disabled="busy" @click="confirm">{{
            t('grievances.detail.confirmClose')
          }}</ion-button>
          <ion-button expand="block" fill="outline" color="danger" :disabled="busy" @click="reopen">
            {{ t('grievances.detail.reopenNo') }}
          </ion-button>
        </ion-card-content>
      </ion-card>
      <ion-button
        v-else-if="ticket.status === 'closed' && (isRequester || ticket.canManage)"
        expand="block"
        fill="outline"
        :disabled="busy"
        @click="reopen"
        >{{ t('grievances.detail.reopenComplaint') }}</ion-button
      >

      <!-- Staff actions -->
      <ion-card v-if="ticket.canManage">
        <ion-card-header>
          <ion-card-title>{{ t('grievances.detail.manage') }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <ion-list>
            <ion-item>
              <ion-select
                :value="ticket.assignee?.id ?? null"
                :label="t('grievances.fields.assignee')"
                interface="popover"
                @ion-change="assign($event.detail.value)"
              >
                <ion-select-option :value="null">{{ t('grievances.unassigned') }}</ion-select-option>
                <ion-select-option v-for="a in assignees" :key="a.id" :value="a.id">{{
                  a.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                :value="ticket.priority"
                :label="t('grievances.fields.priority')"
                interface="popover"
                @ion-change="setPriority($event.detail.value)"
              >
                <ion-select-option v-for="p in GRIEVANCE_PRIORITIES" :key="p" :value="p">{{
                  t(priorityKey(p))
                }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-button
            v-for="s in nextStatuses"
            :key="s"
            size="small"
            :color="STATUS_TONES[s]"
            :disabled="busy"
            @click="changeStatus(s)"
            >{{ t(STATUS_ACTION_KEYS[s]) }}</ion-button
          >
        </ion-card-content>
      </ion-card>

      <!-- Attachments -->
      <ion-list v-if="ticket.attachments.length">
        <ion-list-header>
          <ion-label>{{ t('grievances.detail.attachments') }}</ion-label>
        </ion-list-header>
        <ion-item v-for="a in ticket.attachments" :key="a.id" button @click="openAttachment(a.id)">
          <ion-icon slot="start" :icon="attachOutline" />
          <ion-label>
            {{ a.originalName }}
            <p>
              {{ t('grievances.fileSize', { size: formatNumber(fileSizeKb(a.sizeBytes)) }) }} ·
              {{ formatDateTime(a.createdAt) }}
            </p>
          </ion-label>
          <StatusChip v-if="a.isInternal" slot="end" :label="t('grievances.internal')" tone="warning" />
        </ion-item>
      </ion-list>

      <!-- Timeline -->
      <ion-list>
        <ion-list-header>
          <ion-label>{{ t('grievances.detail.activity') }}</ion-label>
        </ion-list-header>
        <ion-item v-for="a in ticket.activities" :key="a.id" :class="{ internal: a.isInternal }">
          <ion-label class="ion-text-wrap">
            <h3>
              {{ a.author?.name ?? t('grievances.detail.system') }}
              <StatusChip v-if="a.isInternal" :label="t('grievances.detail.internalNote')" tone="warning" />
              <span class="muted"> · {{ activityTitle(a) }} · {{ formatDateTime(a.createdAt) }}</span>
            </h3>
            <p v-if="a.body" class="pre">{{ a.body }}</p>
          </ion-label>
        </ion-item>
      </ion-list>

      <!-- Reply -->
      <ion-card v-if="ticket.status !== 'closed'">
        <ion-card-content>
          <ion-textarea
            v-model="reply"
            :placeholder="
              internal ? t('grievances.detail.internalPlaceholder') : t('grievances.detail.replyPlaceholder')
            "
            :auto-grow="true"
            :rows="3"
          />
          <ion-checkbox v-if="ticket.canManage" v-model="internal">{{
            t('grievances.detail.internalToggle')
          }}</ion-checkbox>
          <input type="file" multiple @change="pickFiles" />
          <ion-button expand="block" :disabled="busy || (!reply.trim() && !files.length)" @click="send">{{
            t('common.actions.send')
          }}</ion-button>
        </ion-card-content>
      </ion-card>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { openFileLink } from '@/core/downloads';
import { formatDateTime, formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import {
  PRIORITY_TONES,
  STATUS_ACTION_KEYS,
  STATUS_TONES,
  fileSizeKb,
  grievancesApi,
  isOverdue,
  priorityKey,
  statusKey,
} from './api';

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id));
const ticket = ref<GrievanceTicketDetailDto | null>(null);
const assignees = ref<GrievanceUserRef[]>([]);
const reply = ref('');
const internal = ref(false);
const files = ref<File[]>([]);
const rating = ref(0);
const feedback = ref('');
const busy = ref(false);

const isRequester = computed(() => !!ticket.value && ticket.value.requester?.id === auth.me?.user.id);
const backHref = computed(() => (ticket.value?.canManage ? '/grievances' : '/grievances/my'));
const nextStatuses = computed<readonly GrievanceStatus[]>(() =>
  ticket.value ? GRIEVANCE_TRANSITIONS[ticket.value.status] : [],
);

function activityTitle(a: GrievanceActivityDto) {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  switch (a.type) {
    case 'status_change':
      return `${t(statusKey(String(m.from ?? '')))} → ${t(statusKey(String(m.to ?? '')))}`;
    case 'assignment':
      return t('grievances.activity.assignment');
    case 'escalation':
      return t('grievances.activity.escalation');
    case 'internal_note':
      return t('grievances.activity.internalNote');
    case 'reply':
      return t('grievances.activity.reply');
    default:
      return t('grievances.activity.system');
  }
}

async function load() {
  try {
    ticket.value = await grievancesApi.get(id.value);
    if (ticket.value.canManage && !assignees.value.length) assignees.value = await grievancesApi.assignees();
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
  }, t('grievances.detail.sent'));
}

const assign = (userId: number | null) => {
  if (userId === (ticket.value?.assignee?.id ?? null)) return;
  return run(() => grievancesApi.assign(id.value, userId), t('grievances.detail.assignmentUpdated'));
};
const setPriority = (priority: GrievancePriority) => {
  if (priority === ticket.value?.priority) return;
  return run(() => grievancesApi.update(id.value, { priority }), t('grievances.detail.priorityUpdated'));
};

async function prompt(header: string, placeholder: string, required: boolean): Promise<string | null> {
  const alert = await alertController.create({
    header,
    inputs: [{ name: 'text', type: 'textarea', placeholder }],
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      { text: t('grievances.detail.ok'), role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { text: string } }>();
  if (role !== 'confirm') return null;
  const text = data?.values.text?.trim() ?? '';
  if (required && !text) {
    await toast(t('grievances.detail.fieldRequired'), 'warning');
    return null;
  }
  return text;
}

async function changeStatus(status: GrievanceStatus) {
  if (status === 'resolved') {
    const notes = await prompt(
      t('grievances.detail.resolutionNotes'),
      t('grievances.detail.resolutionPlaceholder'),
      true,
    );
    if (notes === null) return;
    return run(
      () => grievancesApi.setStatus(id.value, { status, resolutionNotes: notes }),
      t('grievances.detail.markedResolved'),
    );
  }
  const note = await prompt(t(STATUS_ACTION_KEYS[status]), t('grievances.detail.notePlaceholder'), false);
  if (note === null) return;
  return run(
    () => grievancesApi.setStatus(id.value, { status, note: note || undefined }),
    t('grievances.detail.statusUpdated'),
  );
}

async function reopen() {
  const reason = await prompt(
    t('grievances.detail.reopenComplaint'),
    t('grievances.detail.reopenReason'),
    true,
  );
  if (reason === null) return;
  await run(() => grievancesApi.reopen(id.value, reason), t('grievances.detail.reopened'));
}

const confirm = () =>
  run(
    () =>
      grievancesApi.confirmClosure(id.value, {
        rating: rating.value || undefined,
        feedback: feedback.value.trim() || undefined,
      }),
    t('grievances.detail.thanks'),
  );

async function openAttachment(attachmentId: number) {
  try {
    const { url } = await grievancesApi.attachmentUrl(id.value, attachmentId);
    openFileLink(url);
  } catch (e) {
    await toastError(e);
  }
}

watch(id, (v) => v && load(), { immediate: true });
</script>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
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

<template>
  <AppPage
    :title="a ? t('appointments.detail.titleWithId', { id: a.id }) : t('appointments.detail.title')"
    :on-refresh="load"
    back-href="/appointments"
  >
    <template v-if="a">
      <ion-list>
        <ion-item>
          <ion-label class="ion-text-wrap">
            <h1>{{ meetingWhen(a) }}</h1>
            <p>
              <StatusChip :label="t(STATUS_LABEL_KEYS[a.status])" :tone="STATUS_TONES[a.status]" />
              {{ t(modeKey(a.mode)) }}
              <span v-if="a.rescheduleCount">
                ·
                {{
                  t('appointments.detail.rescheduledTimes', { n: a.rescheduleCount }, a.rescheduleCount)
                }}</span
              >
            </p>
          </ion-label>
        </ion-item>
        <ion-item>
          <ion-label class="ion-text-wrap">
            <p>{{ t('appointments.detail.student') }}</p>
            <h2>{{ a.studentName ?? `#${a.studentId}` }}</h2>
          </ion-label>
        </ion-item>
        <ion-item v-if="a.teacher">
          <ion-label
            ><p>{{ t('appointments.request.teacher') }}</p>
            <h2>{{ a.teacher.name }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.requestedBy">
          <ion-label
            ><p>{{ t('appointments.detail.requestedBy') }}</p>
            <h2>{{ a.requestedBy.name }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.agenda">
          <ion-label class="ion-text-wrap"
            ><p>{{ t('appointments.detail.agenda') }}</p>
            <h2>{{ a.agenda }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.location">
          <ion-label class="ion-text-wrap"
            ><p>{{ t('appointments.fields.location') }}</p>
            <h2>{{ a.location }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.meetingUrl && a.status === 'confirmed'" :href="a.meetingUrl" target="_blank" detail>
          <ion-icon slot="start" :icon="videocamOutline" />
          <ion-label>{{ t('appointments.detail.join') }}</ion-label>
        </ion-item>
        <ion-item v-if="calendarState">
          <ion-icon slot="start" :icon="calendarOutline" aria-hidden="true" />
          <ion-label class="ion-text-wrap">
            <p>{{ t('appointments.detail.googleCalendar') }}</p>
            <h2>{{ calendarState.title }}</h2>
            <p v-if="calendarState.detail">{{ calendarState.detail }}</p>
          </ion-label>
        </ion-item>
        <ion-item v-if="a.responseNote">
          <ion-label class="ion-text-wrap"
            ><p>{{ t('appointments.detail.teacherNote') }}</p>
            <h2>{{ a.responseNote }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.cancelReason">
          <ion-label class="ion-text-wrap"
            ><p>{{ t('appointments.detail.reason') }}</p>
            <h2>{{ a.cancelReason }}</h2></ion-label
          >
        </ion-item>
      </ion-list>

      <div class="ion-padding actions">
        <template v-if="isStaff && a.status === 'requested'">
          <ion-button color="success" @click="approve">{{ t('common.actions.approve') }}</ion-button>
          <ion-button color="danger" fill="outline" @click="withReason('reject')">{{
            t('common.actions.reject')
          }}</ion-button>
        </template>
        <ion-button v-if="active" fill="outline" @click="rescheduling = !rescheduling">{{
          t('appointments.detail.reschedule')
        }}</ion-button>
        <ion-button v-if="active" color="medium" fill="outline" @click="withReason('cancel')">{{
          t('appointments.detail.cancelMeeting')
        }}</ion-button>
        <template v-if="isStaff && a.status === 'confirmed'">
          <ion-button color="primary" @click="complete('completed')">{{
            t('appointments.detail.markHeld')
          }}</ion-button>
          <ion-button color="dark" fill="outline" @click="complete('no_show')">{{
            t('appointments.status.noShow')
          }}</ion-button>
        </template>
      </div>

      <ion-list v-if="rescheduling">
        <ion-list-header
          ><ion-label>{{ t('appointments.detail.newTime') }}</ion-label></ion-list-header
        >
        <template v-if="isStaff">
          <ion-item>
            <ion-input
              v-model="rs.date"
              type="date"
              :label="t('common.labels.date')"
              label-placement="stacked"
            />
            <ion-input
              v-model="rs.startTime"
              type="time"
              :label="t('appointments.detail.start')"
              label-placement="stacked"
            />
            <ion-input
              v-model="rs.endTime"
              type="time"
              :label="t('appointments.detail.end')"
              label-placement="stacked"
            />
          </ion-item>
        </template>
        <SlotPicker
          v-else-if="a.teacher"
          v-model="picked"
          :teacher-user-id="a.teacher.id"
          :student-id="a.studentId"
        />
        <ion-item>
          <ion-select v-model="rs.mode" :label="t('appointments.mode.label')" interface="popover">
            <ion-select-option value="online">{{ t('appointments.mode.online') }}</ion-select-option>
            <ion-select-option value="offline">{{ t('appointments.mode.offline') }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="rs.reason"
            :label="t('appointments.detail.reasonOptional')"
            label-placement="stacked"
            auto-grow
          />
        </ion-item>
        <div class="ion-padding">
          <ion-button expand="block" :disabled="busy" @click="reschedule">{{
            t('appointments.detail.saveNewTime')
          }}</ion-button>
        </div>
      </ion-list>

      <ion-list>
        <ion-list-header
          ><ion-label>{{ t('appointments.detail.notes') }}</ion-label></ion-list-header
        >
        <template v-if="isStaff">
          <ion-item>
            <ion-textarea
              v-model="notes.sharedSummary"
              :label="t('appointments.detail.sharedSummary')"
              label-placement="stacked"
              auto-grow
            />
          </ion-item>
          <ion-item>
            <ion-textarea
              v-model="notes.privateNotes"
              :label="t('appointments.detail.privateNotes')"
              label-placement="stacked"
              auto-grow
            />
          </ion-item>
          <div class="ion-padding">
            <ion-button expand="block" fill="outline" :disabled="busy" @click="saveNotes">{{
              t('appointments.detail.saveNotes')
            }}</ion-button>
          </div>
        </template>
        <ion-item v-else>
          <ion-label class="ion-text-wrap">
            {{ a.sharedSummary || t('appointments.detail.noSummary') }}
          </ion-label>
        </ion-item>
      </ion-list>

      <ion-list>
        <ion-list-header
          ><ion-label>{{ t('appointments.list.history') }}</ion-label></ion-list-header
        >
        <ion-item v-for="h in a.history" :key="h.id">
          <ion-label class="ion-text-wrap">
            <h3>
              {{ t(actionKey(h.action)) }}<span v-if="h.actor"> · {{ h.actor.name }}</span>
            </h3>
            <p>{{ formatDateTime(h.createdAt) }}</p>
            <p v-if="h.note">{{ h.note }}</p>
          </ion-label>
        </ion-item>
      </ion-list>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  alertController,
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  onIonViewWillEnter,
} from '@ionic/vue';
import { calendarOutline, videocamOutline } from 'ionicons/icons';
import type { AppointmentDetailDto, AppointmentMode, AvailableSlotDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { syncLabel } from '@/modules/calendar/api';
import { useAuthStore } from '@/stores/auth';
import SlotPicker from './components/SlotPicker.vue';
import { STATUS_LABEL_KEYS, STATUS_TONES, actionKey, appointmentsApi, meetingWhen, modeKey } from './api';

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id));
const a = ref<AppointmentDetailDto | null>(null);
const busy = ref(false);
const rescheduling = ref(false);
const picked = ref<AvailableSlotDto | null>(null);
const rs = reactive({ date: '', startTime: '', endTime: '', mode: 'offline' as AppointmentMode, reason: '' });
const notes = reactive({ sharedSummary: '', privateNotes: '' });

/** Teacher of this meeting, or staff who manage appointments (privateNotes is only returned to them). */
const isStaff = computed(
  () =>
    !!a.value &&
    auth.can('appointments.approve') &&
    (a.value.teacher?.id === auth.me?.user.id || a.value.privateNotes !== undefined),
);
const active = computed(() => !!a.value && ['requested', 'confirmed'].includes(a.value.status));
/** Returned to the teacher and appointment managers only; hidden with the test (mock) calendar. */
const calendarState = computed(() => syncLabel(a.value?.calendarSync));

async function load() {
  try {
    a.value = await appointmentsApi.get(id.value);
    Object.assign(rs, {
      date: a.value.date,
      startTime: a.value.startTime,
      endTime: a.value.endTime,
      mode: a.value.mode,
      reason: '',
    });
    notes.sharedSummary = a.value.sharedSummary ?? '';
    notes.privateNotes = a.value.privateNotes ?? '';
  } catch (e) {
    await toastError(e);
  }
}

async function run(fn: () => Promise<unknown>, message: string) {
  busy.value = true;
  try {
    await fn();
    await toast(message);
    rescheduling.value = false;
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function approve() {
  const online = a.value?.mode === 'online';
  const alert = await alertController.create({
    header: t('appointments.detail.approveTitle'),
    message: online ? t('appointments.detail.approveLinkHint') : undefined,
    inputs: [
      { name: 'note', type: 'textarea', placeholder: t('appointments.detail.notePlaceholder') },
      ...(a.value?.mode === 'offline'
        ? [
            {
              name: 'location',
              type: 'text' as const,
              placeholder: t('appointments.fields.location'),
              value: a.value.location ?? '',
            },
          ]
        : []),
      ...(online
        ? [
            {
              name: 'meetingUrl',
              type: 'url' as const,
              placeholder: t('appointments.detail.linkPlaceholder'),
            },
          ]
        : []),
    ],
    buttons: [
      { text: t('common.actions.back'), role: 'cancel' },
      {
        text: t('common.actions.approve'),
        handler: (v: { note?: string; location?: string; meetingUrl?: string }) => {
          const meetingUrl = v.meetingUrl?.trim() || null;
          if (meetingUrl && !/^https?:\/\/\S+$/i.test(meetingUrl)) {
            void toast(t('appointments.detail.invalidLink'), 'warning');
            return false;
          }
          void run(
            () =>
              appointmentsApi.approve(id.value, {
                note: v.note || null,
                location: v.location || undefined,
                ...(online ? { meetingUrl } : {}),
              }),
            t('appointments.detail.confirmed'),
          );
        },
      },
    ],
  });
  await alert.present();
}

async function withReason(kind: 'reject' | 'cancel') {
  const alert = await alertController.create({
    header: kind === 'reject' ? t('appointments.detail.rejectTitle') : t('appointments.detail.cancelMeeting'),
    inputs: [{ name: 'reason', type: 'textarea', placeholder: t('appointments.detail.reasonPlaceholder') }],
    buttons: [
      { text: t('common.actions.back'), role: 'cancel' },
      {
        text: kind === 'reject' ? t('common.actions.reject') : t('appointments.detail.cancelMeeting'),
        role: 'destructive',
        handler: (v: { reason?: string }) => {
          const reason = v.reason?.trim();
          if (!reason) {
            void toast(t('appointments.detail.reasonRequired'), 'warning');
            return false;
          }
          void run(
            () =>
              kind === 'reject'
                ? appointmentsApi.reject(id.value, reason)
                : appointmentsApi.cancel(id.value, reason),
            kind === 'reject' ? t('appointments.detail.rejected') : t('appointments.detail.cancelled'),
          );
        },
      },
    ],
  });
  await alert.present();
}

function reschedule() {
  const time = isStaff.value
    ? { date: rs.date, startTime: rs.startTime, endTime: rs.endTime || undefined }
    : picked.value
      ? { date: picked.value.date, startTime: picked.value.startTime }
      : null;
  if (!time) return void toast(t('appointments.detail.pickNewTime'), 'warning');
  void run(
    () => appointmentsApi.reschedule(id.value, { ...time, mode: rs.mode, reason: rs.reason || null }),
    isStaff.value ? t('appointments.detail.rescheduledToast') : t('appointments.detail.newTimeRequested'),
  );
}

function complete(outcome: 'completed' | 'no_show') {
  void run(
    () =>
      appointmentsApi.complete(id.value, {
        outcome,
        sharedSummary: notes.sharedSummary || null,
        privateNotes: notes.privateNotes || null,
      }),
    outcome === 'completed' ? t('appointments.detail.markedHeld') : t('appointments.detail.markedNoShow'),
  );
}

function saveNotes() {
  void run(
    () =>
      appointmentsApi.notes(id.value, {
        sharedSummary: notes.sharedSummary || null,
        privateNotes: notes.privateNotes || null,
      }),
    t('appointments.detail.notesSaved'),
  );
}

onIonViewWillEnter(load);
</script>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>

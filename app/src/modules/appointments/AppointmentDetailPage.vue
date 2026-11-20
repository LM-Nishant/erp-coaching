<template>
  <AppPage :title="a ? `Meeting #${a.id}` : 'Meeting'" :on-refresh="load" back-href="/appointments">
    <template v-if="a">
      <ion-list>
        <ion-item>
          <ion-label class="ion-text-wrap">
            <h1>{{ a.date }} · {{ a.startTime }}–{{ a.endTime }}</h1>
            <p>
              <ion-badge :color="STATUS_COLORS[a.status]">{{ humanize(a.status) }}</ion-badge>
              {{ a.mode === 'online' ? 'Online' : 'In person' }}
              <span v-if="a.rescheduleCount"> · rescheduled {{ a.rescheduleCount }}×</span>
            </p>
          </ion-label>
        </ion-item>
        <ion-item>
          <ion-label class="ion-text-wrap">
            <p>Student</p>
            <h2>{{ a.studentName ?? `#${a.studentId}` }}</h2>
          </ion-label>
        </ion-item>
        <ion-item v-if="a.teacher">
          <ion-label
            ><p>Teacher</p>
            <h2>{{ a.teacher.name }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.requestedBy">
          <ion-label
            ><p>Requested by</p>
            <h2>{{ a.requestedBy.name }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.agenda">
          <ion-label class="ion-text-wrap"
            ><p>Agenda</p>
            <h2>{{ a.agenda }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.location">
          <ion-label class="ion-text-wrap"
            ><p>Location</p>
            <h2>{{ a.location }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.meetingUrl && a.status === 'confirmed'" :href="a.meetingUrl" target="_blank" detail>
          <ion-icon slot="start" :icon="videocamOutline" />
          <ion-label>Join online meeting</ion-label>
        </ion-item>
        <ion-item v-if="calendarState">
          <ion-icon slot="start" :icon="calendarOutline" aria-hidden="true" />
          <ion-label class="ion-text-wrap">
            <p>Google Calendar</p>
            <h2>{{ calendarState.title }}</h2>
            <p v-if="calendarState.detail">{{ calendarState.detail }}</p>
          </ion-label>
        </ion-item>
        <ion-item v-if="a.responseNote">
          <ion-label class="ion-text-wrap"
            ><p>Teacher's note</p>
            <h2>{{ a.responseNote }}</h2></ion-label
          >
        </ion-item>
        <ion-item v-if="a.cancelReason">
          <ion-label class="ion-text-wrap"
            ><p>Reason</p>
            <h2>{{ a.cancelReason }}</h2></ion-label
          >
        </ion-item>
      </ion-list>

      <div class="ion-padding actions">
        <template v-if="isStaff && a.status === 'requested'">
          <ion-button color="success" @click="approve">Approve</ion-button>
          <ion-button color="danger" fill="outline" @click="withReason('reject')">Reject</ion-button>
        </template>
        <ion-button v-if="active" fill="outline" @click="rescheduling = !rescheduling">Reschedule</ion-button>
        <ion-button v-if="active" color="medium" fill="outline" @click="withReason('cancel')"
          >Cancel meeting</ion-button
        >
        <template v-if="isStaff && a.status === 'confirmed'">
          <ion-button color="primary" @click="complete('completed')">Mark held</ion-button>
          <ion-button color="dark" fill="outline" @click="complete('no_show')">No-show</ion-button>
        </template>
      </div>

      <ion-list v-if="rescheduling">
        <ion-list-header><ion-label>New time</ion-label></ion-list-header>
        <template v-if="isStaff">
          <ion-item>
            <ion-input v-model="rs.date" type="date" label="Date" label-placement="stacked" />
            <ion-input v-model="rs.startTime" type="time" label="Start" label-placement="stacked" />
            <ion-input v-model="rs.endTime" type="time" label="End" label-placement="stacked" />
          </ion-item>
        </template>
        <SlotPicker
          v-else-if="a.teacher"
          v-model="picked"
          :teacher-user-id="a.teacher.id"
          :student-id="a.studentId"
        />
        <ion-item>
          <ion-select v-model="rs.mode" label="Mode" interface="popover">
            <ion-select-option value="online">Online</ion-select-option>
            <ion-select-option value="offline">In person</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-textarea v-model="rs.reason" label="Reason (optional)" label-placement="stacked" auto-grow />
        </ion-item>
        <div class="ion-padding">
          <ion-button expand="block" :disabled="busy" @click="reschedule">Save new time</ion-button>
        </div>
      </ion-list>

      <ion-list>
        <ion-list-header><ion-label>Meeting notes</ion-label></ion-list-header>
        <template v-if="isStaff">
          <ion-item>
            <ion-textarea
              v-model="notes.sharedSummary"
              label="Summary shared with the parent"
              label-placement="stacked"
              auto-grow
            />
          </ion-item>
          <ion-item>
            <ion-textarea
              v-model="notes.privateNotes"
              label="Private notes (staff only)"
              label-placement="stacked"
              auto-grow
            />
          </ion-item>
          <div class="ion-padding">
            <ion-button expand="block" fill="outline" :disabled="busy" @click="saveNotes"
              >Save notes</ion-button
            >
          </div>
        </template>
        <ion-item v-else>
          <ion-label class="ion-text-wrap">
            {{ a.sharedSummary || 'The teacher has not shared a summary yet.' }}
          </ion-label>
        </ion-item>
      </ion-list>

      <ion-list>
        <ion-list-header><ion-label>History</ion-label></ion-list-header>
        <ion-item v-for="h in a.history" :key="h.id">
          <ion-label class="ion-text-wrap">
            <h3>
              {{ humanize(h.action) }}<span v-if="h.actor"> · {{ h.actor.name }}</span>
            </h3>
            <p>{{ new Date(h.createdAt).toLocaleString() }}</p>
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
import {
  alertController,
  IonBadge,
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
import { toast, toastError } from '@/core/toast';
import { syncLabel } from '@/modules/calendar/api';
import { useAuthStore } from '@/stores/auth';
import SlotPicker from './components/SlotPicker.vue';
import { appointmentsApi, STATUS_COLORS, humanize } from './api';

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
    header: 'Approve meeting',
    message: online ? 'Leave the meeting link blank to get a video meeting link automatically.' : undefined,
    inputs: [
      { name: 'note', type: 'textarea', placeholder: 'Note to the parent (optional)' },
      ...(a.value?.mode === 'offline'
        ? [
            {
              name: 'location',
              type: 'text' as const,
              placeholder: 'Location',
              value: a.value.location ?? '',
            },
          ]
        : []),
      ...(online
        ? [{ name: 'meetingUrl', type: 'url' as const, placeholder: 'Meeting link (optional)' }]
        : []),
    ],
    buttons: [
      { text: 'Back', role: 'cancel' },
      {
        text: 'Approve',
        handler: (v: { note?: string; location?: string; meetingUrl?: string }) => {
          const meetingUrl = v.meetingUrl?.trim() || null;
          if (meetingUrl && !/^https?:\/\/\S+$/i.test(meetingUrl)) {
            void toast('Enter the full meeting link, starting with https://', 'warning');
            return false;
          }
          void run(
            () =>
              appointmentsApi.approve(id.value, {
                note: v.note || null,
                location: v.location || undefined,
                ...(online ? { meetingUrl } : {}),
              }),
            'Meeting confirmed',
          );
        },
      },
    ],
  });
  await alert.present();
}

async function withReason(kind: 'reject' | 'cancel') {
  const alert = await alertController.create({
    header: kind === 'reject' ? 'Reject request' : 'Cancel meeting',
    inputs: [{ name: 'reason', type: 'textarea', placeholder: 'Reason (shared with the other side)' }],
    buttons: [
      { text: 'Back', role: 'cancel' },
      {
        text: kind === 'reject' ? 'Reject' : 'Cancel meeting',
        role: 'destructive',
        handler: (v: { reason?: string }) => {
          const reason = v.reason?.trim();
          if (!reason) {
            void toast('Please give a reason', 'warning');
            return false;
          }
          void run(
            () =>
              kind === 'reject'
                ? appointmentsApi.reject(id.value, reason)
                : appointmentsApi.cancel(id.value, reason),
            kind === 'reject' ? 'Request rejected' : 'Meeting cancelled',
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
  if (!time) return void toast('Pick a new time', 'warning');
  void run(
    () => appointmentsApi.reschedule(id.value, { ...time, mode: rs.mode, reason: rs.reason || null }),
    isStaff.value ? 'Meeting rescheduled' : 'New time requested',
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
    outcome === 'completed' ? 'Marked as held' : 'Marked as no-show',
  );
}

function saveNotes() {
  void run(
    () =>
      appointmentsApi.notes(id.value, {
        sharedSummary: notes.sharedSummary || null,
        privateNotes: notes.privateNotes || null,
      }),
    'Notes saved',
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

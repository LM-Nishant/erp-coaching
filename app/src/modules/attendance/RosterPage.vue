<template>
  <AppPage :title="title" back-href="/attendance" :on-refresh="load">
    <template #actions>
      <ion-button
        v-if="open && hasQr"
        v-can="'attendance.create'"
        :router-link="`/attendance/sessions/${id}/qr`"
        ><ion-icon slot="icon-only" :icon="qrCodeOutline"
      /></ion-button>
    </template>

    <template v-if="data">
      <div class="summary">
        <ion-chip
          v-for="s in ATTENDANCE_STATUSES"
          :key="s"
          :color="STATUS_COLOR[s]"
          @click="filter = filter === s ? null : s"
        >
          {{ STATUS_LABEL[s] }} {{ tally[s] }}
        </ion-chip>
        <ion-chip :outline="true" @click="filter = filter === 'unmarked' ? null : 'unmarked'"
          >Unmarked {{ tally.unmarked }}</ion-chip
        >
      </div>
      <ion-searchbar v-model="search" placeholder="Search students" :debounce="0" />

      <ion-list>
        <ion-item v-for="r in visible" :key="r.studentUserId" lines="full">
          <ion-label>
            <h3>{{ r.name }}</h3>
            <p>
              <span v-if="r.onLeave">On approved leave · </span>
              <span v-if="current(r) && r.source">{{ sourceLabel(r) }}</span>
            </p>
          </ion-label>
          <div slot="end" class="marks">
            <ion-button
              v-for="s in quick"
              :key="s"
              size="small"
              :fill="current(r) === s ? 'solid' : 'outline'"
              :color="STATUS_COLOR[s]"
              :disabled="!editable"
              @click="set(r, s)"
              >{{ STATUS_SHORT[s] }}</ion-button
            >
          </div>
        </ion-item>
      </ion-list>

      <div class="actions">
        <template v-if="editable">
          <ion-button expand="block" fill="outline" @click="markRest('present')"
            >Mark unmarked present</ion-button
          >
          <ion-button expand="block" :disabled="saving || !dirtyCount" @click="save"
            >Save {{ dirtyCount ? `(${dirtyCount})` : '' }}</ion-button
          >
          <ion-button v-if="open" expand="block" color="dark" :disabled="saving" @click="close"
            >Close &amp; mark rest absent</ion-button
          >
        </template>
        <ion-button v-if="!open" v-can="'attendance.edit'" expand="block" fill="outline" @click="reopen"
          >Reopen session</ion-button
        >
      </div>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  alertController,
  IonButton,
  IonChip,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
} from '@ionic/vue';
import { qrCodeOutline } from 'ionicons/icons';
import {
  ATTENDANCE_STATUSES,
  type AttendanceRosterDto,
  type AttendanceSettingsDto,
  type AttendanceStatus,
  type RosterEntryDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { STATUS_COLOR, STATUS_LABEL, STATUS_SHORT, attendanceApi } from './api';

const route = useRoute();
const auth = useAuthStore();
const id = Number(route.params.id);
const data = ref<AttendanceRosterDto | null>(null);
const settings = ref<AttendanceSettingsDto | null>(null);
/** Unsaved marks keyed by student user id. */
const pending = ref<Record<number, AttendanceStatus>>({});
const search = ref('');
const filter = ref<AttendanceStatus | 'unmarked' | null>(null);
const saving = ref(false);
const quick: AttendanceStatus[] = ['present', 'absent', 'late', 'half_day', 'leave'];

const open = computed(() => data.value?.session.status === 'open');
const editable = computed(() => open.value || auth.can('attendance.edit'));
const hasQr = computed(() => settings.value?.methods.includes('qr') ?? false);
const title = computed(() => {
  const s = data.value?.session;
  if (!s) return 'Attendance';
  return [s.batchName, s.subjectName, s.date].filter(Boolean).join(' · ');
});
const current = (r: RosterEntryDto) => pending.value[r.studentUserId] ?? r.status;
const dirtyCount = computed(() => Object.keys(pending.value).length);
const tally = computed(() => {
  const t: Record<string, number> = { unmarked: 0 };
  for (const s of ATTENDANCE_STATUSES) t[s] = 0;
  for (const r of data.value?.roster ?? []) {
    const c = current(r);
    t[c ?? 'unmarked']++;
  }
  return t;
});
const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (data.value?.roster ?? []).filter(
    (r) =>
      (!q || r.name.toLowerCase().includes(q)) &&
      (!filter.value || (current(r) ?? 'unmarked') === filter.value),
  );
});
const sourceLabel = (r: RosterEntryDto) =>
  pending.value[r.studentUserId] ? 'unsaved' : r.source === 'manual' ? '' : `via ${r.source}`;

function set(r: RosterEntryDto, s: AttendanceStatus) {
  if (r.status === s) delete pending.value[r.studentUserId];
  else pending.value[r.studentUserId] = s;
}
function markRest(s: AttendanceStatus) {
  for (const r of data.value?.roster ?? []) if (!current(r)) pending.value[r.studentUserId] = s;
}

async function load() {
  try {
    data.value = await attendanceApi.session(id);
    pending.value = {};
  } catch (e) {
    await toastError(e);
  }
}

async function save() {
  saving.value = true;
  try {
    const records = Object.entries(pending.value).map(([sid, status]) => ({
      studentUserId: Number(sid),
      status,
    }));
    const res = await attendanceApi.mark(id, records);
    data.value = { session: res.session, roster: res.roster };
    pending.value = {};
    await toast(`Saved ${res.saved} mark(s)`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function close() {
  const a = await alertController.create({
    header: 'Close attendance?',
    message: `${tally.value.unmarked} unmarked student(s) will be marked absent and parents alerted.`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Close', role: 'confirm' },
    ],
  });
  await a.present();
  if ((await a.onDidDismiss()).role !== 'confirm') return;
  saving.value = true;
  try {
    if (dirtyCount.value) await save();
    data.value = await attendanceApi.close(id);
    await toast('Attendance closed');
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function reopen() {
  try {
    await attendanceApi.reopen(id);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(async () => {
  await load();
  settings.value = await attendanceApi.settings().catch(() => null);
});
</script>

<style scoped>
.summary {
  display: flex;
  flex-wrap: wrap;
  padding: 8px 8px 0;
}
.marks ion-button {
  --padding-start: 8px;
  --padding-end: 8px;
  margin-left: 2px;
  min-width: 34px;
}
.actions {
  padding: 8px 16px 24px;
}
</style>

<template>
  <AppPage :title="title" back-href="/attendance" :on-refresh="load">
    <template #actions>
      <ion-button
        v-if="open && hasQr"
        v-can="'attendance.create'"
        :router-link="`/attendance/sessions/${id}/qr`"
        :aria-label="t('attendance.roster.showQr')"
        ><ion-icon slot="icon-only" :icon="qrCodeOutline"
      /></ion-button>
    </template>

    <template v-if="data">
      <p class="lead">
        {{ when }}
        <template v-if="editable && open">
          · {{ start ? t('attendance.roster.tapHint') : t('attendance.roster.tapHintPresent') }}</template
        >
      </p>
      <ion-button
        v-if="editable && open && !start && counts.unmarked"
        class="mark-rest"
        fill="outline"
        expand="block"
        @click="markRest"
      >
        <ion-icon slot="start" :icon="checkmarkDoneOutline" />
        {{ t('attendance.roster.markRest', { n: counts.unmarked }) }}
      </ion-button>
      <div v-if="!open" class="submitted">
        <StatusChip tone="success" :icon="checkmarkCircle" :label="t('attendance.roster.submitted')" />
        <span v-if="data.session.closedAt" class="muted">{{ formatDateTime(data.session.closedAt) }}</span>
      </div>

      <div class="summary" role="group" :aria-label="t('attendance.roster.summary')">
        <button
          v-for="c in chips"
          :key="c.key"
          type="button"
          :class="['count', c.tone, { active: filter === c.key }]"
          :aria-pressed="filter === c.key"
          @click="filter = filter === c.key ? null : c.key"
        >
          <strong>{{ c.count }}</strong> {{ c.label }}
        </button>
      </div>
      <ion-searchbar
        v-if="data.roster.length > 12"
        v-model="search"
        :placeholder="t('attendance.roster.search')"
        :debounce="0"
      />

      <EmptyState
        v-if="!data.roster.length"
        :icon="peopleOutline"
        :title="t('attendance.roster.emptyTitle')"
        :message="t('attendance.roster.emptyMessage')"
      />
      <ul v-else class="roster">
        <li v-for="r in visible" :key="r.studentUserId" class="row" :data-student="r.name">
          <button
            type="button"
            class="who"
            :disabled="!editable"
            :aria-label="`${r.name}: ${label(shown(r))}`"
            @click="tap(r)"
          >
            <span class="name">{{ r.name }}</span>
            <span v-if="note(r)" class="note">{{ note(r) }}</span>
          </button>
          <StatusChip :tone="tone(shown(r))" :icon="icon(shown(r))" :label="label(shown(r))" />
          <button
            v-if="editable"
            type="button"
            class="more"
            :aria-label="t('attendance.roster.moreFor', { name: r.name })"
            @click="choose(r)"
          >
            <ion-icon :icon="ellipsisVertical" aria-hidden="true" />
          </button>
        </li>
      </ul>

      <div v-if="editable || canReopen" class="footer">
        <template v-if="editable && open">
          <ion-button expand="block" size="large" :disabled="saving" @click="submit">{{
            submitLabel
          }}</ion-button>
          <ion-button
            v-if="!start && toSave.length"
            expand="block"
            fill="clear"
            :disabled="saving"
            @click="save"
            >{{ t('attendance.roster.saveForNow', { n: toSave.length }) }}</ion-button
          >
          <p v-if="settings?.absentAlerts" class="muted center">
            {{ t('attendance.roster.parentsAlerted') }}
          </p>
        </template>
        <ion-button
          v-else-if="editable && toSave.length"
          expand="block"
          size="large"
          :disabled="saving"
          @click="save"
          >{{ t('attendance.roster.saveChanges', { n: toSave.length }) }}</ion-button
        >
        <ion-button v-if="canReopen" expand="block" fill="outline" @click="reopen">{{
          t('attendance.roster.reopen')
        }}</ion-button>
      </div>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { actionSheetController, alertController, IonButton, IonIcon, IonSearchbar } from '@ionic/vue';
import {
  alarmOutline,
  checkmarkCircle,
  closeCircle,
  ellipsisVertical,
  peopleOutline,
  qrCodeOutline,
  airplaneOutline,
  timeOutline,
  checkmarkDoneOutline,
} from 'ionicons/icons';
import type {
  AttendanceRosterDto,
  AttendanceSettingsDto,
  AttendanceStatus,
  RosterEntryDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime, formatDayShort, formatTime } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { attendanceApi } from './api';
import { changes, clock, setPending, shownStatus, startStatus, tally, tapped, type Pending } from './roster';

type Tone = 'success' | 'warning' | 'danger' | 'primary' | 'medium';
const ORDER: AttendanceStatus[] = ['present', 'absent', 'late', 'half_day', 'leave'];
const TONE: Record<AttendanceStatus, Tone> = {
  present: 'success',
  absent: 'danger',
  late: 'warning',
  half_day: 'warning',
  leave: 'primary',
};
const ICON: Record<AttendanceStatus, string> = {
  present: checkmarkCircle,
  absent: closeCircle,
  late: alarmOutline,
  half_day: timeOutline,
  leave: airplaneOutline,
};

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const id = Number(route.params.id);
const data = ref<AttendanceRosterDto | null>(null);
const settings = ref<AttendanceSettingsDto | null>(null);
const pending = ref<Pending>({});
const search = ref('');
const filter = ref<AttendanceStatus | 'unmarked' | null>(null);
const saving = ref(false);

const open = computed(() => data.value?.session.status === 'open');
const editable = computed(() => open.value || auth.can('attendance.edit'));
const canReopen = computed(() => !open.value && auth.can('attendance.edit'));
const hasQr = computed(() => settings.value?.methods.includes('qr') ?? false);
/** Start defaults only apply while the roll call is open; a closed session has every mark saved. */
const start = computed(() => (open.value ? startStatus(settings.value?.methods) : null));
const roster = computed(() => data.value?.roster ?? []);
const shown = (r: RosterEntryDto) => shownStatus(r, pending.value, start.value);
const counts = computed(() => tally(roster.value, pending.value, start.value));
const toSave = computed(() => changes(roster.value, pending.value, start.value));

const label = (s: AttendanceStatus | null) => t(`attendance.status.${s ?? 'unmarked'}`);
const tone = (s: AttendanceStatus | null): Tone => (s ? TONE[s] : 'medium');
const icon = (s: AttendanceStatus | null) => (s ? ICON[s] : undefined);

const title = computed(() => {
  const s = data.value?.session;
  if (!s) return t('attendance.roster.title');
  return [s.subjectName, s.batchName].filter(Boolean).join(' · ') || t('attendance.roster.title');
});
const when = computed(() => {
  const s = data.value?.session;
  if (!s) return '';
  const time = clock(s.startTime, (d) => formatTime(d));
  return [formatDayShort(s.date), time].filter(Boolean).join(' · ');
});
const chips = computed(() => {
  const c = counts.value;
  const list: { key: AttendanceStatus | 'unmarked'; count: number; label: string; tone: Tone }[] =
    ORDER.filter((s) => s === 'present' || s === 'absent' || c[s] > 0).map((s) => ({
      key: s,
      count: c[s],
      label: label(s),
      tone: TONE[s],
    }));
  if (c.unmarked) list.push({ key: 'unmarked', count: c.unmarked, label: label(null), tone: 'medium' });
  return list;
});
const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return roster.value.filter(
    (r) =>
      (!q || r.name.toLowerCase().includes(q)) &&
      (!filter.value || (shown(r) ?? 'unmarked') === filter.value),
  );
});
const submitLabel = computed(() => {
  const c = counts.value;
  const parts = [
    t('attendance.roster.nPresent', { n: c.present + c.late + c.half_day }),
    t('attendance.roster.nAbsent', { n: c.absent }),
  ];
  if (c.unmarked) parts.push(t('attendance.roster.nUnmarked', { n: c.unmarked }));
  return `${t('attendance.roster.submit')} · ${parts.join(', ')}`;
});

function note(r: RosterEntryDto) {
  if (pending.value[r.studentUserId]) return '';
  if (r.onLeave) return t('attendance.roster.onApprovedLeave');
  if (r.status && r.source && r.source !== 'manual' && r.source !== 'system')
    return t(`attendance.roster.via.${r.source}`);
  return '';
}

/** Self check-in roll call: everyone not marked yet is here (on approved leave: leave); then tap the absentees. */
function markRest() {
  for (const r of roster.value)
    if (!shown(r)) pending.value = setPending(pending.value, r, r.onLeave ? 'leave' : 'present');
}

function tap(r: RosterEntryDto) {
  if (!editable.value) return;
  pending.value = setPending(pending.value, r, tapped(shown(r)));
}

async function choose(r: RosterEntryDto) {
  const sheet = await actionSheetController.create({
    header: r.name,
    buttons: [
      ...ORDER.map((s) => ({ text: label(s), data: s })),
      { text: t('attendance.roster.cancel'), role: 'cancel' },
    ],
  });
  await sheet.present();
  const { data: s, role } = await sheet.onDidDismiss<AttendanceStatus>();
  if (role !== 'cancel' && s) pending.value = setPending(pending.value, r, s);
}

async function load() {
  try {
    data.value = await attendanceApi.session(id);
    pending.value = {};
  } catch (e) {
    await toastError(e);
  }
}

async function saveMarks() {
  const res = await attendanceApi.mark(id, toSave.value);
  data.value = { session: res.session, roster: res.roster };
  pending.value = {};
  return res.saved;
}

async function save() {
  saving.value = true;
  try {
    const n = await saveMarks();
    await toast(t('attendance.roster.saved', { n }, n));
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function submit() {
  const unmarked = counts.value.unmarked;
  if (unmarked) {
    const a = await alertController.create({
      header: t('attendance.roster.confirmTitle'),
      message: t('attendance.roster.confirmUnmarked', { n: unmarked }, unmarked),
      buttons: [
        { text: t('attendance.roster.cancel'), role: 'cancel' },
        { text: t('attendance.roster.submit'), role: 'confirm' },
      ],
    });
    await a.present();
    if ((await a.onDidDismiss()).role !== 'confirm') return;
  }
  saving.value = true;
  try {
    if (toSave.value.length) await saveMarks();
    data.value = await attendanceApi.close(id);
    filter.value = null;
    await toast(t('attendance.roster.submittedToast'));
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
  // Settings first: they decide whether unmarked students start as present.
  settings.value = await attendanceApi.settings().catch(() => null);
  await load();
});
</script>

<style scoped>
.lead {
  margin: 0 0 8px;
  color: var(--ion-color-medium-shade);
}
.submitted {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.count {
  min-height: var(--app-tap-target);
  padding: 4px 14px;
  border: 2px solid transparent;
  border-radius: 12px;
  font: inherit;
  font-size: 15px;
  cursor: pointer;
  background: rgba(var(--ion-color-medium-rgb), 0.15);
  color: var(--ion-color-medium-shade);
}
.count.success {
  background: rgba(var(--ion-color-success-rgb), 0.15);
  color: var(--ion-color-success-shade);
}
.count.danger {
  background: rgba(var(--ion-color-danger-rgb), 0.12);
  color: var(--ion-color-danger-shade);
}
.count.warning {
  background: rgba(var(--ion-color-warning-rgb), 0.18);
  color: var(--ion-color-warning-shade);
}
.count.primary {
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary-shade);
}
.count.active {
  border-color: currentColor;
}
.roster {
  list-style: none;
  margin: 0;
  padding: 0;
  border-radius: 14px;
  background: var(--ion-card-background, var(--ion-item-background, #fff));
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 0 16px;
  border-bottom: 1px solid var(--ion-border-color, rgba(0, 0, 0, 0.08));
}
.row:last-child {
  border-bottom: 0;
}
.who {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  min-height: 56px;
  padding: 6px 0;
  border: 0;
  background: none;
  color: var(--ion-text-color);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.who:disabled {
  cursor: default;
}
.name {
  font-size: 17px;
}
.note {
  font-size: 13px;
  color: var(--ion-color-medium-shade);
}
.more {
  width: var(--app-tap-target);
  height: var(--app-tap-target);
  border: 0;
  background: none;
  color: var(--ion-color-medium);
  font-size: 20px;
  cursor: pointer;
}
.mark-rest {
  --border-radius: 12px;
  min-height: var(--app-tap-target);
  margin: 0 0 12px;
  text-transform: none;
}
.footer ion-button {
  text-transform: none;
  letter-spacing: normal;
}
.footer {
  position: sticky;
  bottom: 0;
  padding: 12px 0 8px;
  background: var(--ion-background-color, #fff);
}
.center {
  text-align: center;
  margin: 4px 0 0;
}
</style>

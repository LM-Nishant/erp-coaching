<template>
  <AppPage :title="t('attendance.day.title')" :on-refresh="load">
    <template #actions>
      <ion-button
        v-can="'attendance.view'"
        router-link="/attendance/requests"
        :aria-label="t('attendance.day.requests')"
        ><ion-icon slot="icon-only" :icon="documentTextOutline"
      /></ion-button>
    </template>
    <div class="dates">
      <button
        v-for="d in quickDates"
        :key="d.value"
        type="button"
        :class="['day', { active: date === d.value }]"
        :aria-pressed="date === d.value"
        @click="pick(d.value)"
      >
        {{ d.label }}
      </button>
      <ion-item class="date" lines="none">
        <ion-input
          v-model="date"
          type="date"
          :label="t('attendance.day.date')"
          label-placement="stacked"
          @ion-change="load"
        />
      </ion-item>
    </div>

    <EmptyState
      v-if="day && !day.items.length"
      :icon="calendarOutline"
      :title="day.mode === 'daily' ? t('attendance.day.noBatches') : t('attendance.day.noClasses')"
      :message="t('attendance.day.emptyHint')"
    />
    <ion-list v-if="day && day.items.length" class="classes" lines="full">
      <ion-item v-for="it in day.items" :key="key(it)" button :detail="true" @click="open(it)">
        <div slot="start" class="time">
          <strong>{{ clock(it.startTime, (d) => formatTime(d)) || '—' }}</strong>
          <span v-if="it.endTime">{{ clock(it.endTime, (d) => formatTime(d)) }}</span>
        </div>
        <ion-label>
          <h3>{{ [it.subjectName, it.batchName].filter(Boolean).join(' · ') }}</h3>
          <p v-if="it.attendance">{{ countsText(it) }}</p>
          <p v-else-if="isNow(it)" class="now">{{ t('attendance.day.happeningNow') }}</p>
        </ion-label>
        <StatusChip slot="end" :tone="badge(it).tone" :label="badge(it).text" />
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { IonButton, IonIcon, IonInput, IonItem, IonLabel, IonList } from '@ionic/vue';
import { calendarOutline, documentTextOutline } from 'ionicons/icons';
import type { AttendanceDayDto, AttendanceDayItemDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatTime } from '@/core/format';
import { toastError } from '@/core/toast';
import { attendanceApi, localDate } from './api';
import { clock } from './roster';

const { t } = useI18n();
const router = useRouter();
const today = localDate();
const date = ref(today);
const day = ref<AttendanceDayDto | null>(null);

const quickDates = computed(() => [
  { value: today, label: t('attendance.day.today') },
  { value: localDate(new Date(Date.now() - 86_400_000)), label: t('attendance.day.yesterday') },
]);

const key = (it: AttendanceDayItemDto) => it.classSessionId ?? `b${it.batchId}`;
const badge = (it: AttendanceDayItemDto): { text: string; tone: 'medium' | 'success' | 'warning' } =>
  !it.attendance
    ? { text: t('attendance.day.notStarted'), tone: 'medium' }
    : it.attendance.status === 'closed'
      ? { text: t('attendance.day.submitted'), tone: 'success' }
      : { text: t('attendance.day.inProgress'), tone: 'warning' };

function countsText(it: AttendanceDayItemDto) {
  const c = it.attendance?.counts ?? {};
  return [
    t('attendance.roster.nPresent', { n: (c.present ?? 0) + (c.late ?? 0) + (c.half_day ?? 0) }),
    t('attendance.roster.nAbsent', { n: c.absent ?? 0 }),
    c.leave ? t('attendance.day.nLeave', { n: c.leave }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function isNow(it: AttendanceDayItemDto) {
  if (date.value !== today || !it.startTime || !it.endTime) return false;
  const now = new Date().toTimeString().slice(0, 5);
  return it.startTime.slice(0, 5) <= now && now < it.endTime.slice(0, 5);
}

function pick(value: string) {
  date.value = value;
  void load();
}

async function load() {
  try {
    day.value = await attendanceApi.day(date.value);
  } catch (e) {
    await toastError(e);
  }
}

async function open(it: AttendanceDayItemDto) {
  try {
    const id =
      it.attendance?.id ??
      (
        await attendanceApi.openSession(
          it.classSessionId
            ? { classSessionId: it.classSessionId }
            : { batchId: it.batchId, date: date.value },
        )
      ).session.id;
    await router.push(`/attendance/sessions/${id}`);
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>

<style scoped>
.dates {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.day {
  min-height: var(--app-tap-target);
  padding: 0 18px;
  border: 1px solid var(--ion-color-medium-tint);
  border-radius: 24px;
  background: none;
  color: var(--ion-text-color);
  font: inherit;
  cursor: pointer;
}
.day.active {
  border-color: var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary-shade);
  font-weight: 600;
}
.date {
  flex: 1;
  min-width: 160px;
  --background: transparent;
}
.classes ion-item {
  --min-height: 72px;
}
.time {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 64px;
  font-size: 13px;
  color: var(--ion-color-medium-shade);
}
.time strong {
  font-size: 15px;
  color: var(--ion-text-color);
}
.now {
  color: var(--ion-color-primary) !important;
  font-weight: 600;
}
</style>

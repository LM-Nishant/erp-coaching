<template>
  <div class="today">
    <div v-if="!day" class="skeleton" aria-hidden="true" />
    <EmptyState
      v-else-if="!day.items.length"
      :icon="cafeOutline"
      :title="t('attendance.today.noClasses')"
      :message="t('attendance.today.noClassesHint')"
    />
    <template v-else>
      <section v-if="focus" class="hero" :class="focus.when">
        <p class="when">
          {{ t(`attendance.today.${focus.when}`) }}
          <template v-if="focus.item.startTime">
            · {{ clock(focus.item.startTime, fmt)
            }}<template v-if="focus.item.endTime"> – {{ clock(focus.item.endTime, fmt) }}</template>
          </template>
        </p>
        <h2 class="what">{{ name(focus.item) }}</h2>
        <p v-if="focus.item.attendance" class="sub">{{ attendanceText(focus.item) }}</p>
        <div class="buttons">
          <button type="button" class="primary" :disabled="busy" @click="takeAttendance(focus.item)">
            <ion-icon :icon="checkmarkDoneOutline" aria-hidden="true" />
            {{
              focus.item.attendance?.status === 'closed'
                ? t('attendance.today.viewAttendance')
                : t('attendance.today.takeAttendance')
            }}
          </button>
          <button
            v-if="liveAction(focus.item)"
            type="button"
            class="secondary"
            :disabled="busy"
            @click="goLive(focus.item)"
          >
            <ion-icon :icon="videocamOutline" aria-hidden="true" />
            {{ liveAction(focus.item) }}
          </button>
        </div>
      </section>

      <ul v-if="others.length" class="others">
        <li v-for="it in others" :key="key(it)">
          <button type="button" class="row" @click="takeAttendance(it)">
            <span class="time">{{ clock(it.startTime, fmt) || '—' }}</span>
            <span class="name">{{ name(it) }}</span>
            <StatusChip :tone="chip(it).tone" :label="chip(it).text" />
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { alertController, IonIcon, useIonRouter } from '@ionic/vue';
import { cafeOutline, checkmarkDoneOutline, videocamOutline } from 'ionicons/icons';
import type { AttendanceDayDto, AttendanceDayItemDto, LiveSessionDto } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatTime } from '@/core/format';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { liveApi } from '@/modules/live-classes/api';
import { attendanceApi, localDate } from '../api';
import { clock } from '../roster';
import { focusClass, liveFor } from '../today';

const { t } = useI18n();
const auth = useAuthStore();
const router = useIonRouter();
const date = localDate();
const day = ref<AttendanceDayDto | null>(null);
const live = ref<LiveSessionDto[]>([]);
const busy = ref(false);
const fmt = (d: Date) => formatTime(d);

const liveEnabled = computed(() => auth.can('live-classes.view') && auth.moduleEnabled('live-classes'));
const focus = computed(() =>
  day.value ? focusClass(day.value.items, new Date().toTimeString().slice(0, 5)) : null,
);
const others = computed(() => (day.value?.items ?? []).filter((i) => i !== focus.value?.item));

const key = (it: AttendanceDayItemDto) => it.classSessionId ?? `b${it.batchId}`;
const name = (it: AttendanceDayItemDto) => [it.subjectName, it.batchName].filter(Boolean).join(' · ');
const chip = (it: AttendanceDayItemDto): { text: string; tone: 'medium' | 'success' | 'warning' } =>
  !it.attendance
    ? { text: t('attendance.day.notStarted'), tone: 'medium' }
    : it.attendance.status === 'closed'
      ? { text: t('attendance.day.submitted'), tone: 'success' }
      : { text: t('attendance.day.inProgress'), tone: 'warning' };

function attendanceText(it: AttendanceDayItemDto) {
  const c = it.attendance?.counts ?? {};
  const present = (c.present ?? 0) + (c.late ?? 0) + (c.half_day ?? 0);
  return it.attendance?.status === 'closed'
    ? t('attendance.today.submittedCounts', { present, absent: c.absent ?? 0 })
    : t('attendance.day.inProgress');
}

/** Button text for the live class of `it`, or '' when the teacher can't host one. */
function liveAction(it: AttendanceDayItemDto) {
  if (!liveEnabled.value) return '';
  const l = liveFor(it, live.value, date);
  if (l)
    return l.myRole === 'host'
      ? l.status === 'live'
        ? t('attendance.today.openLive')
        : t('attendance.today.goLive')
      : '';
  return it.classSessionId && auth.can('live-classes.create') ? t('attendance.today.goLive') : '';
}

async function load() {
  try {
    day.value = await attendanceApi.day(date);
  } catch {
    day.value = { date, mode: 'class', items: [] };
  }
  if (liveEnabled.value)
    live.value = (await liveApi.list({ upcoming: true, pageSize: 50 }).catch(() => ({ items: [] }))).items;
}

async function takeAttendance(it: AttendanceDayItemDto) {
  busy.value = true;
  try {
    const id =
      it.attendance?.id ??
      (
        await attendanceApi.openSession(
          it.classSessionId ? { classSessionId: it.classSessionId } : { batchId: it.batchId, date },
        )
      ).session.id;
    router.push(`/attendance/sessions/${id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function goLive(it: AttendanceDayItemDto) {
  let l = liveFor(it, live.value, date);
  if (l?.status !== 'live') {
    const a = await alertController.create({
      header: t('attendance.today.goLiveTitle'),
      message: t('attendance.today.goLiveMessage', { name: name(it) }),
      buttons: [
        { text: t('attendance.roster.cancel'), role: 'cancel' },
        { text: t('attendance.today.goLive'), role: 'confirm' },
      ],
    });
    await a.present();
    if ((await a.onDidDismiss()).role !== 'confirm') return;
  }
  busy.value = true;
  try {
    if (!l) l = await liveApi.create({ classSessionId: it.classSessionId! });
    if (l.status !== 'live') await liveApi.start(l.id);
    router.push(`/live-classes/${l.id}/room`);
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.skeleton {
  height: 150px;
  border-radius: 16px;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.09), rgba(0, 0, 0, 0.05));
}
.hero {
  padding: 16px;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--ion-color-primary-shade), var(--ion-color-primary));
  color: var(--ion-color-primary-contrast);
}
.hero.earlier {
  background: linear-gradient(135deg, #64748b, #475569);
}
.when {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.9;
}
.what {
  margin: 4px 0 2px;
  font-size: 22px;
  font-weight: 700;
  color: inherit;
}
.sub {
  margin: 0;
  opacity: 0.9;
}
.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}
.buttons button {
  flex: 1 1 auto;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 52px;
  padding: 0 12px;
  border-radius: 12px;
  font: inherit;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}
.buttons ion-icon {
  flex: none;
  font-size: 22px;
}
.primary {
  border: 0;
  background: #fff;
  color: var(--ion-color-primary-shade);
}
.secondary {
  border: 2px solid rgba(255, 255, 255, 0.8);
  background: transparent;
  color: inherit;
}
.others {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 56px;
  padding: 6px 4px;
  border: 0;
  border-bottom: 1px solid var(--ion-border-color, rgba(0, 0, 0, 0.08));
  background: none;
  color: var(--ion-text-color);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.others li:last-child .row {
  border-bottom: 0;
}
.time {
  min-width: 70px;
  color: var(--ion-color-medium-shade);
  font-size: 14px;
}
.name {
  flex: 1;
}
</style>

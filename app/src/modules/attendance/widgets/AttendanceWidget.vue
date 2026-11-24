<template>
  <div v-if="!loaded" class="skeleton" aria-hidden="true" />
  <EmptyState
    v-else-if="!overall || !overall.total"
    :icon="calendarOutline"
    :title="t('attendance.widgets.noRecords')"
  />
  <ion-item v-else lines="none" button detail class="att" :router-link="link">
    <div slot="start" class="ring" :class="tone" :style="{ '--p': pct }">
      <span>{{ formatPercent(overall.percentage) }}</span>
    </div>
    <ion-label>
      <h3>
        {{ t('attendance.widgets.present', { n: overall.present + overall.late, total: overall.total }) }}
      </h3>
      <p>
        {{ t('attendance.widgets.absent', { n: overall.absent }) }}
        <span v-if="overall.leave"> · {{ t('attendance.widgets.leave', { n: overall.leave }) }}</span>
      </p>
      <p v-if="last">
        {{ t('attendance.widgets.lastClass', { date: formatDate(last.date) }) }}
        <StatusChip :label="statusLabel(last.status)" :tone="statusTone(last.status)" />
      </p>
    </ion-label>
  </ion-item>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonItem, IonLabel } from '@ionic/vue';
import { calendarOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { ParentChildDto, StudentAttendanceSummaryDto } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDate, formatPercent } from '@/core/format';
import { attendanceApi } from '../api';

/** Student home and parent home (with `child`): this year's attendance and the last marked class. */
const props = defineProps<{ child?: ParentChildDto }>();
const { t, te } = useI18n();
const summary = ref<StudentAttendanceSummaryDto | null>(null);
const loaded = ref(false);

const overall = computed(() => summary.value?.overall ?? null);
const pct = computed(() => Math.round(overall.value?.percentage ?? 0));
const tone = computed(() => (pct.value >= 85 ? 'good' : pct.value >= 75 ? 'ok' : 'low'));
const last = computed(
  () => [...(summary.value?.records ?? [])].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null,
);
const link = computed(() =>
  props.child
    ? { path: '/attendance/my', query: { child: String(props.child.studentUserId) } }
    : '/attendance/my',
);

const statusLabel = (s: string) =>
  te(`common.status.${s}`) ? t(`common.status.${s}`) : t(`attendance.widgets.status.${s}`);
const statusTone = (s: string) =>
  s === 'present'
    ? 'success'
    : s === 'absent'
      ? 'danger'
      : s === 'late' || s === 'half_day'
        ? 'warning'
        : 'medium';

onMounted(async () => {
  try {
    // A child without a login has no attendance of their own to show.
    if (props.child && props.child.studentUserId == null) summary.value = null;
    else
      summary.value = props.child?.studentUserId
        ? await attendanceApi.childSummary(props.child.studentUserId)
        : await attendanceApi.mySummary();
  } catch {
    summary.value = null;
  } finally {
    loaded.value = true;
  }
});
</script>

<style scoped>
.att {
  --padding-start: 0;
}
.ring {
  --c: var(--ion-color-medium);
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  margin-inline-end: 12px;
  border-radius: 50%;
  background: conic-gradient(var(--c) calc(var(--p) * 1%), var(--ion-color-light-shade) 0);
}
.ring span {
  display: grid;
  place-items: center;
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background: var(--ion-card-background, var(--ion-background-color, #fff));
  font-weight: 700;
  font-size: 0.9rem;
}
.ring.good {
  --c: var(--ion-color-success);
}
.ring.ok {
  --c: var(--ion-color-warning);
}
.ring.low {
  --c: var(--ion-color-danger);
}
.skeleton {
  height: 64px;
  border-radius: 8px;
  background: var(--ion-color-light);
}
</style>

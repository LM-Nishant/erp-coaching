<template>
  <div v-if="!loaded" class="skeleton" aria-hidden="true" />
  <p v-else-if="failed" class="muted">{{ t('attendance.widgets.staff.failed') }}</p>
  <p v-else-if="!s.classes" class="muted">{{ t('attendance.widgets.staff.none') }}</p>
  <div v-else>
    <div class="nums">
      <router-link to="/attendance" class="num">
        <span class="value" :class="{ warn: s.pending }">{{ s.pending }}</span>
        <span class="label">{{ t('attendance.widgets.staff.pending') }}</span>
      </router-link>
      <router-link to="/attendance" class="num">
        <span class="value" :class="{ danger: s.absent }">{{ s.absent }}</span>
        <span class="label">{{ t('attendance.widgets.staff.absent') }}</span>
      </router-link>
    </div>
    <p class="muted foot">
      {{ t('attendance.widgets.staff.submitted', { n: s.submitted, total: s.classes }) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { attendanceApi } from '../api';
import { daySummary } from '../today';

/** Staff home: how many of today's classes still need attendance, and how many students are absent so far. */
const { t } = useI18n();
const s = ref(daySummary([]));
const loaded = ref(false);
const failed = ref(false);

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

onMounted(async () => {
  try {
    s.value = daySummary((await attendanceApi.day(ymd(new Date()))).items);
  } catch {
    failed.value = true;
  } finally {
    loaded.value = true;
  }
});
</script>

<style scoped>
.skeleton {
  height: 72px;
  border-radius: 12px;
  background: var(--ion-color-light);
}
.nums {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.num {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: var(--app-tap-target, 48px);
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--ion-color-light);
  color: inherit;
  text-decoration: none;
}
.value {
  font-size: 20px;
  font-weight: 700;
  color: var(--ion-text-color);
}
.value.warn {
  color: var(--ion-color-warning-shade);
}
.value.danger {
  color: var(--ion-color-danger);
}
.label {
  font-size: 13px;
  color: var(--ion-color-medium-shade);
}
.muted {
  color: var(--ion-color-medium);
}
.foot {
  margin: 8px 0 0;
  font-size: 13px;
}
</style>

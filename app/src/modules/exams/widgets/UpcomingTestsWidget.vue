<template>
  <div v-if="!loaded" class="skeleton" aria-hidden="true" />
  <EmptyState v-else-if="!items.length" :icon="ribbonOutline" :title="t('exams.widgets.noTests')" />
  <ion-list v-else lines="none" class="tests">
    <ion-item v-for="x in items" :key="x.exam.id" button detail router-link="/my-exams">
      <ion-label>
        <h3>{{ x.exam.title }}</h3>
        <p>
          {{ formatDateTime(x.exam.startAt) }} ·
          {{ t('exams.widgets.minutes', { n: x.exam.durationMinutes }) }}
        </p>
      </ion-label>
      <StatusChip
        v-if="x.exam.phase === 'live'"
        slot="end"
        :label="x.canStart ? t('exams.widgets.startNow') : t('common.status.live')"
        tone="danger"
      />
      <StatusChip v-else slot="end" :label="t('common.status.upcoming')" tone="primary" />
    </ion-item>
  </ion-list>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonItem, IonLabel, IonList } from '@ionic/vue';
import { ribbonOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { StudentExamListItem } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime } from '@/core/format';
import { examsApi } from '../api';

/** Student home: tests that are open now or coming up, and not yet attempted. */
const { t } = useI18n();
const items = ref<StudentExamListItem[]>([]);
const loaded = ref(false);

onMounted(async () => {
  try {
    const all = await examsApi.myExams();
    items.value = all
      .filter((x) => !x.attempt?.submittedAt && (x.exam.phase === 'live' || x.exam.phase === 'upcoming'))
      .sort((a, b) => a.exam.startAt.localeCompare(b.exam.startAt))
      .slice(0, 3);
  } catch {
    items.value = [];
  } finally {
    loaded.value = true;
  }
});
</script>

<style scoped>
.tests ion-item {
  --padding-start: 0;
  --min-height: var(--app-tap-target, 48px);
}
.skeleton {
  height: 72px;
  border-radius: 8px;
  background: var(--ion-color-light);
}
</style>

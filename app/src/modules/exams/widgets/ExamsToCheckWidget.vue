<template>
  <div v-if="items === null" class="skeleton" aria-hidden="true" />
  <EmptyState
    v-else-if="!items.length"
    :icon="checkmarkCircleOutline"
    :title="t('exams.toCheck.allDone')"
    :message="t('exams.toCheck.allDoneHint')"
  />
  <ul v-else class="to-check">
    <li v-for="e in items" :key="e.id">
      <ion-item button :detail="true" lines="full" :router-link="`/exams/${e.id}`">
        <ion-label>
          <h3>{{ e.title }}</h3>
          <p>
            {{
              [e.batchName ?? e.courseName, t('exams.toCheck.ended', { date: formatDayShort(e.endAt) })]
                .filter(Boolean)
                .join(' · ')
            }}
          </p>
        </ion-label>
        <StatusChip slot="end" tone="warning" :label="t('exams.toCheck.publishResults')" />
      </ion-item>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonItem, IonLabel } from '@ionic/vue';
import { checkmarkCircleOutline } from 'ionicons/icons';
import type { ExamDto } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDayShort } from '@/core/format';
import { examsApi } from '../api';

const { t } = useI18n();
const items = ref<ExamDto[] | null>(null);

onMounted(async () => {
  try {
    items.value = (await examsApi.list({ phase: 'closed', pageSize: 5 })).items;
  } catch {
    items.value = [];
  }
});
</script>

<style scoped>
.skeleton {
  height: 72px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.06);
}
.to-check {
  list-style: none;
  margin: 0;
  padding: 0;
}
.to-check ion-item {
  --padding-start: 0;
  --min-height: var(--app-tap-target);
}
</style>

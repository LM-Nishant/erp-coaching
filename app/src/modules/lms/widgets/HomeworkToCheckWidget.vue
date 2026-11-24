<template>
  <div v-if="items === null" class="skeleton" aria-hidden="true" />
  <EmptyState
    v-else-if="!items.length"
    :icon="checkmarkCircleOutline"
    :title="t('lms.toCheck.allDone')"
    :message="t('lms.toCheck.allDoneHint')"
  />
  <ul v-else class="to-check">
    <li v-for="a in items" :key="a.id">
      <ion-item button :detail="true" lines="full" :router-link="`/lms/homework/${a.id}`">
        <ion-label>
          <h3>{{ a.title }}</h3>
          <p>
            {{
              [a.batchName, t('lms.toCheck.due', { date: formatDayShort(a.dueAt) })]
                .filter(Boolean)
                .join(' · ')
            }}
          </p>
        </ion-label>
        <StatusChip slot="end" tone="warning" :label="t('lms.toCheck.toGrade', { n: toGrade(a) })" />
      </ion-item>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonItem, IonLabel } from '@ionic/vue';
import { checkmarkCircleOutline } from 'ionicons/icons';
import type { LmsAssignmentDto } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDayShort } from '@/core/format';
import { lmsApi } from '../api';

const { t } = useI18n();
const items = ref<LmsAssignmentDto[] | null>(null);
const toGrade = (a: LmsAssignmentDto) => (a.counts?.submitted ?? 0) - (a.counts?.graded ?? 0);

onMounted(async () => {
  try {
    items.value = (await lmsApi.assignments()).items.filter((a) => toGrade(a) > 0).slice(0, 5);
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

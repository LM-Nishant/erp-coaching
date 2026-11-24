<template>
  <div v-if="!loaded" class="skeleton" aria-hidden="true" />
  <EmptyState v-else-if="!latest" :icon="trophyOutline" :title="t('exams.widgets.noResults')" />
  <ion-item
    v-else
    lines="none"
    button
    detail
    class="result"
    :router-link="`/exam-results/${latest.attemptId}`"
  >
    <div slot="start" class="score" :class="tone">{{ formatPercent(percent) }}</div>
    <ion-label>
      <h3>{{ latest.exam.title }}</h3>
      <p>
        {{
          t('exams.widgets.score', {
            got: formatNumber(latest.totalScore),
            max: formatNumber(latest.maxScore),
          })
        }}
        <span v-if="latest.rank"> · {{ t('exams.widgets.rank', { n: latest.rank }) }}</span>
      </p>
      <p v-if="latest.percentile !== null">
        {{ t('exams.widgets.percentile', { n: formatNumber(latest.percentile, 1) }) }}
      </p>
    </ion-label>
  </ion-item>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonItem, IonLabel } from '@ionic/vue';
import { trophyOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { ChildResultListItem, ParentChildDto } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import { formatNumber, formatPercent } from '@/core/format';
import { examsApi } from '../api';

/** Student home and parent home (with `child`): the most recent published test result. */
const props = defineProps<{ child?: ParentChildDto }>();
const { t } = useI18n();
const latest = ref<ChildResultListItem | null>(null);
const loaded = ref(false);

const percent = computed(() =>
  latest.value && latest.value.maxScore ? (latest.value.totalScore / latest.value.maxScore) * 100 : 0,
);
const tone = computed(() => (percent.value >= 75 ? 'good' : percent.value >= 40 ? 'ok' : 'low'));

onMounted(async () => {
  try {
    const list = props.child
      ? (await examsApi.childrenResults()).filter((r) => r.studentUserId === props.child!.studentUserId)
      : await examsApi.myResults();
    latest.value = [...list].sort((a, b) => b.exam.endAt.localeCompare(a.exam.endAt))[0] ?? null;
  } catch {
    latest.value = null;
  } finally {
    loaded.value = true;
  }
});
</script>

<style scoped>
.result {
  --padding-start: 0;
}
.score {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin-inline-end: 12px;
  border-radius: 50%;
  font-weight: 700;
  color: #fff;
  background: var(--ion-color-medium);
}
.score.good {
  background: var(--ion-color-success);
}
.score.ok {
  background: var(--ion-color-warning);
}
.score.low {
  background: var(--ion-color-danger);
}
.skeleton {
  height: 64px;
  border-radius: 8px;
  background: var(--ion-color-light);
}
</style>

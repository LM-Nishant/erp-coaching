<template>
  <div v-if="!loaded" class="skeleton" aria-hidden="true" />
  <EmptyState
    v-else-if="!items.length"
    :icon="playCircleOutline"
    :title="t('lms.widgets.nothingToContinue')"
    :message="t('lms.widgets.nothingToContinueHint')"
  >
    <ion-button fill="outline" router-link="/lms">{{ t('lms.widgets.browse') }}</ion-button>
  </EmptyState>
  <ion-list v-else lines="none" class="continue">
    <ion-item v-for="r in items" :key="r.id" button detail :router-link="`/lms/resources/${r.id}`">
      <ion-icon slot="start" :icon="r.type === 'video' ? playCircle : documentTextOutline" color="primary" />
      <ion-label>
        <h3>{{ r.title }}</h3>
        <p>
          <span v-if="r.courseName">{{ r.courseName }} · </span>
          <span v-if="left(r)">{{ t('lms.widgets.left', { time: left(r) }) }}</span>
          <span v-else>{{ t('lms.widgets.percentDone', { n: r.progress?.percent ?? 0 }) }}</span>
        </p>
        <div
          class="bar"
          role="progressbar"
          :aria-valuenow="r.progress?.percent ?? 0"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span :style="{ width: `${r.progress?.percent ?? 0}%` }" />
        </div>
      </ion-label>
    </ion-item>
  </ion-list>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonButton, IonIcon, IonItem, IonLabel, IonList } from '@ionic/vue';
import { documentTextOutline, playCircle, playCircleOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { LmsLearnerResourceDto } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import { formatDuration } from '@/core/format';
import { lmsApi } from '../api';

/** Student home: pick up the last lessons where you left off. */
const { t } = useI18n();
const items = ref<LmsLearnerResourceDto[]>([]);
const loaded = ref(false);

const left = (r: LmsLearnerResourceDto) => {
  const total = r.progress?.durationSeconds ?? r.durationSeconds;
  if (!total || !r.progress) return '';
  return formatDuration(Math.max(0, total - r.progress.positionSeconds));
};

onMounted(async () => {
  try {
    items.value = await lmsApi.continue();
  } catch {
    items.value = [];
  } finally {
    loaded.value = true;
  }
});
</script>

<style scoped>
.continue ion-item {
  --padding-start: 0;
  --min-height: var(--app-tap-target, 48px);
}
.continue ion-icon[slot='start'] {
  font-size: 2rem;
  margin-inline-end: 12px;
}
.bar {
  height: 4px;
  margin-top: 6px;
  border-radius: 2px;
  background: var(--ion-color-light-shade);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--ion-color-primary);
}
.skeleton {
  height: 72px;
  border-radius: 8px;
  background: var(--ion-color-light);
}
</style>

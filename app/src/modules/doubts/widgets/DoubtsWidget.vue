<template>
  <div class="doubts-widget">
    <template v-if="counts">
      <p v-if="teacher" class="line">
        <strong v-if="counts.waiting">{{
          t('doubts.widget.waiting', { n: counts.waiting }, counts.waiting)
        }}</strong>
        <span v-else class="muted">{{ t('doubts.widget.noneWaiting') }}</span>
      </p>
      <p v-else class="line">
        <strong v-if="counts.answered">{{
          t('doubts.widget.answered', { n: counts.answered }, counts.answered)
        }}</strong>
        <span v-else class="muted">{{ t('doubts.widget.noneAnswered') }}</span>
      </p>
      <div class="actions">
        <ion-button v-if="teacher" size="small" router-link="/doubts/inbox">{{
          t('doubts.widget.open')
        }}</ion-button>
        <template v-else>
          <ion-button size="small" router-link="/doubts/ask">{{ t('doubts.ask.button') }}</ion-button>
          <ion-button size="small" fill="outline" router-link="/doubts">{{
            t('doubts.widget.view')
          }}</ion-button>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonButton } from '@ionic/vue';
import type { DoubtCountsDto } from '@erp/shared';
import { doubtsApi } from '../api';

/** Teacher: doubts waiting in the inbox. Student: new answers, plus a shortcut to ask. */
const props = defineProps<{ teacher?: boolean }>();
const { t } = useI18n();
const counts = ref<DoubtCountsDto | null>(null);
const teacher = props.teacher;

onMounted(async () => {
  try {
    counts.value = await doubtsApi.counts();
  } catch {
    counts.value = { waiting: 0, answered: 0 };
  }
});
</script>

<style scoped>
.line {
  margin: 0 0 8px;
}
.actions {
  display: flex;
  gap: 8px;
}
</style>

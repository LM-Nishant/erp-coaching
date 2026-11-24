<template>
  <div v-if="!loaded" class="skeleton" aria-hidden="true" />
  <EmptyState
    v-else-if="!items.length"
    :icon="checkmarkDoneOutline"
    :title="t('lms.widgets.allDone')"
    :message="child ? undefined : t('lms.widgets.allDoneHint')"
  />
  <template v-else>
    <ion-list lines="none" class="homework">
      <ion-item v-for="a in shown" :key="a.id" button detail :router-link="`/lms/homework/${a.id}`">
        <ion-label>
          <h3>{{ a.title }}</h3>
          <p>
            <span v-if="a.subjectName">{{ a.subjectName }} · </span>
            {{ t('lms.homework.dueAt', { date: formatDateTime(a.dueAt) }) }}
          </p>
        </ion-label>
        <StatusChip
          slot="end"
          :label="t(`lms.homework.state.${homeworkState(a)}`)"
          :tone="HOMEWORK_TONE[homeworkState(a)]"
        />
      </ion-item>
    </ion-list>
    <ion-button v-if="items.length > shown.length" fill="clear" size="small" router-link="/lms/homework">{{
      t('lms.widgets.seeAll', { n: items.length })
    }}</ion-button>
  </template>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonButton, IonItem, IonLabel, IonList } from '@ionic/vue';
import { checkmarkDoneOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { LmsAssignmentDto, ParentChildDto } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime } from '@/core/format';
import { lmsApi } from '../api';
import { HOMEWORK_TONE, homeworkState } from '../homework';

/** Student home and parent home (with `child`): homework still to hand in, the closest deadline first. */
const props = defineProps<{ child?: ParentChildDto }>();
const { t } = useI18n();
const items = ref<LmsAssignmentDto[]>([]);
const loaded = ref(false);
const shown = computed(() => items.value.slice(0, 3));

onMounted(async () => {
  try {
    const child = props.child;
    // A child without a login has no homework of their own.
    const list = !child
      ? (await lmsApi.assignments({ status: 'pending' })).items
      : child.studentUserId == null
        ? []
        : await lmsApi.childrenAssignments({ status: 'pending', studentUserId: child.studentUserId });
    items.value = [...list].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  } catch {
    items.value = [];
  } finally {
    loaded.value = true;
  }
});
</script>

<style scoped>
.homework ion-item {
  --padding-start: 0;
  --min-height: var(--app-tap-target, 48px);
}
.skeleton {
  height: 72px;
  border-radius: 8px;
  background: var(--ion-color-light);
}
</style>

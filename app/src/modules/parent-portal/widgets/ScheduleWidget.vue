<template>
  <p v-if="!loaded" class="muted">{{ t('parentPortal.schedule.loading') }}</p>
  <p v-else-if="!days.length" class="muted">{{ t('parentPortal.schedule.none') }}</p>
  <div v-for="d in shown" :key="d.date" class="day">
    <h3>{{ formatDayShort(d.date) }}</h3>
    <ion-list lines="none">
      <ion-item v-for="c in d.items" :key="c.classSessionId">
        <ion-note slot="start" class="time">{{ c.startTime }}–{{ c.endTime }}</ion-note>
        <ion-label class="ion-text-wrap">
          <h3>{{ c.subject ?? c.batchName }}</h3>
          <p>
            <span v-if="c.teacher">{{ c.teacher }}</span><span v-if="c.subject && c.batchName">
              · {{ c.batchName }}</span
            >
          </p>
        </ion-label>
        <StatusChip
          v-if="c.status !== 'scheduled'"
          slot="end"
          :label="t(`parentPortal.schedule.status.${c.status}`)"
          :tone="c.status === 'cancelled' ? 'danger' : 'medium'"
        />
      </ion-item>
    </ion-list>
  </div>
  <ion-button v-if="days.length > SHOWN_DAYS" fill="clear" size="small" @click="all = !all">{{
    all ? t('parentPortal.schedule.less') : t('parentPortal.schedule.more')
  }}</ion-button>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IonButton, IonItem, IonLabel, IonList, IonNote } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import type { ParentChildDto, ParentTimetableItemDto } from '@erp/shared';
import StatusChip from '@/components/StatusChip.vue';
import { formatDayShort } from '@/core/format';
import { toastError } from '@/core/toast';
import { parentPortalApi } from '../api';

const props = defineProps<{ child: ParentChildDto }>();
const { t } = useI18n();
const items = ref<ParentTimetableItemDto[]>([]);
const loaded = ref(false);

const days = computed(() => {
  const map = new Map<string, ParentTimetableItemDto[]>();
  for (const i of items.value) map.set(i.date, [...(map.get(i.date) ?? []), i]);
  return [...map.entries()].map(([date, list]) => ({ date, items: list }));
});
/** Days shown before "Show the whole week". */
const SHOWN_DAYS = 2;
const all = ref(false);
const shown = computed(() => (all.value ? days.value : days.value.slice(0, SHOWN_DAYS)));

watch(
  () => props.child.studentId,
  async (id) => {
    loaded.value = false;
    try {
      items.value = (await parentPortalApi.timetable(id)).items;
    } catch (e) {
      items.value = [];
      await toastError(e);
    } finally {
      loaded.value = true;
    }
  },
  { immediate: true },
);
</script>

<style scoped>
.day h3 {
  font-size: 0.9rem;
  margin: 8px 0 0;
}
.time {
  min-width: 96px;
}
</style>

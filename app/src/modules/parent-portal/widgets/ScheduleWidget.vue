<template>
  <p v-if="!loaded" class="muted">Loading…</p>
  <p v-else-if="!days.length" class="muted">No classes scheduled in the next 7 days.</p>
  <div v-for="d in days" :key="d.date" class="day">
    <h3>{{ formatDate(d.date) }}</h3>
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
        <ion-badge
          v-if="c.status !== 'scheduled'"
          slot="end"
          :color="c.status === 'cancelled' ? 'danger' : 'medium'"
        >
          {{ c.status }}
        </ion-badge>
      </ion-item>
    </ion-list>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IonBadge, IonItem, IonLabel, IonList, IonNote } from '@ionic/vue';
import type { ParentChildDto, ParentTimetableItemDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import { parentPortalApi } from '../api';

const props = defineProps<{ child: ParentChildDto }>();
const items = ref<ParentTimetableItemDto[]>([]);
const loaded = ref(false);

const days = computed(() => {
  const map = new Map<string, ParentTimetableItemDto[]>();
  for (const i of items.value) map.set(i.date, [...(map.get(i.date) ?? []), i]);
  return [...map.entries()].map(([date, list]) => ({ date, items: list }));
});
const formatDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });

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

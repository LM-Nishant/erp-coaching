<template>
  <ion-item>
    <ion-input v-model="from" type="date" label="From" label-placement="stacked" @ion-change="load" />
    <ion-input v-model="to" type="date" label="To" label-placement="stacked" @ion-change="load" />
  </ion-item>
  <div class="ion-padding-horizontal">
    <p v-if="loading" class="muted">Loading free times…</p>
    <p v-else-if="!groups.length" class="muted">No free times in this range. Try later dates.</p>
    <div v-for="g in groups" :key="g.date" class="day">
      <h3>{{ formatDate(g.date) }}</h3>
      <ion-chip
        v-for="s in g.slots"
        :key="`${s.date}-${s.startTime}`"
        :color="isPicked(s) ? 'primary' : undefined"
        :outline="!isPicked(s)"
        @click="emit('update:modelValue', s)"
      >
        {{ s.startTime }}
        <ion-icon
          v-if="s.modes.length === 1"
          :icon="s.modes[0] === 'online' ? videocamOutline : peopleOutline"
        />
      </ion-chip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IonChip, IonIcon, IonInput, IonItem } from '@ionic/vue';
import { peopleOutline, videocamOutline } from 'ionicons/icons';
import type { AvailableSlotDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import { addDaysIso, appointmentsApi, todayIso } from '../api';

const props = defineProps<{
  teacherUserId: number;
  studentId: number;
  modelValue: AvailableSlotDto | null;
}>();
const emit = defineEmits<{ 'update:modelValue': [AvailableSlotDto | null] }>();

const from = ref(todayIso());
const to = ref(addDaysIso(todayIso(), 13));
const slots = ref<AvailableSlotDto[]>([]);
const loading = ref(false);

const groups = computed(() => {
  const map = new Map<string, AvailableSlotDto[]>();
  for (const s of slots.value) map.set(s.date, [...(map.get(s.date) ?? []), s]);
  return [...map.entries()].map(([date, list]) => ({ date, slots: list }));
});

const isPicked = (s: AvailableSlotDto) =>
  props.modelValue?.date === s.date && props.modelValue.startTime === s.startTime;
const formatDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

async function load() {
  if (!from.value || !to.value) return;
  loading.value = true;
  emit('update:modelValue', null);
  try {
    slots.value = await appointmentsApi.availability(props.teacherUserId, {
      studentId: props.studentId,
      from: from.value,
      to: to.value,
    });
  } catch (e) {
    slots.value = [];
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

watch(() => [props.teacherUserId, props.studentId], load, { immediate: true });
</script>

<style scoped>
.day h3 {
  font-size: 0.95rem;
  margin: 12px 0 4px;
}
</style>

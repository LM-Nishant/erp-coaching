<template>
  <AppPage title="My timetable" :on-refresh="load">
    <ion-item lines="none">
      <ion-button fill="clear" aria-label="Previous week" @click="shift(-7)"
        ><ion-icon slot="icon-only" :icon="chevronBack"
      /></ion-button>
      <ion-label class="ion-text-center">{{ from }} → {{ to }}</ion-label>
      <ion-button fill="clear" aria-label="Next week" @click="shift(7)"
        ><ion-icon slot="icon-only" :icon="chevronForward"
      /></ion-button>
    </ion-item>

    <ion-list v-for="day in days" :key="day.date">
      <ion-list-header :class="{ today: day.date === isoToday() }"
        >{{ weekdayOf(day.date) }} · {{ day.date }}</ion-list-header
      >
      <ion-item
        v-for="c in day.items"
        :key="c.id"
        :router-link="`/academics/classes/${c.id}`"
        :class="{ cancelled: c.status === 'cancelled' }"
      >
        <ion-label>
          <h3>
            {{ c.startTime }}–{{ c.endTime }} · {{ c.subject?.name ?? c.batch?.name }}
            <ion-badge v-if="c.status !== 'scheduled'" :color="statusColor(c.status)">{{
              c.status
            }}</ion-badge>
            <ion-badge v-if="c.rescheduledFrom && c.status === 'scheduled'" color="tertiary"
              >rescheduled</ion-badge
            >
            <ion-badge v-if="c.originalTeacherUserId" color="warning">{{
              c.teacherUserId === myId ? 'you substitute' : 'substitute'
            }}</ion-badge>
          </h3>
          <p>{{ c.batch?.name }} · {{ c.teacher?.name }} · {{ c.classroom?.name ?? 'Online / TBA' }}</p>
          <p v-if="c.cancelReason">{{ c.cancelReason }}</p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!day.items.length" lines="none"
        ><ion-label class="muted">No classes</ion-label></ion-item
      >
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonBadge, IonButton, IonIcon, IonItem, IonLabel, IonList, IonListHeader } from '@ionic/vue';
import { chevronBack, chevronForward } from 'ionicons/icons';
import type { ClassSessionDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi, addDays, isoToday, statusColor, weekdayOf } from './api';

const auth = useAuthStore();
const myId = computed(() => auth.me?.user.id);
const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const from = ref(mondayOf(isoToday()));
const to = computed(() => addDays(from.value, 6));
const items = ref<ClassSessionDto[]>([]);

const days = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from.value, i);
    return { date, items: items.value.filter((c) => c.date === date) };
  }),
);

async function load() {
  try {
    items.value = (await academicsApi.myTimetable(from.value, to.value)).items;
  } catch (e) {
    await toastError(e);
  }
}

function shift(n: number) {
  from.value = addDays(from.value, n);
  load();
}

onMounted(load);
</script>

<style scoped>
.today {
  color: var(--ion-color-primary);
  font-weight: 600;
}
.cancelled {
  opacity: 0.6;
}
</style>

<template>
  <AppPage :title="t('academics.timetable.title')" :on-refresh="load">
    <ion-item lines="none">
      <ion-button fill="clear" :aria-label="t('academics.timetable.prevWeek')" @click="shift(-7)"
        ><ion-icon slot="icon-only" :icon="chevronBack"
      /></ion-button>
      <ion-label class="ion-text-center">{{ formatDate(from) }} → {{ formatDate(to) }}</ion-label>
      <ion-button fill="clear" :aria-label="t('academics.timetable.nextWeek')" @click="shift(7)"
        ><ion-icon slot="icon-only" :icon="chevronForward"
      /></ion-button>
    </ion-item>

    <ion-list v-for="day in days" :key="day.date">
      <ion-list-header :class="{ today: day.date === isoToday() }">{{
        formatDayShort(day.date)
      }}</ion-list-header>
      <ion-item
        v-for="c in day.items"
        :key="c.id"
        :router-link="`/academics/classes/${c.id}`"
        :class="{ cancelled: c.status === 'cancelled' }"
      >
        <ion-label>
          <h3>
            {{ clock(c.date, c.startTime) }}–{{ clock(c.date, c.endTime) }} ·
            {{ c.subject?.name ?? c.batch?.name }}
            <ion-badge v-if="c.status !== 'scheduled'" :color="statusColor(c.status)">{{
              t(`common.status.${c.status}`)
            }}</ion-badge>
            <ion-badge v-if="c.rescheduledFrom && c.status === 'scheduled'" color="tertiary">{{
              t('academics.timetable.rescheduled')
            }}</ion-badge>
            <ion-badge v-if="c.originalTeacherUserId" color="warning">{{
              c.teacherUserId === myId
                ? t('academics.timetable.youSubstitute')
                : t('academics.timetable.substitute')
            }}</ion-badge>
          </h3>
          <p>
            {{ c.batch?.name }} · {{ c.teacher?.name }} ·
            {{ c.classroom?.name ?? t('academics.timetable.noRoom') }}
          </p>
          <p v-if="c.cancelReason">{{ c.cancelReason }}</p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!day.items.length" lines="none"
        ><ion-label class="muted">{{ t('academics.timetable.noClasses') }}</ion-label></ion-item
      >
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonBadge, IonButton, IonIcon, IonItem, IonLabel, IonList, IonListHeader } from '@ionic/vue';
import { chevronBack, chevronForward } from 'ionicons/icons';
import type { ClassSessionDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { formatDate, formatDayShort, formatTime } from '@/core/format';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi, addDays, isoToday, statusColor } from './api';

const { t } = useI18n();
const auth = useAuthStore();
const myId = computed(() => auth.me?.user.id);
const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const from = ref(mondayOf(isoToday()));
const to = computed(() => addDays(from.value, 6));
const items = ref<ClassSessionDto[]>([]);

// Timetable times are wall-clock times on the class date.
const clock = (date: string, hm: string) => formatTime(`${date}T${hm}`);

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

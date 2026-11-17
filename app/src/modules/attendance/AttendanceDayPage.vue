<template>
  <AppPage title="Take attendance" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'attendance.view'" router-link="/attendance/requests"
        ><ion-icon slot="icon-only" :icon="documentTextOutline"
      /></ion-button>
    </template>
    <ion-item>
      <ion-input v-model="date" type="date" label="Date" label-placement="stacked" @ion-change="load" />
    </ion-item>
    <p v-if="day && !day.items.length" class="empty">
      {{ day.mode === 'daily' ? 'No batches assigned to you.' : 'No classes scheduled on this day.' }}
    </p>
    <ion-list v-if="day">
      <ion-item v-for="it in day.items" :key="key(it)" button :detail="true" @click="open(it)">
        <ion-label>
          <h3>
            {{ it.batchName }}<span v-if="it.subjectName"> · {{ it.subjectName }}</span>
          </h3>
          <p v-if="it.startTime">{{ it.startTime.slice(0, 5) }}–{{ it.endTime?.slice(0, 5) }}</p>
          <p v-if="it.attendance">
            <span v-for="(n, s) in it.attendance.counts" :key="s" class="count"
              >{{ STATUS_SHORT[s as AttendanceStatus] ?? s }} {{ n }}</span
            >
          </p>
        </ion-label>
        <ion-badge slot="end" :color="badge(it).color">{{ badge(it).text }}</ion-badge>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IonBadge, IonButton, IonIcon, IonInput, IonItem, IonLabel, IonList } from '@ionic/vue';
import { documentTextOutline } from 'ionicons/icons';
import type { AttendanceDayDto, AttendanceDayItemDto, AttendanceStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { STATUS_SHORT, attendanceApi, localDate } from './api';

const router = useRouter();
const date = ref(localDate());
const day = ref<AttendanceDayDto | null>(null);

const key = (it: AttendanceDayItemDto) => it.classSessionId ?? `b${it.batchId}`;
const badge = (it: AttendanceDayItemDto) =>
  !it.attendance
    ? { text: 'Not started', color: 'medium' }
    : it.attendance.status === 'closed'
      ? { text: 'Closed', color: 'success' }
      : { text: 'Open', color: 'warning' };

async function load() {
  try {
    day.value = await attendanceApi.day(date.value);
  } catch (e) {
    await toastError(e);
  }
}

async function open(it: AttendanceDayItemDto) {
  try {
    const id =
      it.attendance?.id ??
      (
        await attendanceApi.openSession(
          it.classSessionId
            ? { classSessionId: it.classSessionId }
            : { batchId: it.batchId, date: date.value },
        )
      ).session.id;
    await router.push(`/attendance/sessions/${id}`);
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>

<style scoped>
.empty {
  padding: 16px;
  color: var(--ion-color-medium);
}
.count {
  margin-right: 8px;
}
</style>

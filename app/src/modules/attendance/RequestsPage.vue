<template>
  <AppPage title="Attendance requests" :on-refresh="load">
    <ion-segment v-model="tab">
      <ion-segment-button value="corrections">Corrections</ion-segment-button>
      <ion-segment-button value="leaves">Student leave</ion-segment-button>
    </ion-segment>
    <ion-item>
      <ion-select v-model="status" label="Status" interface="popover">
        <ion-select-option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</ion-select-option>
      </ion-select>
    </ion-item>

    <p v-if="!items.length" class="empty">Nothing here.</p>
    <ion-list v-if="tab === 'corrections'">
      <ion-item v-for="c in corrections" :key="c.id">
        <ion-label class="ion-text-wrap">
          <h3>{{ c.studentName }} · {{ c.date }}</h3>
          <p>{{ c.batchName }}</p>
          <p>
            {{ c.currentStatus ? STATUS_LABEL[c.currentStatus] : 'Unmarked' }} →
            <strong>{{ STATUS_LABEL[c.requestedStatus] }}</strong>
          </p>
          <p>{{ c.reason }}</p>
        </ion-label>
        <div v-if="c.status === 'pending'" slot="end">
          <ion-button size="small" color="success" @click="decide('c', c.id, true)">Approve</ion-button>
          <ion-button size="small" color="danger" fill="outline" @click="decide('c', c.id, false)"
            >Reject</ion-button
          >
        </div>
        <ion-note v-else slot="end">{{ c.status }}</ion-note>
      </ion-item>
    </ion-list>
    <ion-list v-else>
      <ion-item v-for="l in leaves" :key="l.id">
        <ion-label class="ion-text-wrap">
          <h3>{{ l.studentName }}</h3>
          <p>
            {{ l.fromDate }}<span v-if="l.toDate !== l.fromDate"> → {{ l.toDate }}</span>
          </p>
          <p>{{ l.reason }}</p>
        </ion-label>
        <div v-if="l.status === 'pending'" slot="end" v-can="'attendance.approve'">
          <ion-button size="small" color="success" @click="decide('l', l.id, true)">Approve</ion-button>
          <ion-button size="small" color="danger" fill="outline" @click="decide('l', l.id, false)"
            >Reject</ion-button
          >
        </div>
        <ion-note v-else slot="end">{{ l.status }}</ion-note>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  alertController,
  IonButton,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
} from '@ionic/vue';
import type { AttendanceCorrectionDto, StudentLeaveRequestDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { STATUS_LABEL, attendanceApi, type RequestStatus } from './api';

const STATUSES: RequestStatus[] = ['pending', 'approved', 'rejected', 'cancelled'];
const tab = ref<'corrections' | 'leaves'>('corrections');
const status = ref<RequestStatus>('pending');
const corrections = ref<AttendanceCorrectionDto[]>([]);
const leaves = ref<StudentLeaveRequestDto[]>([]);
const items = computed(() => (tab.value === 'corrections' ? corrections.value : leaves.value));

async function load() {
  try {
    if (tab.value === 'corrections')
      corrections.value = (await attendanceApi.corrections(status.value)).items;
    else leaves.value = (await attendanceApi.leaves(status.value)).items;
  } catch (e) {
    await toastError(e);
  }
}

async function decide(kind: 'c' | 'l', id: number, approve: boolean) {
  const a = await alertController.create({
    header: approve ? 'Approve request' : 'Reject request',
    inputs: [{ name: 'note', type: 'text', placeholder: 'Note (optional)' }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: approve ? 'Approve' : 'Reject', role: 'confirm' },
    ],
  });
  await a.present();
  const r = await a.onDidDismiss<{ values: { note?: string } }>();
  if (r.role !== 'confirm') return;
  const note = r.data?.values.note || undefined;
  try {
    if (kind === 'c') await attendanceApi.decideCorrection(id, approve, note);
    else {
      const res = await attendanceApi.decideLeave(id, approve, note);
      if (res.convertedRecords) await toast(`${res.convertedRecords} absence(s) changed to leave`);
    }
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
watch([tab, status], load);
</script>

<style scoped>
.empty {
  padding: 16px;
  color: var(--ion-color-medium);
}
</style>

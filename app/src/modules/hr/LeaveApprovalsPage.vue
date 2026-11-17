<template>
  <AppPage title="Leave requests" :on-refresh="load">
    <ion-segment v-model="status" @ion-change="load">
      <ion-segment-button value="pending">Pending</ion-segment-button>
      <ion-segment-button value="approved">Approved</ion-segment-button>
      <ion-segment-button value="rejected">Rejected</ion-segment-button>
      <ion-segment-button value="">All</ion-segment-button>
    </ion-segment>
    <ion-list>
      <ion-item v-for="l in leaves" :key="l.id">
        <ion-label class="ion-text-wrap">
          <h3>{{ l.employee?.name }} · {{ l.leaveType?.name }}</h3>
          <p>{{ l.fromDate }} → {{ l.toDate }} ({{ l.days }} day(s))</p>
          <p v-if="l.reason">{{ l.reason }}</p>
          <p v-if="l.decisionNote" class="muted">Note: {{ l.decisionNote }}</p>
        </ion-label>
        <template v-if="l.status === 'pending'">
          <ion-button slot="end" v-can="'hr.approve'" color="success" @click="decide(l.id, true)"
            >Approve</ion-button
          >
          <ion-button
            slot="end"
            v-can="'hr.approve'"
            color="danger"
            fill="outline"
            @click="decide(l.id, false)"
          >
            Reject
          </ion-button>
        </template>
        <template v-else>
          <ion-badge slot="end" :color="l.status === 'approved' ? 'success' : 'medium'">{{
            l.status
          }}</ion-badge>
          <ion-button
            v-if="l.status === 'approved'"
            slot="end"
            v-can="'hr.approve'"
            fill="clear"
            color="medium"
            @click="cancel(l.id)"
            >Cancel</ion-button
          >
        </template>
      </ion-item>
      <ion-item v-if="!leaves.length"><ion-label class="muted">No leave requests.</ion-label></ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonItem,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
  alertController,
} from '@ionic/vue';
import type { LeaveApplicationDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { hrApi } from './api';

const status = ref('pending');
const leaves = ref<LeaveApplicationDto[]>([]);

async function load() {
  try {
    leaves.value = (await hrApi.leaves({ status: status.value })).items;
  } catch (e) {
    await toastError(e);
  }
}

async function decide(id: number, approve: boolean) {
  const alert = await alertController.create({
    header: approve ? 'Approve leave' : 'Reject leave',
    inputs: [{ name: 'note', type: 'textarea', placeholder: 'Note (optional)' }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: approve ? 'Approve' : 'Reject',
        handler: (v: { note?: string }) =>
          hrApi
            .decideLeave(id, approve, v.note)
            .then(() => toast(approve ? 'Leave approved' : 'Leave rejected'))
            .then(load)
            .catch(toastError),
      },
    ],
  });
  await alert.present();
}

async function cancel(id: number) {
  await hrApi.cancelLeave(id).then(load).catch(toastError);
}

onMounted(load);
</script>

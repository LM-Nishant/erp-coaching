<template>
  <AppPage :title="t('hr.approvals.title')" :on-refresh="load">
    <ion-segment v-model="status" @ion-change="load">
      <ion-segment-button value="pending">{{ t('common.status.pending') }}</ion-segment-button>
      <ion-segment-button value="approved">{{ t('common.status.approved') }}</ion-segment-button>
      <ion-segment-button value="rejected">{{ t('common.status.rejected') }}</ion-segment-button>
      <ion-segment-button value="">{{ t('common.labels.all') }}</ion-segment-button>
    </ion-segment>
    <ion-list>
      <ion-item v-for="l in leaves" :key="l.id">
        <ion-label class="ion-text-wrap">
          <h3>{{ l.employee?.name }} · {{ l.leaveType?.name }}</h3>
          <p>{{ formatDate(l.fromDate) }} → {{ formatDate(l.toDate) }} ({{ t('hr.days', l.days) }})</p>
          <p v-if="l.reason">{{ l.reason }}</p>
          <p v-if="l.decisionNote" class="muted">{{ t('hr.approvals.note', { note: l.decisionNote }) }}</p>
        </ion-label>
        <template v-if="l.status === 'pending'">
          <ion-button slot="end" v-can="'hr.approve'" color="success" @click="decide(l.id, true)">{{
            t('common.actions.approve')
          }}</ion-button>
          <ion-button
            slot="end"
            v-can="'hr.approve'"
            color="danger"
            fill="outline"
            @click="decide(l.id, false)"
          >
            {{ t('common.actions.reject') }}
          </ion-button>
        </template>
        <template v-else>
          <StatusChip
            slot="end"
            :label="t(LEAVE_STATUS[l.status].label)"
            :tone="LEAVE_STATUS[l.status].tone"
          />
          <ion-button
            v-if="l.status === 'approved'"
            slot="end"
            v-can="'hr.approve'"
            fill="clear"
            color="medium"
            @click="cancel(l.id)"
            >{{ t('common.actions.cancel') }}</ion-button
          >
        </template>
      </ion-item>
      <ion-item v-if="!leaves.length"
        ><ion-label class="muted">{{ t('hr.approvals.empty') }}</ion-label></ion-item
      >
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { formatDate } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { LEAVE_STATUS, hrApi } from './api';

const { t } = useI18n();

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
    header: approve ? t('hr.approvals.approveTitle') : t('hr.approvals.rejectTitle'),
    inputs: [{ name: 'note', type: 'textarea', placeholder: t('hr.approvals.notePlaceholder') }],
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      {
        text: approve ? t('common.actions.approve') : t('common.actions.reject'),
        handler: (v: { note?: string }) =>
          hrApi
            .decideLeave(id, approve, v.note)
            .then(() => toast(approve ? t('hr.approvals.approved') : t('hr.approvals.rejected')))
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

<template>
  <AppPage title="Full & final settlement" :on-refresh="load">
    <ion-list v-can="'payroll.create'">
      <ion-list-header>Accepted separations awaiting settlement</ion-list-header>
      <ion-item v-for="s in pending" :key="s.id">
        <ion-label>
          <h3>{{ s.employee?.name }}</h3>
          <p>Last working day {{ s.lastWorkingDay }}</p>
        </ion-label>
        <ion-button slot="end" @click="compute(s.id)">Compute</ion-button>
      </ion-item>
      <ion-item v-if="!pending.length"><ion-label class="muted">None.</ion-label></ion-item>
    </ion-list>

    <ion-list>
      <ion-list-header>Settlements</ion-list-header>
      <ion-item v-for="s in settlements" :key="s.id" button @click="selected = s">
        <ion-label>
          <h3>{{ s.employee?.name }}</h3>
          <p>LWD {{ s.lastWorkingDay }} · net {{ rupees(s.net) }}</p>
        </ion-label>
        <ion-badge
          slot="end"
          :color="s.status === 'paid' ? 'success' : s.status === 'approved' ? 'warning' : 'medium'"
        >
          {{ s.status }}
        </ion-badge>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!selected" @did-dismiss="selected = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ selected?.employee?.name }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="selected = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="selected">
        <ion-list>
          <ion-item v-for="(l, i) in selected.lines" :key="i">
            <ion-label class="ion-text-wrap">{{ l.name }}</ion-label>
            <ion-note slot="end" :color="l.type === 'deduction' ? 'danger' : undefined">
              {{ l.type === 'deduction' ? '−' : '' }}{{ rupees(l.amount) }}
            </ion-note>
          </ion-item>
          <ion-item>
            <ion-label><strong>Net payable</strong></ion-label>
            <ion-note slot="end"
              ><strong>{{ rupees(selected.net) }}</strong></ion-note
            >
          </ion-item>
        </ion-list>
        <div class="ion-padding">
          <template v-if="selected.status === 'draft'">
            <ion-button
              v-can="'payroll.create'"
              expand="block"
              fill="outline"
              @click="compute(selected.separationId, true)"
            >
              Recompute waiving notice recovery
            </ion-button>
            <ion-button v-can="'payroll.approve'" expand="block" @click="transition('approve')"
              >Approve</ion-button
            >
          </template>
          <ion-button
            v-if="selected.status === 'approved'"
            v-can="'payroll.approve'"
            expand="block"
            color="success"
            @click="transition('pay')"
          >
            Mark paid
          </ion-button>
        </div>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { hrApi, rupees, type Separation } from '../hr/api';
import { payrollApi, type Settlement } from './api';

const settlements = ref<Settlement[]>([]);
const separations = ref<Separation[]>([]);
const selected = ref<Settlement | null>(null);
const pending = computed(() =>
  separations.value.filter((s) => !settlements.value.some((x) => x.separationId === s.id)),
);

async function load() {
  try {
    [settlements.value, separations.value] = await Promise.all([
      payrollApi.settlements(),
      hrApi
        .separations()
        .then((all) => all.filter((s) => s.status === 'accepted' || s.status === 'completed')),
    ]);
  } catch (e) {
    await toastError(e);
  }
}

async function compute(separationId: number, waive = false) {
  try {
    selected.value = await payrollApi.computeSettlement(separationId, waive);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function transition(action: 'approve' | 'pay') {
  if (!selected.value) return;
  try {
    selected.value = {
      ...selected.value,
      ...(await payrollApi.transitionSettlement(selected.value.id, action)),
    };
    await toast(action === 'pay' ? 'Marked paid' : 'Approved');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>

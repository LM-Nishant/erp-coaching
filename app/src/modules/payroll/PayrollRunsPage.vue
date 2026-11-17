<template>
  <AppPage title="Payroll runs" :on-refresh="load">
    <form v-can="'payroll.create'" class="row" @submit.prevent="create">
      <ion-item>
        <ion-input
          v-model="month"
          type="month"
          label="New run for month"
          label-placement="stacked"
          required
        />
      </ion-item>
      <ion-button type="submit" :disabled="saving">Create draft run</ion-button>
    </form>
    <ion-list>
      <ion-item v-for="r in runs" :key="r.id" :router-link="`/payroll/runs/${r.id}`" button>
        <ion-label>
          <h2>{{ MONTHS[r.periodMonth - 1] }} {{ r.periodYear }}</h2>
          <p>{{ r.employeeCount }} employee(s) · net {{ rupees(r.totalNet) }}</p>
        </ion-label>
        <ion-badge slot="end" :color="STATUS_COLORS[r.status]">{{ r.status }}</ion-badge>
      </ion-item>
      <ion-item v-if="!runs.length"><ion-label class="muted">No payroll runs yet.</ion-label></ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IonBadge, IonButton, IonInput, IonItem, IonLabel, IonList } from '@ionic/vue';
import type { PayrollRunDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { MONTHS, rupees, todayIso } from '../hr/api';
import { payrollApi } from './api';

const STATUS_COLORS = { draft: 'medium', approved: 'warning', locked: 'success' } as const;
const router = useRouter();
const runs = ref<PayrollRunDto[]>([]);
const month = ref(todayIso().slice(0, 7));
const saving = ref(false);

async function load() {
  try {
    runs.value = (await payrollApi.runs()).items;
  } catch (e) {
    await toastError(e);
  }
}

async function create() {
  const [y, m] = month.value.split('-').map(Number);
  saving.value = true;
  try {
    const run = await payrollApi.createRun(y, m);
    await payrollApi.generate(run.id);
    await router.push(`/payroll/runs/${run.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

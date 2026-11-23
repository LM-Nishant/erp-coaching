<template>
  <AppPage :title="t('payroll.runs.title')" :on-refresh="load">
    <form v-can="'payroll.create'" class="row" @submit.prevent="create">
      <ion-item>
        <ion-input
          v-model="month"
          type="month"
          :label="t('payroll.runs.newRunMonth')"
          label-placement="stacked"
          required
        />
      </ion-item>
      <ion-button type="submit" :disabled="saving">{{ t('payroll.runs.create') }}</ion-button>
    </form>
    <ion-list>
      <ion-item v-for="r in runs" :key="r.id" :router-link="`/payroll/runs/${r.id}`" button>
        <ion-label>
          <h2>{{ formatMonth(r.periodYear, r.periodMonth) }}</h2>
          <p>
            {{ t('payroll.employees', r.employeeCount) }} ·
            {{ t('payroll.runs.net', { amount: formatMoney(r.totalNet) }) }}
          </p>
        </ion-label>
        <StatusChip slot="end" :label="t(RUN_STATUS[r.status].label)" :tone="RUN_STATUS[r.status].tone" />
      </ion-item>
      <ion-item v-if="!runs.length"
        ><ion-label class="muted">{{ t('payroll.runs.empty') }}</ion-label></ion-item
      >
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { IonButton, IonInput, IonItem, IonLabel, IonList } from '@ionic/vue';
import type { PayrollRunDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatMoney } from '@/core/format';
import { toastError } from '@/core/toast';
import { formatMonth, todayIso } from '../hr/api';
import { RUN_STATUS, payrollApi } from './api';

const { t } = useI18n();
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

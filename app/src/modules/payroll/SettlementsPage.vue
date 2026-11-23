<template>
  <AppPage :title="t('payroll.settlements.title')" :on-refresh="load">
    <ion-list v-can="'payroll.create'">
      <ion-list-header>{{ t('payroll.settlements.awaiting') }}</ion-list-header>
      <ion-item v-for="s in pending" :key="s.id">
        <ion-label>
          <h3>{{ s.employee?.name }}</h3>
          <p>{{ t('payroll.settlements.lastDay', { date: formatDate(s.lastWorkingDay) }) }}</p>
        </ion-label>
        <ion-button slot="end" @click="compute(s.id)">{{ t('payroll.settlements.compute') }}</ion-button>
      </ion-item>
      <ion-item v-if="!pending.length"
        ><ion-label class="muted">{{ t('common.labels.none') }}</ion-label></ion-item
      >
    </ion-list>

    <ion-list>
      <ion-list-header>{{ t('payroll.settlements.list') }}</ion-list-header>
      <ion-item v-for="s in settlements" :key="s.id" button @click="selected = s">
        <ion-label>
          <h3>{{ s.employee?.name }}</h3>
          <p>
            {{
              t('payroll.settlements.row', { date: formatDate(s.lastWorkingDay), amount: formatMoney(s.net) })
            }}
          </p>
        </ion-label>
        <StatusChip
          slot="end"
          :label="t(SETTLEMENT_STATUS[s.status].label)"
          :tone="SETTLEMENT_STATUS[s.status].tone"
        />
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!selected" @did-dismiss="selected = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ selected?.employee?.name }}</ion-title>
          <ion-buttons slot="end"
            ><ion-button @click="selected = null">{{ t('common.actions.close') }}</ion-button></ion-buttons
          >
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="selected">
        <ion-list>
          <ion-item v-for="(l, i) in selected.lines" :key="i">
            <ion-label class="ion-text-wrap">{{ l.name }}</ion-label>
            <ion-note slot="end" :color="l.type === 'deduction' ? 'danger' : undefined">
              {{ l.type === 'deduction' ? '−' : '' }}{{ formatMoney(l.amount) }}
            </ion-note>
          </ion-item>
          <ion-item>
            <ion-label
              ><strong>{{ t('payroll.settlements.netPayable') }}</strong></ion-label
            >
            <ion-note slot="end"
              ><strong>{{ formatMoney(selected.net) }}</strong></ion-note
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
              {{ t('payroll.settlements.recompute') }}
            </ion-button>
            <ion-button v-can="'payroll.approve'" expand="block" @click="transition('approve')">{{
              t('common.actions.approve')
            }}</ion-button>
          </template>
          <ion-button
            v-if="selected.status === 'approved'"
            v-can="'payroll.approve'"
            expand="block"
            color="success"
            @click="transition('pay')"
          >
            {{ t('payroll.settlements.markPaid') }}
          </ion-button>
        </div>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { formatDate, formatMoney } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { hrApi, type Separation } from '../hr/api';
import { SETTLEMENT_STATUS, payrollApi, type Settlement } from './api';

const { t } = useI18n();

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
    await toast(action === 'pay' ? t('payroll.settlements.markedPaid') : t('common.status.approved'));
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>

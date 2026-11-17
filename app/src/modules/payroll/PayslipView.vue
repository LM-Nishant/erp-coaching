<template>
  <ion-list>
    <ion-item lines="none">
      <ion-label>
        <h2>{{ slip.employee?.name }} · {{ MONTHS[slip.periodMonth - 1] }} {{ slip.periodYear }}</h2>
        <p>
          Payable {{ slip.payableDays }}/{{ slip.daysInMonth }} days · LOP {{ slip.lopDays }}
          <span v-if="slip.units.lecture"> · {{ slip.units.lecture }} lecture(s)</span>
          <span v-if="slip.units.class"> · {{ slip.units.class }} class(es)</span>
        </p>
      </ion-label>
    </ion-item>
    <template v-for="group in GROUPS" :key="group.type">
      <ion-list-header v-if="slip.lines.some((l) => l.type === group.type)">{{
        group.title
      }}</ion-list-header>
      <ion-item v-for="l in slip.lines.filter((x) => x.type === group.type)" :key="`${l.type}-${l.code}`">
        <ion-label>{{ l.name }}</ion-label>
        <ion-note slot="end">{{ rupees(l.amount) }}</ion-note>
      </ion-item>
    </template>
    <ion-item
      ><ion-label>Gross</ion-label><ion-note slot="end">{{ rupees(slip.gross) }}</ion-note></ion-item
    >
    <ion-item
      ><ion-label>Deductions</ion-label
      ><ion-note slot="end">{{ rupees(slip.totalDeductions) }}</ion-note></ion-item
    >
    <ion-item>
      <ion-label><strong>Net pay</strong></ion-label>
      <ion-note slot="end"
        ><strong>{{ rupees(slip.net) }}</strong></ion-note
      >
    </ion-item>
  </ion-list>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonList, IonListHeader, IonNote } from '@ionic/vue';
import type { PayslipDto } from '@erp/shared';
import { MONTHS, rupees } from '../hr/api';

defineProps<{ slip: PayslipDto }>();
const GROUPS = [
  { type: 'earning', title: 'Earnings' },
  { type: 'deduction', title: 'Deductions' },
  { type: 'employer', title: 'Employer contributions' },
] as const;
</script>

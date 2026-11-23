<template>
  <ion-list>
    <ion-item lines="none">
      <ion-label>
        <h2>{{ slip.employee?.name }} · {{ formatMonth(slip.periodYear, slip.periodMonth) }}</h2>
        <p>
          {{
            t('payroll.slip.days', {
              payable: formatNumber(slip.payableDays),
              total: formatNumber(slip.daysInMonth),
              lop: formatNumber(slip.lopDays),
            })
          }}
          <span v-if="slip.units.lecture"> · {{ t('payroll.slip.lectures', slip.units.lecture) }}</span>
          <span v-if="slip.units.class"> · {{ t('payroll.slip.classes', slip.units.class) }}</span>
        </p>
      </ion-label>
    </ion-item>
    <template v-for="type in GROUPS" :key="type">
      <ion-list-header v-if="slip.lines.some((l) => l.type === type)">{{
        t(`payroll.slip.${type}`)
      }}</ion-list-header>
      <ion-item v-for="l in slip.lines.filter((x) => x.type === type)" :key="`${l.type}-${l.code}`">
        <ion-label>{{ l.name }}</ion-label>
        <ion-note slot="end">{{ formatMoney(l.amount) }}</ion-note>
      </ion-item>
    </template>
    <ion-item
      ><ion-label>{{ t('payroll.gross') }}</ion-label
      ><ion-note slot="end">{{ formatMoney(slip.gross) }}</ion-note></ion-item
    >
    <ion-item
      ><ion-label>{{ t('payroll.deductions') }}</ion-label
      ><ion-note slot="end">{{ formatMoney(slip.totalDeductions) }}</ion-note></ion-item
    >
    <ion-item>
      <ion-label
        ><strong>{{ t('payroll.netPay') }}</strong></ion-label
      >
      <ion-note slot="end"
        ><strong>{{ formatMoney(slip.net) }}</strong></ion-note
      >
    </ion-item>
  </ion-list>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { IonItem, IonLabel, IonList, IonListHeader, IonNote } from '@ionic/vue';
import type { PayslipDto } from '@erp/shared';
import { formatMoney, formatNumber } from '@/core/format';
import { formatMonth } from '../hr/api';

defineProps<{ slip: PayslipDto }>();
const { t } = useI18n();
const GROUPS = ['earning', 'deduction', 'employer'] as const;
</script>

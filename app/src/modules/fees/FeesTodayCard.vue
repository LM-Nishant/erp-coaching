<template>
  <div v-if="s" class="today">
    <div class="nums">
      <router-link to="/fees/accounts" class="num">
        <span class="value">{{ formatMoney(s.todayCollection) }}</span>
        <span class="label">{{ t('fees.today.collected') }}</span>
      </router-link>
      <router-link to="/fees/accounts?dues=1" class="num">
        <span class="value danger">{{ formatMoneyCompact(s.overdue) }}</span>
        <span class="label">{{ t('fees.today.overdue', { n: s.defaulters }, s.defaulters) }}</span>
      </router-link>
    </div>
    <ion-item
      v-if="s.pendingPaymentApprovals"
      router-link="/fees/approvals"
      lines="none"
      detail
      button
      class="row"
    >
      <ion-label>{{
        t('fees.today.approvals', { n: s.pendingPaymentApprovals }, s.pendingPaymentApprovals)
      }}</ion-label>
    </ion-item>
    <p class="muted month">{{ t('fees.today.month', { amount: formatMoneyCompact(s.monthCollection) }) }}</p>
  </div>
  <p v-else-if="failed" class="muted">{{ t('fees.today.failed') }}</p>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonItem, IonLabel } from '@ionic/vue';
import { formatMoney, formatMoneyCompact } from '@/core/format';
import { feesApi, type FeeSummary } from './api';

/** Staff home: money in today and who is overdue. */
const { t } = useI18n();
const s = ref<FeeSummary | null>(null);
const failed = ref(false);

onMounted(async () => {
  try {
    s.value = await feesApi.summary();
  } catch {
    failed.value = true;
  }
});
</script>

<style scoped>
.nums {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.num {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--ion-color-light);
  color: inherit;
  text-decoration: none;
}
.value {
  font-size: 20px;
  font-weight: 700;
  color: var(--ion-text-color);
}
.value.danger {
  color: var(--ion-color-danger);
}
.label {
  font-size: 13px;
  color: var(--ion-color-medium-shade);
}
.row {
  --padding-start: 0;
  --background: transparent;
  margin-top: 6px;
}
.muted {
  color: var(--ion-color-medium);
}
.month {
  margin: 8px 0 0;
  font-size: 13px;
}
</style>

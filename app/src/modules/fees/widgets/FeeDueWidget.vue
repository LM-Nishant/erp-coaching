<template>
  <div v-if="!loaded" class="skeleton" aria-hidden="true" />
  <template v-else-if="data">
    <div class="amount" :class="{ clear: !data.totalDue }">
      {{
        data.totalDue
          ? t('fees.my.due', { amount: formatMoney(data.totalDue) })
          : t('fees.widgets.nothingDue')
      }}
    </div>
    <p v-if="next" class="muted next">
      {{
        t('fees.widgets.nextDue', {
          amount: formatMoney(next.instalment.balance),
          date: formatDate(next.instalment.dueDate),
        })
      }}
      <StatusChip :label="t(`fees.my.state.${state}`)" :tone="STATE_TONE[state!]" />
    </p>
    <ion-button
      v-if="data.totalDue && data.gateways.length && auth.can('my-fees.create')"
      expand="block"
      class="pay"
      :router-link="link"
      >{{ t('fees.widgets.payNow') }}</ion-button
    >
    <ion-button v-else expand="block" fill="outline" class="pay" :router-link="link">{{
      t('fees.widgets.view')
    }}</ion-button>
  </template>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonButton } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import type { MyFeesDto, ParentChildDto } from '@erp/shared';
import StatusChip from '@/components/StatusChip.vue';
import { formatDate, formatMoney } from '@/core/format';
import { useAuthStore } from '@/stores/auth';
import { feesApi } from '../api';
import { STATE_TONE, instalmentState, nextInstalment } from '../my-fees';

/** Student home and parent home (with `child`): what is due, by when, and a Pay button when online payment is on. */
const props = defineProps<{ child?: ParentChildDto }>();
const { t } = useI18n();
const auth = useAuthStore();
const data = ref<MyFeesDto | null>(null);
const loaded = ref(false);

const next = computed(() => (data.value ? nextInstalment(data.value.accounts) : null));
const state = computed(() => (next.value ? instalmentState(next.value.instalment) : null));
const link = computed(() =>
  props.child ? { path: '/my-fees', query: { student: String(props.child.studentId) } } : '/my-fees',
);

onMounted(async () => {
  try {
    data.value = await feesApi.my(props.child?.studentId);
  } catch {
    data.value = null;
  } finally {
    loaded.value = true;
  }
});
</script>

<style scoped>
.amount {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--ion-color-warning-shade);
}
.amount.clear {
  color: var(--ion-color-success);
}
.next {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.pay {
  margin-top: 12px;
  min-height: var(--app-tap-target, 48px);
}
.skeleton {
  height: 96px;
  border-radius: 8px;
  background: var(--ion-color-light);
}
</style>

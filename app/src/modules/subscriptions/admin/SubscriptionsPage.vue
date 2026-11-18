<template>
  <AppPage title="Subscriptions" :on-refresh="reload">
    <ion-searchbar v-model="search" :debounce="400" placeholder="Search institute name or slug" />
    <div class="filters">
      <ion-select v-model="state" label="Access" label-placement="stacked" interface="popover">
        <ion-select-option value="">All</ion-select-option>
        <ion-select-option v-for="s in STATES" :key="s" :value="s">{{
          ACCESS_STATE_LABELS[s]
        }}</ion-select-option>
      </ion-select>
      <ion-select v-model="planId" label="Plan" label-placement="stacked" interface="popover">
        <ion-select-option :value="0">All plans</ion-select-option>
        <ion-select-option v-for="p in plans" :key="p.id" :value="p.id">{{ p.name }}</ion-select-option>
      </ion-select>
    </div>

    <ion-list>
      <ion-item
        v-for="r in rows"
        :key="r.instituteId"
        button
        :router-link="`/admin/billing/institutes/${r.instituteId}`"
      >
        <ion-label class="ion-text-wrap">
          <h2>{{ r.instituteName }}</h2>
          <p>{{ r.instituteSlug }} · {{ planLine(r) }}</p>
          <p v-if="dateLine(r)">{{ dateLine(r) }}</p>
        </ion-label>
        <div slot="end" class="end">
          <ion-badge :color="ACCESS_STATE_COLORS[r.state]">{{ ACCESS_STATE_LABELS[r.state] }}</ion-badge>
          <ion-badge v-if="r.instituteStatus !== 'active'" color="medium"
            >institute {{ r.instituteStatus }}</ion-badge
          >
          <span v-if="r.openBalancePaise" class="due">{{ rupees(r.openBalancePaise) }} due</span>
        </div>
      </ion-item>
    </ion-list>
    <p class="muted">{{ total }} institute(s)</p>
    <ion-button v-if="rows.length < total" fill="clear" expand="block" :disabled="loading" @click="more"
      >Load more</ion-button
    >
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
} from '@ionic/vue';
import type { AdminSubscriptionRowDto, PlanDto, SubscriptionAccessState } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { adminApi } from '@/modules/admin/api';
import { rupees } from '@/modules/hr/api';
import { billingAdminApi } from '../api';
import { ACCESS_STATE_COLORS, ACCESS_STATE_LABELS, formatDate } from '../format';

const STATES: SubscriptionAccessState[] = ['trial', 'active', 'grace', 'restricted', 'suspended', 'none'];
const PAGE_SIZE = 25;

const rows = ref<AdminSubscriptionRowDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const search = ref('');
const state = ref<SubscriptionAccessState | ''>('');
const planId = ref(0);
const plans = ref<PlanDto[]>([]);

function planLine(r: AdminSubscriptionRowDto) {
  const s = r.subscription;
  if (!s) return 'no subscription';
  return `${s.plan?.name ?? `plan #${s.planId}`} · ${s.billingCycle}${s.status === 'trial' ? ' · trial' : ''}`;
}

function dateLine(r: AdminSubscriptionRowDto) {
  const s = r.subscription;
  if (!s) return '';
  if (s.suspendedAt)
    return `Suspended ${formatDate(s.suspendedAt)}${s.suspendReason ? `: ${s.suspendReason}` : ''}`;
  if (r.state === 'grace' && r.graceEndsAt) return `Grace until ${formatDate(r.graceEndsAt)}`;
  if (!s.endsAt) return 'No expiry (platform-managed)';
  return `${s.status === 'trial' ? 'Trial ends' : 'Period ends'} ${formatDate(s.endsAt)}`;
}

async function fetch(p: number) {
  loading.value = true;
  try {
    const res = await billingAdminApi.subscriptions({
      page: p,
      pageSize: PAGE_SIZE,
      search: search.value.trim() || undefined,
      state: state.value || undefined,
      planId: planId.value || undefined,
    });
    rows.value = p === 1 ? res.items : [...rows.value, ...res.items];
    total.value = res.total;
    page.value = p;
  } catch (e) {
    void toastError(e);
  } finally {
    loading.value = false;
  }
}

const reload = () => fetch(1);
const more = () => fetch(page.value + 1);

watch([search, state, planId], reload);

onMounted(async () => {
  await reload();
  plans.value = await adminApi.plans().catch(() => []);
});
</script>

<style scoped>
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  padding: 0 8px 8px;
}
.end {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  font-size: 13px;
}
.due {
  color: var(--ion-color-danger);
  font-weight: 600;
}
</style>

<template>
  <AppPage title="Subscription & billing" :on-refresh="load">
    <p v-if="!o" class="muted">{{ failed ? 'Could not load your subscription.' : 'Loading…' }}</p>
    <template v-else>
      <ion-card v-if="o.status.message" :color="bannerColor" class="banner">
        <ion-card-content>
          <strong>{{ ACCESS_STATE_LABELS[o.status.state] }}.</strong> {{ o.status.message }}
        </ion-card-content>
      </ion-card>

      <div class="top">
        <ion-card>
          <ion-card-header>
            <ion-card-subtitle>Current plan</ion-card-subtitle>
            <ion-card-title>{{ o.plan?.name ?? 'No plan' }}</ion-card-title>
          </ion-card-header>
          <ion-card-content>
            <div class="chip-row">
              <ion-badge :color="ACCESS_STATE_COLORS[o.status.state]">{{
                ACCESS_STATE_LABELS[o.status.state]
              }}</ion-badge>
              <ion-badge v-if="sub" color="light">{{ sub.billingCycle }}</ion-badge>
            </div>
            <p v-if="o.plan && sub">
              {{ planPrice(o.plan, sub.billingCycle) ? rupees(planPrice(o.plan, sub.billingCycle)) : 'Free' }}
              {{ sub.billingCycle === 'yearly' ? 'per year' : 'per month' }} + GST
            </p>
            <p v-if="o.limits" class="small muted">{{ limitsSummary(o.limits) }}</p>
            <p v-if="sub" class="small">
              <template v-if="!sub.endsAt">No expiry date.</template>
              <template v-else-if="sub.status === 'trial'"
                >Free trial until {{ formatDate(sub.endsAt) }}.</template
              >
              <template v-else>Current period ends {{ formatDate(sub.endsAt) }}.</template>
              <template v-if="o.status.graceEndsAt && lapsed">
                Grace period until {{ formatDate(o.status.graceEndsAt) }}.</template
              >
            </p>
            <p v-if="sub && (sub.pendingPlanId || sub.pendingBillingCycle)" class="small">
              Changes to <strong>{{ sub.pendingPlan?.name ?? o.plan?.name }}</strong> ({{
                sub.pendingBillingCycle ?? sub.billingCycle
              }}) on {{ formatDate(sub.endsAt) }}.
              <ion-button v-if="canManage" size="small" fill="clear" :disabled="busy" @click="cancelChange"
                >Keep current plan</ion-button
              >
            </p>
            <p v-if="sub && !o.selfService" class="small muted">
              Your plan is managed by the platform team. Contact support to change it.
            </p>
            <p v-if="!sub" class="small muted">
              Your institute has no subscription. Contact support to get started.
            </p>
            <div v-if="canManage && o.selfService" class="actions">
              <ion-button :disabled="busy || o.status.state === 'suspended'" @click="renew">{{
                sub?.status === 'trial' ? 'Subscribe now' : 'Renew'
              }}</ion-button>
              <ion-button
                fill="outline"
                :disabled="busy || o.status.state === 'suspended'"
                @click="planOpen = true"
                >Change plan</ion-button
              >
            </div>
          </ion-card-content>
        </ion-card>

        <ion-card v-if="o.openInvoices.length">
          <ion-card-header>
            <ion-card-subtitle>Payment due</ion-card-subtitle>
            <ion-card-title>{{ rupees(totalDue) }}</ion-card-title>
          </ion-card-header>
          <ion-list lines="full">
            <ion-item
              v-for="i in o.openInvoices"
              :key="i.id"
              button
              :detail="false"
              @click="openInvoiceId = i.id"
            >
              <ion-label class="ion-text-wrap">
                {{ i.number }} · {{ INVOICE_KIND_LABELS[i.kind] }}
                <p>{{ rupees(i.balancePaise) }} · due {{ formatDay(i.dueDate) }}</p>
              </ion-label>
              <ion-button v-if="canManage" slot="end" size="small" @click.stop="payInvoice = i"
                >Pay</ion-button
              >
            </ion-item>
          </ion-list>
        </ion-card>
      </div>

      <h2 class="section">Usage</h2>
      <UsageMeters :usage="o.usage" :ai="o.ai" />

      <h2 class="section">Add-ons</h2>
      <ion-list v-if="addons.length">
        <ion-item v-for="a in addons" :key="a.id">
          <ion-label class="ion-text-wrap">
            {{ ADDON_LABELS[a.kind] }} · {{ addonSummary(a) }}
            <p>
              {{ rupees(a.unitPricePaise * a.quantity) }}
              {{
                a.kind === 'ai_credits'
                  ? `for ${formatMonth(a.periodMonth)}`
                  : `per ${cycleUnit(a.billingCycle)}`
              }}
              <template v-if="a.status === 'pending'"> · awaiting payment</template>
              <template v-if="a.cancelAtPeriodEnd"> · ends with the current period</template>
            </p>
          </ion-label>
          <ion-badge slot="end" :color="ADDON_STATUS_COLORS[a.status]">{{ a.status }}</ion-badge>
          <ion-button
            v-if="canManage && cancellable(a)"
            slot="end"
            fill="clear"
            color="danger"
            size="small"
            :disabled="busy"
            @click="cancelAddon(a)"
            >Cancel</ion-button
          >
        </ion-item>
      </ion-list>
      <p v-else class="muted">No add-ons.</p>
      <ion-button
        v-if="canManage && o.addonCatalogue.length"
        fill="outline"
        :disabled="busy || lapsed"
        @click="addonOpen = true"
        >Buy an add-on</ion-button
      >

      <h2 class="section">Billing history</h2>
      <BillingHistory :reload-key="historyKey" @open="openInvoiceId = $event" />

      <PlanChangeModal :open="planOpen" :overview="o" @close="planOpen = false" @done="actionDone" />
      <AddonModal :open="addonOpen" :overview="o" @close="addonOpen = false" @done="actionDone" />
    </template>

    <InvoiceDetailModal
      :invoice-id="openInvoiceId"
      :source="tenantInvoices"
      :can-pay="canManage"
      @close="openInvoiceId = null"
      @pay="pay"
      @changed="load"
    />
    <CheckoutModal :invoice="payInvoice" @close="payInvoice = null" @paid="paid" />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonItem,
  IonLabel,
  IonList,
  alertController,
} from '@ionic/vue';
import {
  ADDON_LABELS,
  type BillingActionResultDto,
  type BillingCycle,
  type BillingOverviewDto,
  type SaasInvoiceDto,
  type SubscriptionAddonDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '@/modules/hr/api';
import { useAuthStore } from '@/stores/auth';
import { billingApi, tenantInvoices } from './api';
import AddonModal from './components/AddonModal.vue';
import BillingHistory from './components/BillingHistory.vue';
import CheckoutModal from './components/CheckoutModal.vue';
import InvoiceDetailModal from './components/InvoiceDetailModal.vue';
import PlanChangeModal from './components/PlanChangeModal.vue';
import UsageMeters from './components/UsageMeters.vue';
import {
  ACCESS_STATE_COLORS,
  ACCESS_STATE_LABELS,
  ADDON_STATUS_COLORS,
  INVOICE_KIND_LABELS,
  addonSummary,
  formatDate,
  formatDay,
  limitsSummary,
  planPrice,
} from './format';
import { shareSubscriptionStatus } from './status';

const auth = useAuthStore();
const route = useRoute();

const o = ref<BillingOverviewDto | null>(null);
const failed = ref(false);
const busy = ref(false);
const planOpen = ref(false);
const addonOpen = ref(false);
const openInvoiceId = ref<number | null>(null);
const payInvoice = ref<SaasInvoiceDto | null>(null);
const historyKey = ref(0);

const sub = computed(() => o.value?.subscription ?? null);
const canManage = computed(() => !!o.value?.status.canManage);
const lapsed = computed(() => ['grace', 'restricted', 'suspended'].includes(o.value?.status.state ?? ''));
const bannerColor = computed(() => {
  const state = o.value?.status.state;
  if (state === 'restricted' || state === 'suspended') return 'danger';
  if (state === 'grace' || state === 'none') return 'warning';
  return 'light';
});
const totalDue = computed(() => o.value?.openInvoices.reduce((t, i) => t + i.balancePaise, 0) ?? 0);
const addons = computed(
  () => o.value?.addons.filter((a) => a.status === 'pending' || a.status === 'active') ?? [],
);

const cycleUnit = (c: BillingCycle) => (c === 'yearly' ? 'year' : 'month');
const formatMonth = (m: string | null) =>
  m
    ? new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString('en-IN', {
        month: 'long',
        year: 'numeric',
      })
    : 'this month';
const cancellable = (a: SubscriptionAddonDto) =>
  a.status === 'pending' || (a.status === 'active' && a.kind !== 'ai_credits' && !a.cancelAtPeriodEnd);

async function load() {
  const instituteId = auth.me?.institute?.id;
  try {
    o.value = await billingApi.overview();
    failed.value = false;
    if (instituteId) shareSubscriptionStatus(o.value.status, instituteId);
  } catch (e) {
    failed.value = true;
    void toastError(e);
  }
  historyKey.value++;
}

async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function actionDone(result: BillingActionResultDto) {
  planOpen.value = false;
  addonOpen.value = false;
  await toast(result.message, result.invoice ? 'medium' : 'success');
  if (result.invoice) payInvoice.value = result.invoice;
  await load();
}

const renew = () => run(async () => actionDone(await billingApi.renew()));

const cancelChange = () =>
  run(async () => {
    await billingApi.cancelPlanChange();
    await toast('The scheduled change was cancelled');
    await load();
  });

async function cancelAddon(a: SubscriptionAddonDto) {
  const alert = await alertController.create({
    header: 'Cancel add-on?',
    message:
      a.status === 'pending'
        ? 'The unpaid add-on and its invoice are cancelled.'
        : 'The add-on stays active until the end of the current period and is not renewed.',
    buttons: [
      'Keep it',
      {
        text: 'Cancel add-on',
        role: 'destructive',
        handler: () =>
          void run(async () => {
            await billingApi.cancelAddon(a.id);
            await toast('Add-on cancelled');
            await load();
          }),
      },
    ],
  });
  await alert.present();
}

function pay(invoice: SaasInvoiceDto) {
  openInvoiceId.value = null;
  payInvoice.value = invoice;
}

async function paid() {
  payInvoice.value = null;
  await load();
}

onMounted(async () => {
  await load();
  const invoice = Number(route.query.invoice);
  if (Number.isInteger(invoice) && invoice > 0) openInvoiceId.value = invoice;
});
</script>

<style scoped>
.banner {
  margin: 0 0 12px;
}
.top {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  align-items: start;
}
.top ion-card {
  margin: 0;
}
.section {
  font-size: 18px;
  margin: 24px 0 8px;
}
.small {
  font-size: 13px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
</style>

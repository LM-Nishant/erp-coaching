<template>
  <AppPage
    :title="institute?.name ?? 'Institute billing'"
    back-href="/admin/billing/subscriptions"
    :on-refresh="load"
  >
    <p v-if="!o" class="muted">{{ failed ? 'Could not load the subscription.' : 'Loading…' }}</p>
    <template v-else>
      <ion-card v-if="o.status.message" :color="bannerColor" class="banner">
        <ion-card-content>
          <strong>{{ ACCESS_STATE_LABELS[o.status.state] }}.</strong> {{ o.status.message }}
        </ion-card-content>
      </ion-card>

      <div class="top">
        <ion-card>
          <ion-card-header>
            <ion-card-subtitle>{{ institute?.slug ?? 'Subscription' }}</ion-card-subtitle>
            <ion-card-title>{{ o.plan?.name ?? 'No plan' }}</ion-card-title>
          </ion-card-header>
          <ion-card-content>
            <div class="chip-row">
              <ion-badge :color="ACCESS_STATE_COLORS[o.status.state]">{{
                ACCESS_STATE_LABELS[o.status.state]
              }}</ion-badge>
              <ion-badge v-if="sub" color="light">{{ sub.billingCycle }}</ion-badge>
              <ion-badge v-if="sub" color="light">{{ sub.status }}</ion-badge>
              <ion-badge v-if="institute && institute.status !== 'active'" color="medium"
                >institute {{ institute.status }}</ion-badge
              >
            </div>
            <p v-if="o.plan && sub">
              {{ planPrice(o.plan, sub.billingCycle) ? rupees(planPrice(o.plan, sub.billingCycle)) : 'Free' }}
              {{ sub.billingCycle === 'yearly' ? 'per year' : 'per month' }} + GST
            </p>
            <p v-if="o.limits" class="small muted">{{ limitsSummary(o.limits) }}</p>
            <p v-if="sub?.limitOverrides" class="small muted">Custom limits apply to this institute.</p>
            <p v-if="sub" class="small">
              <template v-if="!sub.endsAt">No end date (managed by the platform team).</template>
              <template v-else-if="sub.status === 'trial'"
                >Free trial until {{ formatDate(sub.endsAt) }}.</template
              >
              <template v-else>Current period ends {{ formatDate(sub.endsAt) }}.</template>
              <template v-if="sub.trialExtendedDays">
                Trial extended by {{ sub.trialExtendedDays }} day(s).</template
              >
              <template v-if="o.status.graceEndsAt && lapsed">
                Grace period until {{ formatDate(o.status.graceEndsAt) }}.</template
              >
              <template v-if="o.status.suspendsAt"> Suspends {{ formatDate(o.status.suspendsAt) }}.</template>
            </p>
            <p v-if="sub?.suspendedAt" class="small danger">
              Suspended by the platform team on {{ formatDate(sub.suspendedAt)
              }}<template v-if="sub.suspendReason">: {{ sub.suspendReason }}</template
              >.
            </p>
            <p v-if="sub && (sub.pendingPlanId || sub.pendingBillingCycle)" class="small">
              Changes to <strong>{{ sub.pendingPlan?.name ?? o.plan?.name }}</strong> ({{
                sub.pendingBillingCycle ?? sub.billingCycle
              }}) on {{ formatDate(sub.endsAt) }}.
            </p>
            <div class="actions">
              <ion-button size="small" :disabled="busy" @click="openAssign">Assign plan</ion-button>
              <ion-button
                v-if="sub?.status === 'trial' && sub.endsAt"
                size="small"
                fill="outline"
                :disabled="busy"
                @click="extendTrial"
                >Extend trial</ion-button
              >
              <ion-button
                v-if="sub && sub.status !== 'trial' && sub.endsAt"
                size="small"
                fill="outline"
                :disabled="busy"
                @click="extendPeriod"
                >Extend period</ion-button
              >
              <ion-button
                v-if="sub?.endsAt"
                size="small"
                fill="outline"
                :disabled="busy"
                @click="renewalInvoice"
                >Renewal invoice</ion-button
              >
              <ion-button size="small" fill="outline" :disabled="busy" @click="invoiceOpen = true"
                >New invoice</ion-button
              >
              <ion-button
                v-if="sub?.suspendedAt"
                size="small"
                color="success"
                :disabled="busy"
                @click="reactivate"
                >Reactivate</ion-button
              >
              <ion-button
                v-else-if="sub"
                size="small"
                fill="outline"
                color="danger"
                :disabled="busy"
                @click="suspend"
                >Suspend</ion-button
              >
            </div>
          </ion-card-content>
        </ion-card>

        <ion-card v-if="o.openInvoices.length">
          <ion-card-header>
            <ion-card-subtitle>Outstanding</ion-card-subtitle>
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
            </ion-item>
          </ion-list>
        </ion-card>
      </div>

      <h2 class="section">Usage</h2>
      <UsageMeters :usage="o.usage" :ai="o.ai" />

      <h2 class="section">Daily usage (last 30 days)</h2>
      <div v-if="snapshots.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Students</th>
              <th>Branches</th>
              <th>Teachers</th>
              <th>Storage</th>
              <th>AI tokens (month)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in snapshots" :key="s.snapshotDate">
              <td>{{ formatDay(s.snapshotDate) }}</td>
              <td>{{ s.students }}</td>
              <td>{{ s.branches }}</td>
              <td>{{ s.teachers }}</td>
              <td>{{ formatMb(s.storageMb) }}</td>
              <td>{{ s.aiTokensMonth.toLocaleString('en-IN') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">No snapshots yet. They are taken by the hourly billing sweep.</p>

      <h2 class="section">Add-ons</h2>
      <ion-list v-if="o.addons.length">
        <ion-item v-for="a in o.addons" :key="a.id">
          <ion-label class="ion-text-wrap">
            {{ ADDON_LABELS[a.kind] }} · {{ addonSummary(a) }}
            <p>
              {{ rupees(a.unitPricePaise * a.quantity) }} ·
              {{ a.kind === 'ai_credits' ? `month ${formatDay(a.periodMonth)}` : a.billingCycle }}
              <template v-if="a.startsAt"> · since {{ formatDate(a.startsAt) }}</template>
              <template v-if="a.cancelAtPeriodEnd"> · ends with the current period</template>
            </p>
          </ion-label>
          <ion-badge slot="end" :color="ADDON_STATUS_COLORS[a.status]">{{ a.status }}</ion-badge>
        </ion-item>
      </ion-list>
      <p v-else class="muted">No add-ons.</p>

      <h2 class="section">Billing history</h2>
      <BillingHistory
        admin
        :institute-id="id"
        :reload-key="historyKey"
        @open="openInvoiceId = $event"
        @changed="load"
      />

      <ManualInvoiceModal
        :open="invoiceOpen"
        :institute-id="id"
        :gst-rate-percent="o.gstRatePercent"
        @close="invoiceOpen = false"
        @created="invoiceCreated"
      />
      <AssignPlanModal
        :open="assignOpen"
        :institute-id="id"
        :plans="allPlans"
        :current="sub"
        @close="assignOpen = false"
        @done="assigned"
      />
    </template>

    <InvoiceDetailModal
      :invoice-id="openInvoiceId"
      :source="adminInvoices"
      admin
      @close="openInvoiceId = null"
      @changed="load"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
  type BillingOverviewDto,
  type PlanDto,
  type SaasInvoiceDto,
  type UsageSnapshotDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { adminApi, type InstituteDetail } from '@/modules/admin/api';
import { rupees } from '@/modules/hr/api';
import { adminInvoices, billingAdminApi } from '../api';
import BillingHistory from '../components/BillingHistory.vue';
import InvoiceDetailModal from '../components/InvoiceDetailModal.vue';
import UsageMeters from '../components/UsageMeters.vue';
import {
  ACCESS_STATE_COLORS,
  ACCESS_STATE_LABELS,
  ADDON_STATUS_COLORS,
  INVOICE_KIND_LABELS,
  addonSummary,
  formatDate,
  formatDay,
  formatMb,
  limitsSummary,
  planPrice,
} from '../format';
import AssignPlanModal from './components/AssignPlanModal.vue';
import ManualInvoiceModal from './components/ManualInvoiceModal.vue';

const route = useRoute();

const id = ref(0);
const institute = ref<InstituteDetail | null>(null);
const o = ref<BillingOverviewDto | null>(null);
const snapshots = ref<UsageSnapshotDto[]>([]);
const allPlans = ref<PlanDto[]>([]);
const failed = ref(false);
const busy = ref(false);
const invoiceOpen = ref(false);
const assignOpen = ref(false);
const openInvoiceId = ref<number | null>(null);
const historyKey = ref(0);

const sub = computed(() => o.value?.subscription ?? null);
const lapsed = computed(() => ['grace', 'restricted', 'suspended'].includes(o.value?.status.state ?? ''));
const bannerColor = computed(() => {
  const state = o.value?.status.state;
  if (state === 'restricted' || state === 'suspended') return 'danger';
  if (state === 'grace' || state === 'none') return 'warning';
  return 'light';
});
const totalDue = computed(() => o.value?.openInvoices.reduce((t, i) => t + i.balancePaise, 0) ?? 0);

async function load() {
  if (!id.value) return;
  try {
    const [overview, detail, days] = await Promise.all([
      billingAdminApi.overview(id.value),
      adminApi.institute(id.value),
      billingAdminApi.snapshots(id.value),
    ]);
    o.value = overview;
    institute.value = detail;
    snapshots.value = [...days].sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
    failed.value = false;
  } catch (e) {
    failed.value = true;
    void toastError(e);
  }
  historyKey.value++;
}

async function run(fn: () => Promise<unknown>, done: string) {
  busy.value = true;
  try {
    await fn();
    await toast(done);
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

/** Asks for a whole number of days in [1, max]; resolves null when cancelled. */
async function askDays(header: string, message: string, max: number, optional = false) {
  const alert = await alertController.create({
    header,
    message,
    inputs: [
      {
        name: 'days',
        type: 'number',
        min: 1,
        max,
        placeholder: optional ? 'Days (optional)' : 'Days',
      },
    ],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Apply',
        role: 'confirm',
        handler: (v: { days: string }) => {
          if (optional && !v.days) return true;
          const n = Number(v.days);
          if (!Number.isInteger(n) || n < 1 || n > max) {
            void toast(`Enter a whole number of days from 1 to ${max}`, 'warning');
            return false;
          }
          return true;
        },
      },
    ],
  });
  await alert.present();
  const { data, role } = await alert.onDidDismiss<{ values: { days: string } }>();
  if (role !== 'confirm') return null;
  return { days: data?.values.days ? Number(data.values.days) : null };
}

async function extendTrial() {
  const r = await askDays('Extend trial', 'Adds days to the end of the free trial.', 365);
  if (r?.days) await run(() => billingAdminApi.extendTrial(id.value, r.days as number), 'Trial extended');
}

async function extendPeriod() {
  const r = await askDays(
    'Extend period',
    'Adds free days to the current period (from today if it has already ended) and lifts any suspension.',
    366,
  );
  if (r?.days) await run(() => billingAdminApi.reactivate(id.value, r.days), 'Period extended');
}

async function reactivate() {
  const r = await askDays(
    'Reactivate',
    'Lifts the suspension. Optionally add free days to the current period as well.',
    366,
    true,
  );
  if (r) await run(() => billingAdminApi.reactivate(id.value, r.days), 'Subscription reactivated');
}

async function suspend() {
  const alert = await alertController.create({
    header: 'Suspend subscription',
    message: 'Institute users keep access only to billing until it is reactivated. Give a reason.',
    inputs: [{ name: 'reason', type: 'textarea', placeholder: 'Reason', attributes: { maxlength: 255 } }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Suspend',
        role: 'destructive',
        handler: (v: { reason: string }) => {
          const reason = v.reason.trim();
          if (reason.length < 3) {
            void toast('Give a reason of at least 3 characters', 'warning');
            return false;
          }
          void run(() => billingAdminApi.suspend(id.value, reason), 'Subscription suspended');
          return true;
        },
      },
    ],
  });
  await alert.present();
}

async function renewalInvoice() {
  busy.value = true;
  try {
    const result = await billingAdminApi.renewalInvoice(id.value);
    await toast(result.message, result.invoice ? 'success' : 'medium');
    await load();
    if (result.invoice) openInvoiceId.value = result.invoice.id;
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function openAssign() {
  try {
    if (!allPlans.value.length) allPlans.value = await adminApi.plans();
    assignOpen.value = true;
  } catch (e) {
    void toastError(e);
  }
}

async function assigned() {
  assignOpen.value = false;
  await load();
}

async function invoiceCreated(invoice: SaasInvoiceDto) {
  invoiceOpen.value = false;
  await load();
  openInvoiceId.value = invoice.id;
}

watch(
  () => (route.name === 'admin-billing-institute' ? Number(route.params.id) : 0),
  (next) => {
    if (!Number.isInteger(next) || next <= 0 || next === id.value) return;
    id.value = next;
    o.value = null;
    institute.value = null;
    snapshots.value = [];
    void load();
  },
  { immediate: true },
);
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
.danger {
  color: var(--ion-color-danger);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
.table-wrap {
  overflow-x: auto;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
th,
td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--ion-color-light-shade, #ddd);
  text-align: right;
  white-space: nowrap;
}
th:first-child,
td:first-child {
  text-align: left;
}
</style>

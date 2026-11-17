<template>
  <AppPage title="Fee settings" :on-refresh="load">
    <ion-segment v-model="tab">
      <ion-segment-button value="general">General & GST</ion-segment-button>
      <ion-segment-button value="heads">Fee heads</ion-segment-button>
      <ion-segment-button value="rules">Concessions</ion-segment-button>
      <ion-segment-button value="gateways">Gateways</ion-segment-button>
    </ion-segment>

    <form v-if="tab === 'general' && s" @submit.prevent="saveSettings">
      <ion-list>
        <ion-list-header>Numbering</ion-list-header>
        <ion-item>
          <ion-input v-model="s.receiptFormat" label="Receipt number format" label-placement="stacked" />
        </ion-item>
        <ion-item>
          <ion-input v-model="s.invoiceFormat" label="Tax invoice number format" label-placement="stacked" />
        </ion-item>
        <p class="muted">Tokens: {INST} {BRANCH} {FY} {YYYY} {YY} {MM} {SEQ} {SEQ:5}</p>
        <ion-list-header>GST</ion-list-header>
        <ion-item><ion-toggle v-model="s.gstEnabled">Charge GST and issue tax invoices</ion-toggle></ion-item>
        <template v-if="s.gstEnabled">
          <ion-item><ion-input v-model="s.gstin" label="GSTIN" label-placement="stacked" /></ion-item>
          <ion-item>
            <ion-input
              v-model.number="s.gstRatePercent"
              type="number"
              label="GST rate %"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item><ion-input v-model="s.sacCode" label="SAC code" label-placement="stacked" /></ion-item>
          <ion-item><ion-toggle v-model="s.gstInterState">Inter-state supply (IGST)</ion-toggle></ion-item>
          <p class="muted">Fee amounts are treated as GST-inclusive.</p>
        </template>
        <ion-list-header>Late fees & reminders</ion-list-header>
        <ion-item>
          <ion-select v-model="s.lateFee.type" label="Late fee" label-placement="stacked">
            <ion-select-option value="none">None</ion-select-option>
            <ion-select-option value="fixed">Fixed per instalment</ion-select-option>
            <ion-select-option value="percent">% of overdue amount</ion-select-option>
            <ion-select-option value="per_day">Per day overdue</ion-select-option>
          </ion-select>
        </ion-item>
        <template v-if="s.lateFee.type !== 'none'">
          <ion-item v-if="s.lateFee.type === 'percent'">
            <ion-input
              v-model.number="s.lateFee.percent"
              type="number"
              label="Percent"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item v-else>
            <ion-input v-model="lateAmount" type="number" label="Amount (₹)" label-placement="stacked" />
          </ion-item>
          <ion-item>
            <ion-input
              v-model.number="s.lateFee.graceDays"
              type="number"
              label="Grace days"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="lateMax"
              type="number"
              label="Cap per instalment (₹, blank = none)"
              label-placement="stacked"
            />
          </ion-item>
        </template>
        <ion-item>
          <ion-input
            v-model.number="s.reminderDaysBefore"
            type="number"
            label="Send due reminder days before"
            label-placement="stacked"
          />
        </ion-item>
        <ion-list-header>Controls</ion-list-header>
        <ion-item
          ><ion-toggle v-model="s.offlineApprovalRequired"
            >Offline payments need approval</ion-toggle
          ></ion-item
        >
        <ion-item>
          <ion-input
            v-model="threshold"
            type="number"
            label="Concessions above ₹ need approval (0 = always)"
            label-placement="stacked"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="s.entitlementAfterInstalment"
            type="number"
            label="Unlock course after instalment no."
            label-placement="stacked"
          />
        </ion-item>
      </ion-list>
      <ion-button v-can="'fees.configure'" expand="block" type="submit">Save settings</ion-button>
      <ion-button v-can="'fees.configure'" expand="block" fill="outline" @click="sweep"
        >Run due-date / late-fee job now</ion-button
      >
    </form>

    <template v-else-if="tab === 'heads'">
      <ion-list>
        <ion-item v-for="h in heads" :key="h.id">
          <ion-label
            >{{ h.name }} <small class="muted">{{ h.code }}</small></ion-label
          >
          <ion-toggle
            slot="end"
            :checked="h.taxable"
            @ion-change="patchHead(h, { taxable: $event.detail.checked })"
            >Taxable</ion-toggle
          >
          <ion-toggle
            slot="end"
            :checked="h.active"
            @ion-change="patchHead(h, { active: $event.detail.checked })"
            >Active</ion-toggle
          >
        </ion-item>
        <ion-item>
          <ion-input v-model="newHead.name" placeholder="Name (e.g. Tuition)" />
          <ion-input v-model="newHead.code" placeholder="Code" />
          <ion-button slot="end" @click="addHead">Add</ion-button>
        </ion-item>
      </ion-list>
    </template>

    <template v-else-if="tab === 'rules'">
      <ion-list>
        <ion-item v-for="r in rules" :key="r.id">
          <ion-label>
            <h3>{{ r.name }} · {{ r.type }}</h3>
            <p>
              {{ r.mode === 'percent' ? `${r.value}%` : rupees(r.value) }}
              <span v-if="r.requiresApproval"> · needs approval</span>
            </p>
          </ion-label>
          <ion-toggle
            slot="end"
            :checked="r.active"
            @ion-change="patchRule(r, { active: $event.detail.checked })"
            >Active</ion-toggle
          >
        </ion-item>
      </ion-list>
      <ion-list>
        <ion-list-header>New concession / scholarship rule</ion-list-header>
        <ion-item><ion-input v-model="newRule.name" label="Name" label-placement="stacked" /></ion-item>
        <ion-item>
          <ion-select v-model="newRule.type" label="Type" label-placement="stacked">
            <ion-select-option value="concession">Concession</ion-select-option>
            <ion-select-option value="scholarship">Scholarship</ion-select-option>
            <ion-select-option value="discount">Discount</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="newRule.mode" label="Amount type" label-placement="stacked">
            <ion-select-option value="percent">Percent</ion-select-option>
            <ion-select-option value="fixed">Fixed ₹</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item
          ><ion-input v-model="newRule.value" type="number" label="Value" label-placement="stacked"
        /></ion-item>
        <ion-item
          ><ion-checkbox v-model="newRule.requiresApproval">Always requires approval</ion-checkbox></ion-item
        >
        <ion-button expand="block" @click="addRule">Add rule</ion-button>
      </ion-list>
    </template>

    <template v-else-if="tab === 'gateways'">
      <ion-list>
        <ion-item v-for="g in PAYMENT_GATEWAYS" :key="g">
          <ion-label>
            <h3>{{ GATEWAY_LABELS[g] }}</h3>
            <p v-if="gw(g)">
              {{ gw(g)?.enabled ? 'Enabled' : 'Disabled' }}<span v-if="gw(g)?.isDefault"> · default</span>
              <span v-if="gw(g)?.keyHint"> · key …{{ gw(g)?.keyHint }}</span>
            </p>
            <p v-if="gw(g)" class="muted selectable">Webhook: {{ gw(g)?.webhookUrl }}</p>
          </ion-label>
          <ion-button slot="end" fill="outline" @click="editGateway(g)">Configure</ion-button>
        </ion-item>
      </ion-list>
      <form v-if="gwForm" @submit.prevent="saveGateway">
        <ion-list>
          <ion-list-header>{{ GATEWAY_LABELS[gwForm.gateway] }}</ion-list-header>
          <ion-item><ion-toggle v-model="gwForm.enabled">Enabled</ion-toggle></ion-item>
          <ion-item><ion-toggle v-model="gwForm.isDefault">Default for online payments</ion-toggle></ion-item>
          <ion-item><ion-toggle v-model="gwForm.sandbox">Sandbox / test mode</ion-toggle></ion-item>
          <ion-item v-if="gwForm.gateway !== 'mock'">
            <ion-input v-model="gwForm.merchantId" label="Merchant / key id" label-placement="stacked" />
          </ion-item>
          <ion-item v-if="gwForm.gateway !== 'mock'">
            <ion-input
              v-model="gwForm.secretKey"
              type="password"
              label="Secret key (leave blank to keep)"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="gwForm.webhookSecret"
              type="password"
              label="Webhook secret (leave blank to keep)"
              label-placement="stacked"
            />
          </ion-item>
        </ion-list>
        <ion-button expand="block" type="submit">Save gateway</ion-button>
      </form>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonButton,
  IonCheckbox,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonToggle,
} from '@ionic/vue';
import {
  PAYMENT_GATEWAYS,
  type FeeHeadDto,
  type FeeSettings,
  type GatewayConfigDto,
  type PaymentGatewayKey,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../hr/api';
import { feesApi, toPaise, type ConcessionRule } from './api';

const GATEWAY_LABELS: Record<PaymentGatewayKey, string> = {
  mock: 'Mock gateway (testing)',
  paytm: 'Paytm',
  razorpay: 'Razorpay',
  cashfree: 'Cashfree',
};

const tab = ref<'general' | 'heads' | 'rules' | 'gateways'>('general');
const s = ref<FeeSettings | null>(null);
const lateAmount = ref('');
const lateMax = ref('');
const threshold = ref('');
const heads = ref<FeeHeadDto[]>([]);
const rules = ref<ConcessionRule[]>([]);
const gateways = ref<GatewayConfigDto[]>([]);
const newHead = ref({ name: '', code: '' });
const newRule = ref({
  name: '',
  type: 'concession' as ConcessionRule['type'],
  mode: 'percent' as const,
  value: '',
  requiresApproval: false,
});
const gwForm = ref<{
  gateway: PaymentGatewayKey;
  enabled: boolean;
  isDefault: boolean;
  sandbox: boolean;
  merchantId: string;
  secretKey: string;
  webhookSecret: string;
} | null>(null);
const gw = (g: PaymentGatewayKey) => gateways.value.find((x) => x.gateway === g);

async function load() {
  try {
    const [st, h, r, g] = await Promise.all([
      feesApi.settings(),
      feesApi.heads(),
      feesApi.rules(),
      feesApi.gateways(),
    ]);
    s.value = st;
    lateAmount.value = String(st.lateFee.amount / 100);
    lateMax.value = st.lateFee.maxAmount === null ? '' : String(st.lateFee.maxAmount / 100);
    threshold.value = String(st.concessionApprovalThreshold / 100);
    heads.value = h;
    rules.value = r;
    gateways.value = g;
  } catch (e) {
    void toastError(e);
  }
}

async function act(fn: () => Promise<unknown>, msg: string) {
  try {
    await fn();
    await toast(msg);
    await load();
  } catch (e) {
    void toastError(e);
  }
}

const saveSettings = () =>
  act(async () => {
    if (!s.value) return;
    await feesApi.saveSettings({
      ...s.value,
      lateFee: {
        ...s.value.lateFee,
        amount: toPaise(lateAmount.value || 0),
        maxAmount: lateMax.value === '' ? null : toPaise(lateMax.value),
      },
      concessionApprovalThreshold: toPaise(threshold.value || 0),
    });
  }, 'Settings saved');

const sweep = () =>
  act(async () => {
    const r = await feesApi.runSweep();
    await toast(`Reminders ${r.reminders}, overdue notices ${r.overdue}, late fees ${r.lateFees}`);
  }, 'Done');

const addHead = () =>
  act(async () => {
    await feesApi.createHead({ ...newHead.value, taxable: true });
    newHead.value = { name: '', code: '' };
  }, 'Fee head added');
const patchHead = (h: FeeHeadDto, b: Partial<FeeHeadDto>) => act(() => feesApi.updateHead(h.id, b), 'Saved');

const addRule = () =>
  act(async () => {
    const r = newRule.value;
    await feesApi.saveRule({
      name: r.name,
      type: r.type,
      mode: r.mode,
      value: r.mode === 'percent' ? Number(r.value) : toPaise(r.value),
      requiresApproval: r.requiresApproval,
    });
    newRule.value = { name: '', type: 'concession', mode: 'percent', value: '', requiresApproval: false };
  }, 'Rule added');
const patchRule = (r: ConcessionRule, b: Partial<ConcessionRule>) =>
  act(() => feesApi.saveRule(b, r.id), 'Saved');

function editGateway(g: PaymentGatewayKey) {
  const c = gw(g);
  gwForm.value = {
    gateway: g,
    enabled: c?.enabled ?? false,
    isDefault: c?.isDefault ?? false,
    sandbox: c?.sandbox ?? true,
    merchantId: c?.merchantId ?? '',
    secretKey: '',
    webhookSecret: '',
  };
}
const saveGateway = () =>
  act(async () => {
    const f = gwForm.value;
    if (!f) return;
    await feesApi.saveGateway(f.gateway, {
      enabled: f.enabled,
      isDefault: f.isDefault,
      sandbox: f.sandbox,
      merchantId: f.merchantId || null,
      ...(f.secretKey ? { secretKey: f.secretKey } : {}),
      ...(f.webhookSecret ? { webhookSecret: f.webhookSecret } : {}),
    });
    gwForm.value = null;
  }, 'Gateway saved');

onMounted(load);
</script>

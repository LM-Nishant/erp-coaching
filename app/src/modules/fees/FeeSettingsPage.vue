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
              <span v-if="g !== 'mock'"> · {{ gw(g)?.sandbox ? 'test mode' : 'live mode' }}</span>
              <span v-if="gw(g)?.platformManaged"> · platform account</span>
              <span v-if="gw(g)?.keyHint"> · key {{ gw(g)?.keyHint }}</span>
            </p>
            <p v-if="gw(g)" class="muted selectable">Webhook: {{ gw(g)?.webhookUrl }}</p>
          </ion-label>
          <ion-button slot="end" fill="outline" @click="editGateway(g)">Configure</ion-button>
        </ion-item>
      </ion-list>
      <form v-if="gwForm" @submit.prevent="saveGateway">
        <ion-list>
          <ion-list-header>{{ GATEWAY_LABELS[gwForm.gateway] }}</ion-list-header>
          <p class="muted gw-note">{{ gwFields.hint }}</p>
          <p v-if="gwSaved?.platformManaged" class="muted gw-note">
            Payments now go to the platform's {{ GATEWAY_LABELS[gwForm.gateway] }} account. Enter your own
            keys to collect into your account.
          </p>
          <ion-item><ion-toggle v-model="gwForm.enabled">Enabled</ion-toggle></ion-item>
          <ion-item><ion-toggle v-model="gwForm.isDefault">Default for online payments</ion-toggle></ion-item>
          <ion-item v-if="gwForm.gateway !== 'mock'">
            <ion-select v-model="gwForm.sandbox" label="Mode" label-placement="stacked" interface="popover">
              <ion-select-option :value="true">Test (sandbox)</ion-select-option>
              <ion-select-option :value="false">Live (production)</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item v-if="gwFields.merchantId">
            <ion-input
              v-model="gwForm.merchantId"
              :label="gwFields.merchantId"
              label-placement="stacked"
              autocomplete="off"
              :maxlength="100"
            />
          </ion-item>
          <ion-item v-if="gwFields.secretKey">
            <ion-input
              v-model="gwForm.secretKey"
              type="password"
              :label="gwFields.secretKey"
              label-placement="stacked"
              autocomplete="off"
              :placeholder="savedSecretHint(gwSaved?.hasSecret, gwSaved?.keyHint)"
            />
          </ion-item>
          <ion-item v-if="gwFields.webhookSecret">
            <ion-input
              v-model="gwForm.webhookSecret"
              type="password"
              :label="gwFields.webhookSecret"
              label-placement="stacked"
              autocomplete="off"
              :placeholder="savedSecretHint(gwSaved?.hasWebhookSecret)"
            />
          </ion-item>
          <ion-item v-if="gwFields.website">
            <ion-input
              v-model="gwForm.website"
              :label="gwFields.website"
              label-placement="stacked"
              autocomplete="off"
              :maxlength="60"
              placeholder="Blank: WEBSTAGING (test) or DEFAULT (live)"
            />
          </ion-item>
        </ion-list>
        <div v-if="gwSecretAgain" class="notice warning">
          Test and live modes use different keys: enter the {{ gwFields.secretKey?.toLowerCase() }} for
          {{ gwForm.sandbox ? 'test' : 'live' }} mode.
        </div>
        <p v-if="gwSaved" class="gw-note">
          Webhook URL for the {{ GATEWAY_LABELS[gwForm.gateway] }} dashboard:
          <code class="selectable">{{ gwSaved.webhookUrl }}</code>
          <ion-button
            size="small"
            fill="clear"
            aria-label="Copy webhook URL"
            @click="copyWebhook(gwSaved.webhookUrl)"
            >Copy</ion-button
          >
        </p>
        <p v-else class="muted gw-note">Save to get the webhook URL to add in the gateway's dashboard.</p>
        <div v-if="gwTest" class="notice" :class="gwTest.ok ? 'ok' : 'danger'" role="status">
          {{ gwTest.ok ? 'Test passed' : 'Test failed' }}: {{ gwTest.message }}
        </div>
        <div class="gw-actions">
          <ion-button fill="clear" :disabled="gwBusy" @click="closeGateway">Close</ion-button>
          <ion-button v-if="gwCanTest" fill="outline" :disabled="gwBusy" @click="testGateway"
            >Test saved keys</ion-button
          >
          <ion-button type="submit" :disabled="gwBusy">Save gateway</ion-button>
        </div>
      </form>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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
import {
  GATEWAY_FIELDS,
  GATEWAY_LABELS,
  feesApi,
  savedSecretHint,
  toPaise,
  type ConcessionRule,
  type GatewayTestResult,
} from './api';

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
  website: string;
} | null>(null);
const gwTest = ref<GatewayTestResult | null>(null);
const gwBusy = ref(false);
const gw = (g: PaymentGatewayKey) => gateways.value.find((x) => x.gateway === g);
const gwSaved = computed(() => (gwForm.value ? gw(gwForm.value.gateway) : undefined));
const gwFields = computed(() => GATEWAY_FIELDS[gwForm.value?.gateway ?? 'mock']);
// The server refuses to reuse a saved key in the other mode (SECRET_REQUIRED).
const gwSecretAgain = computed(() => {
  const f = gwForm.value;
  const s = gwSaved.value;
  return !!f && !!s?.hasSecret && f.gateway !== 'mock' && f.sandbox !== s.sandbox && !f.secretKey.trim();
});
const gwCanTest = computed(() => {
  const s = gwSaved.value;
  return !!s && s.gateway !== 'mock' && !s.platformManaged && s.hasSecret;
});

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

function gatewayForm(g: PaymentGatewayKey, c?: GatewayConfigDto) {
  return {
    gateway: g,
    enabled: c?.enabled ?? false,
    isDefault: c?.isDefault ?? false,
    sandbox: c?.sandbox ?? true,
    merchantId: c?.merchantId ?? '',
    secretKey: '',
    webhookSecret: '',
    website: c?.website ?? '',
  };
}
function editGateway(g: PaymentGatewayKey) {
  gwForm.value = gatewayForm(g, gw(g));
  gwTest.value = null;
}
function closeGateway() {
  gwForm.value = null;
  gwTest.value = null;
}
async function saveGateway() {
  const f = gwForm.value;
  if (!f) return;
  const fields = GATEWAY_FIELDS[f.gateway];
  gwBusy.value = true;
  try {
    const saved = await feesApi.saveGateway(f.gateway, {
      enabled: f.enabled,
      isDefault: f.isDefault,
      sandbox: f.sandbox,
      ...(fields.merchantId ? { merchantId: f.merchantId.trim() || null } : {}),
      ...(f.secretKey.trim() ? { secretKey: f.secretKey.trim() } : {}),
      ...(f.webhookSecret.trim() ? { webhookSecret: f.webhookSecret.trim() } : {}),
      ...(fields.website ? { website: f.website.trim() || null } : {}),
    });
    await toast('Gateway saved');
    // Stays open so the admin can copy the webhook URL and test the keys.
    gwForm.value = gatewayForm(saved.gateway, saved);
    gwTest.value = null;
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    gwBusy.value = false;
  }
}
async function testGateway() {
  const g = gwForm.value?.gateway;
  if (!g) return;
  gwBusy.value = true;
  try {
    gwTest.value = await feesApi.testGateway(g);
  } catch (e) {
    void toastError(e);
  } finally {
    gwBusy.value = false;
  }
}
async function copyWebhook(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    await toast('Webhook URL copied');
  } catch {
    await toast('Copy failed; select the URL instead', 'warning');
  }
}

onMounted(load);
</script>

<style scoped>
.gw-note {
  margin: 8px 16px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.notice {
  margin: 8px 16px;
}
.notice.ok {
  background: rgba(var(--ion-color-success-rgb), 0.12);
  color: var(--ion-color-success-shade);
}
.gw-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 16px;
}
</style>

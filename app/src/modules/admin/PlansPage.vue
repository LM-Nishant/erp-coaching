<template>
  <AppPage title="Plans" :on-refresh="load">
    <template #actions>
      <ion-button aria-label="New plan" @click="edit()"><ion-icon slot="icon-only" :icon="add" /></ion-button>
    </template>
    <ion-list>
      <ion-item v-for="p in plans" :key="p.id" button @click="edit(p)">
        <ion-label>
          <h2>{{ p.name }} <ion-badge v-if="!p.isActive" color="medium">inactive</ion-badge></h2>
          <p>
            ₹{{ (p.priceMonthlyPaise / 100).toLocaleString() }}/mo · ₹{{
              (p.priceYearlyPaise / 100).toLocaleString()
            }}/yr · {{ p.trialDays }}-day trial · {{ p.activeSubscriptions ?? 0 }} active subscription(s)
          </p>
          <p>
            Students {{ lim(p.limits.maxStudents) }} · Branches {{ lim(p.limits.maxBranches) }} · Teachers
            {{ lim(p.limits.maxTeachers) }} · Storage {{ lim(p.limits.storageMb) }} MB · AI
            {{ lim(p.limits.aiTokensMonthly) }} tokens/mo
          </p>
          <p>Modules: {{ p.limits.enabledModules?.join(', ') ?? 'all' }}</p>
          <p v-if="p.addons.length">
            Add-ons:
            {{
              p.addons
                .map((a) => (a.kind === 'module' ? `${a.moduleKey} module` : ADDON_LABELS[a.kind]))
                .join(', ')
            }}
          </p>
          <p v-if="Object.keys(p.usagePricing).length">
            Billed beyond the limit:
            {{
              METERED_METRICS.filter((m) => p.usagePricing[m])
                .map((m) => METRIC_LABELS[m])
                .join(', ')
            }}
          </p>
        </ion-label>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit plan' : 'New plan' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item
              ><ion-input v-model="form.code" label="Code" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model.number="priceMonthly"
                label="Monthly price (₹)"
                label-placement="stacked"
                type="number"
            /></ion-item>
            <ion-item
              ><ion-input
                v-model.number="priceYearly"
                label="Yearly price (₹)"
                label-placement="stacked"
                type="number"
            /></ion-item>
            <ion-item
              ><ion-input
                v-model.number="form.trialDays"
                label="Trial days"
                label-placement="stacked"
                type="number"
            /></ion-item>
            <ion-list-header>Limits (empty = unlimited)</ion-list-header>
            <ion-item v-for="f in limitFields" :key="f.key">
              <ion-input v-model="limits[f.key]" :label="f.label" label-placement="stacked" type="number" />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="modules"
                label="Enabled modules (comma separated, empty = all)"
                label-placement="stacked"
              />
            </ion-item>
            <p class="muted hint">Module keys: {{ PLAN_MODULE_KEYS.join(', ') }}</p>
            <ion-item><ion-toggle v-model="form.isActive">Active</ion-toggle></ion-item>

            <ion-list-header>Add-on packs</ion-list-header>
            <p class="muted hint">
              Packs institutes can buy on top of the plan. Recurring packs renew with the subscription; AI
              credit packs are one-time for the current month. A blank yearly price means 12 × monthly.
            </p>
            <template v-for="(a, idx) in addons" :key="a.uid">
              <ion-item>
                <ion-select
                  :value="a.kind"
                  label="Add-on"
                  label-placement="stacked"
                  interface="popover"
                  @ion-change="setKind(a, $event.detail.value)"
                >
                  <ion-select-option v-for="k in ADDON_KINDS" :key="k" :value="k">{{
                    ADDON_LABELS[k]
                  }}</ion-select-option>
                </ion-select>
                <ion-button slot="end" fill="clear" color="danger" @click="addons.splice(idx, 1)"
                  >Remove</ion-button
                >
              </ion-item>
              <ion-item>
                <ion-input
                  v-if="a.kind === 'module'"
                  v-model="a.moduleKey"
                  label="Module key (e.g. lms)"
                  label-placement="stacked"
                />
                <ion-input
                  v-else
                  v-model="a.unitSize"
                  :label="`Pack size (${UNIT_WORDS[a.kind]})`"
                  label-placement="stacked"
                  type="number"
                  :min="1"
                />
                <ion-input
                  v-model="a.monthly"
                  :label="a.kind === 'ai_credits' ? 'Price per pack (₹)' : 'Per month (₹)'"
                  label-placement="stacked"
                  type="number"
                  :min="0"
                />
                <ion-input
                  v-if="a.kind !== 'ai_credits'"
                  v-model="a.yearly"
                  label="Per year (₹)"
                  label-placement="stacked"
                  type="number"
                  :min="0"
                />
              </ion-item>
            </template>
            <ion-button fill="clear" size="small" @click="addAddon">Add a pack</ion-button>

            <ion-list-header>Usage beyond the limits</ion-list-header>
            <p class="muted hint">
              A limit normally blocks further use. Price a metric to bill usage above it monthly instead
              (seats: the month's peak, AI: the month's total), optionally up to a cap.
            </p>
            <template v-for="m in METERED_METRICS" :key="m">
              <ion-item>
                <ion-toggle v-model="overage[m].enabled">{{ METRIC_LABELS[m] }}</ion-toggle>
              </ion-item>
              <ion-item v-if="overage[m].enabled">
                <ion-input
                  v-model="overage[m].unitSize"
                  :label="`Block (${OVERAGE_UNIT_WORDS[m]})`"
                  label-placement="stacked"
                  type="number"
                  :min="1"
                />
                <ion-input
                  v-model="overage[m].price"
                  label="Price per block (₹)"
                  label-placement="stacked"
                  type="number"
                  :min="0"
                />
                <ion-input
                  v-model="overage[m].maxOverage"
                  label="Cap (units, blank = none)"
                  label-placement="stacked"
                  type="number"
                  :min="0"
                />
              </ion-item>
            </template>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="busy">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import {
  ADDON_KINDS,
  ADDON_LABELS,
  METERED_METRICS,
  METRIC_LABELS,
  PLAN_MODULE_KEYS,
  type AddonKind,
  type MeteredMetric,
  type PlanAddonPrice,
  type PlanLimits,
  type PlanUsagePricing,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { adminApi, type PlanDto, type PlanInput } from './api';

type NumericLimit = Exclude<keyof PlanLimits, 'enabledModules'>;
const limitFields: { key: NumericLimit; label: string }[] = [
  { key: 'maxStudents', label: 'Max students' },
  { key: 'maxBranches', label: 'Max branches' },
  { key: 'maxTeachers', label: 'Max teachers' },
  { key: 'storageMb', label: 'Storage (MB)' },
  { key: 'aiTokensMonthly', label: 'AI tokens per month (0 = AI disabled)' },
];

const UNIT_WORDS: Record<AddonKind, string> = {
  students: 'students',
  branches: 'branches',
  teachers: 'teachers',
  storage: 'MB',
  ai_credits: 'AI tokens',
  module: 'module',
};
const DEFAULT_PACK: Record<AddonKind, number> = {
  students: 10,
  branches: 1,
  teachers: 5,
  storage: 1024,
  ai_credits: 100000,
  module: 1,
};
const OVERAGE_UNIT_WORDS: Record<MeteredMetric, string> = {
  students: 'students',
  branches: 'branches',
  teachers: 'teachers',
  storageMb: 'MB',
  aiTokens: 'tokens',
};
const DEFAULT_BLOCK: Record<MeteredMetric, number> = {
  students: 1,
  branches: 1,
  teachers: 1,
  storageMb: 1024,
  aiTokens: 100000,
};

/** Form rows keep typed text; save() converts and validates. */
interface AddonRow {
  uid: number;
  kind: AddonKind;
  unitSize: string;
  monthly: string;
  yearly: string;
  moduleKey: string;
}
interface OverageRow {
  enabled: boolean;
  unitSize: string;
  price: string;
  maxOverage: string;
}

const plans = ref<PlanDto[]>([]);
const addons = ref<AddonRow[]>([]);
const overage = reactive(
  Object.fromEntries(
    METERED_METRICS.map((m) => [m, { enabled: false, unitSize: '', price: '', maxOverage: '' }]),
  ) as Record<MeteredMetric, OverageRow>,
);
const form = ref<PlanInput | null>(null);
const editingId = ref<number | null>(null);
const limits = reactive<Record<NumericLimit, string>>({
  maxStudents: '',
  maxBranches: '',
  maxTeachers: '',
  storageMb: '',
  aiTokensMonthly: '',
});
const modules = ref('');
const priceMonthly = ref(0);
const priceYearly = ref(0);
const busy = ref(false);

const lim = (n: number | null) => (n === null ? '∞' : n.toLocaleString());
const rupeesText = (paise: number) => String(paise / 100);
const text = (v: unknown) => String(v ?? '').trim();
const isWhole = (v: string, min: number) => /^\d+$/.test(v) && Number(v) >= min;
const isAmount = (v: string) => v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;

let nextUid = 1;

function addAddon() {
  const used = new Set(addons.value.map((a) => a.kind));
  const kind = ADDON_KINDS.find((k) => k === 'module' || !used.has(k)) ?? 'module';
  addons.value.push({
    uid: nextUid++,
    kind,
    unitSize: String(DEFAULT_PACK[kind]),
    monthly: '',
    yearly: '',
    moduleKey: '',
  });
}

/** A new kind gets that kind's usual pack size; the prices are kept. */
function setKind(a: AddonRow, kind: AddonKind) {
  if (a.kind === kind) return;
  a.kind = kind;
  a.unitSize = String(DEFAULT_PACK[kind]);
}

/** Validated add-on catalogue, or an error message. */
function buildAddons(): PlanAddonPrice[] | string {
  const out: PlanAddonPrice[] = [];
  const seen = new Set<string>();
  for (const a of addons.value) {
    const label = ADDON_LABELS[a.kind];
    const moduleKey = a.kind === 'module' ? text(a.moduleKey).toLowerCase() : null;
    if (a.kind === 'module' && !/^[a-z0-9-]{2,40}$/.test(moduleKey ?? ''))
      return 'Give each module add-on a module key (letters, digits, dashes)';
    if (a.kind !== 'module' && !isWhole(text(a.unitSize), 1))
      return `${label}: the pack size must be at least 1`;
    if (!isAmount(text(a.monthly))) return `${label}: enter the price`;
    if (text(a.yearly) !== '' && !isAmount(text(a.yearly))) return `${label}: the yearly price is invalid`;
    const key = `${a.kind}:${moduleKey ?? ''}`;
    if (seen.has(key)) return `${a.kind === 'module' ? `The ${moduleKey} module` : label} is listed twice`;
    seen.add(key);
    out.push({
      kind: a.kind,
      unitSize: a.kind === 'module' ? 1 : Number(text(a.unitSize)),
      monthlyPricePaise: Math.round(Number(text(a.monthly)) * 100),
      yearlyPricePaise:
        a.kind === 'ai_credits' || text(a.yearly) === '' ? 0 : Math.round(Number(text(a.yearly)) * 100),
      moduleKey,
    });
  }
  return out;
}

/** Validated overage prices, or an error message. */
function buildUsagePricing(): PlanUsagePricing | string {
  const out: PlanUsagePricing = {};
  for (const m of METERED_METRICS) {
    const o = overage[m];
    if (!o.enabled) continue;
    if (!isWhole(text(o.unitSize), 1)) return `${METRIC_LABELS[m]}: the block size must be at least 1`;
    if (!isAmount(text(o.price))) return `${METRIC_LABELS[m]}: enter the price per block`;
    if (text(o.maxOverage) !== '' && !isWhole(text(o.maxOverage), 0))
      return `${METRIC_LABELS[m]}: the cap must be a whole number`;
    out[m] = {
      unitSize: Number(text(o.unitSize)),
      pricePaise: Math.round(Number(text(o.price)) * 100),
      maxOverage: text(o.maxOverage) === '' ? null : Number(text(o.maxOverage)),
    };
  }
  return out;
}

async function load() {
  plans.value = await adminApi.plans().catch((e) => (toastError(e), []));
}

function edit(p?: PlanDto) {
  editingId.value = p?.id ?? null;
  const base: PlanInput = p
    ? {
        code: p.code,
        name: p.name,
        description: p.description,
        priceMonthlyPaise: p.priceMonthlyPaise,
        priceYearlyPaise: p.priceYearlyPaise,
        trialDays: p.trialDays,
        limits: p.limits,
        isActive: p.isActive,
        addons: p.addons,
        usagePricing: p.usagePricing,
      }
    : {
        code: '',
        name: '',
        description: null,
        priceMonthlyPaise: 0,
        priceYearlyPaise: 0,
        trialDays: 14,
        isActive: true,
        addons: [],
        usagePricing: {},
        limits: {
          maxStudents: null,
          maxBranches: null,
          maxTeachers: null,
          storageMb: null,
          aiTokensMonthly: null,
          enabledModules: null,
        },
      };
  limitFields.forEach((f) => (limits[f.key] = base.limits[f.key] === null ? '' : String(base.limits[f.key])));
  modules.value = base.limits.enabledModules?.join(', ') ?? '';
  priceMonthly.value = base.priceMonthlyPaise / 100;
  priceYearly.value = base.priceYearlyPaise / 100;
  addons.value = base.addons.map((a) => ({
    uid: nextUid++,
    kind: a.kind,
    unitSize: String(a.unitSize),
    monthly: rupeesText(a.monthlyPricePaise),
    yearly: a.yearlyPricePaise ? rupeesText(a.yearlyPricePaise) : '',
    moduleKey: a.moduleKey ?? '',
  }));
  for (const m of METERED_METRICS) {
    const o = base.usagePricing[m];
    overage[m] = o
      ? {
          enabled: true,
          unitSize: String(o.unitSize),
          price: rupeesText(o.pricePaise),
          maxOverage: o.maxOverage === null || o.maxOverage === undefined ? '' : String(o.maxOverage),
        }
      : { enabled: false, unitSize: String(DEFAULT_BLOCK[m]), price: '', maxOverage: '' };
  }
  form.value = base;
}

async function save() {
  if (!form.value) return;
  const num = (v: string) => (String(v ?? '').trim() === '' ? null : Number(v));
  const planAddons = buildAddons();
  const usagePricing = buildUsagePricing();
  const problem = typeof planAddons === 'string' ? planAddons : usagePricing;
  if (typeof problem === 'string' || typeof planAddons === 'string' || typeof usagePricing === 'string') {
    await toast(typeof problem === 'string' ? problem : 'Check the plan details', 'warning');
    return;
  }
  const body: PlanInput = {
    ...form.value,
    trialDays: Number(form.value.trialDays) || 0,
    priceMonthlyPaise: Math.round(Number(priceMonthly.value || 0) * 100),
    priceYearlyPaise: Math.round(Number(priceYearly.value || 0) * 100),
    addons: planAddons,
    usagePricing,
    limits: {
      maxStudents: num(limits.maxStudents),
      maxBranches: num(limits.maxBranches),
      maxTeachers: num(limits.maxTeachers),
      storageMb: num(limits.storageMb),
      aiTokensMonthly: num(limits.aiTokensMonthly),
      enabledModules: modules.value.trim()
        ? modules.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
    },
  };
  busy.value = true;
  try {
    if (editingId.value) await adminApi.updatePlan(editingId.value, body);
    else await adminApi.createPlan(body);
    form.value = null;
    await toast('Plan saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.hint {
  font-size: 13px;
  margin: 0;
  padding: 0 16px 8px;
}
</style>

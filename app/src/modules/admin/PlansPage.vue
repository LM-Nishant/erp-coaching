<template>
  <AppPage title="Plans" :on-refresh="load">
    <template #actions>
      <ion-button @click="edit()"><ion-icon slot="icon-only" :icon="add" /></ion-button>
    </template>
    <ion-list>
      <ion-item v-for="p in plans" :key="p.id" button @click="edit(p)">
        <ion-label>
          <h2>{{ p.name }} <ion-badge v-if="!p.isActive" color="medium">inactive</ion-badge></h2>
          <p>
            ₹{{ (p.priceMonthlyPaise / 100).toLocaleString() }}/mo · {{ p.activeSubscriptions ?? 0 }} active
            subscription(s)
          </p>
          <p>
            Students {{ lim(p.limits.maxStudents) }} · Branches {{ lim(p.limits.maxBranches) }} · Teachers
            {{ lim(p.limits.maxTeachers) }} · Storage {{ lim(p.limits.storageMb) }} MB · AI
            {{ lim(p.limits.aiTokensMonthly) }} tokens/mo
          </p>
          <p>Modules: {{ p.limits.enabledModules?.join(', ') ?? 'all' }}</p>
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
            <ion-item><ion-toggle v-model="form.isActive">Active</ion-toggle></ion-item>
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
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import type { PlanLimits } from '@erp/shared';
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

const plans = ref<PlanDto[]>([]);
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
      }
    : {
        code: '',
        name: '',
        description: null,
        priceMonthlyPaise: 0,
        priceYearlyPaise: 0,
        trialDays: 14,
        isActive: true,
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
  form.value = base;
}

async function save() {
  if (!form.value) return;
  const num = (v: string) => (String(v ?? '').trim() === '' ? null : Number(v));
  const body: PlanInput = {
    ...form.value,
    trialDays: Number(form.value.trialDays) || 0,
    priceMonthlyPaise: Math.round(Number(priceMonthly.value || 0) * 100),
    priceYearlyPaise: Math.round(Number(priceYearly.value || 0) * 100),
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

<template>
  <AppPage title="Coupons" :on-refresh="load">
    <template #actions>
      <ion-button v-if="auth.can('website.create')" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <ion-searchbar v-model="search" :debounce="300" placeholder="Search code" @ion-input="load" />
    <ion-list>
      <ion-item v-for="c in items" :key="c.id" button :detail="false" @click="openEditor(c)">
        <ion-label class="ion-text-wrap">
          <h2>
            <strong>{{ c.code }}</strong> —
            {{ c.discountType === 'percent' ? `${c.discountValue}% off` : `${inr(c.discountValue)} off` }}
            <span v-if="c.maxDiscount" class="muted">(max {{ inr(c.maxDiscount) }})</span>
          </h2>
          <p v-if="c.description">{{ c.description }}</p>
          <p>
            Used {{ c.usedCount }}{{ c.usageLimit ? ` / ${c.usageLimit}` : '' }} ·
            {{ c.validFrom ? day(c.validFrom) : 'now' }} →
            {{ c.validUntil ? day(c.validUntil) : 'no expiry' }}
            <span v-if="c.minAmount"> · min {{ inr(c.minAmount) }}</span>
            <span v-if="c.courseIds?.length"> · {{ c.courseIds.length }} course(s)</span>
          </p>
        </ion-label>
        <ion-badge slot="end" :color="c.isActive ? 'success' : 'medium'">{{
          c.isActive ? 'Active' : 'Inactive'
        }}</ion-badge>
      </ion-item>
      <ion-item v-if="!items.length" lines="none"><ion-label>No coupons yet.</ion-label></ion-item>
    </ion-list>

    <ion-card>
      <ion-card-header><ion-card-subtitle>Test a coupon</ion-card-subtitle></ion-card-header>
      <ion-card-content>
        <ion-item>
          <ion-input v-model="test.code" label="Code" label-placement="stacked" />
          <ion-input
            v-model.number="test.amount"
            type="number"
            label="Order amount (₹)"
            label-placement="stacked"
          />
          <ion-button slot="end" @click="runTest">Check</ion-button>
        </ion-item>
        <p v-if="testResult" :class="testResult.valid ? 'ok' : 'bad'">
          {{ testResult.message }}
          <template v-if="testResult.valid">
            — discount {{ inr(testResult.discountPaise / 100) }}, pay
            {{ inr(testResult.finalAmountPaise / 100) }}
          </template>
        </p>
      </ion-card-content>
    </ion-card>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit coupon' : 'New coupon' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item>
              <ion-input
                v-model="form.code"
                label="Code"
                label-placement="stacked"
                required
                helper-text="Letters, digits, - and _; stored in upper case"
              />
            </ion-item>
            <ion-item
              ><ion-input v-model="form.description" label="Description" label-placement="stacked"
            /></ion-item>
            <ion-item>
              <ion-select
                v-model="form.discountType"
                label="Discount type"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option value="percent">Percentage</ion-select-option>
                <ion-select-option value="fixed">Fixed amount (₹)</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.discountValue"
                type="number"
                :label="form.discountType === 'percent' ? 'Discount (%)' : 'Discount (₹)'"
                label-placement="stacked"
                required
              />
            </ion-item>
            <ion-item v-if="form.discountType === 'percent'">
              <ion-input
                v-model="form.maxDiscount"
                type="number"
                label="Max discount (₹)"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.minAmount"
                type="number"
                label="Minimum order (₹)"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input v-model="form.validFrom" type="date" label="Valid from" label-placement="stacked" />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.validUntil"
                type="date"
                label="Valid until"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.usageLimit"
                type="number"
                label="Total uses (blank = unlimited)"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.perCustomerLimit"
                type="number"
                label="Uses per customer (blank = unlimited)"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.courseIds"
                label="Eligible courses"
                label-placement="stacked"
                :multiple="true"
                placeholder="All courses"
              >
                <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{
                  c.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item><ion-toggle v-model="form.isActive">Active</ion-toggle></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
          <template v-if="editingId">
            <ion-list>
              <ion-list-header><ion-label>Redemptions</ion-label></ion-list-header>
              <ion-item v-for="r in redemptions" :key="r.id">
                <ion-label>
                  <h3>{{ r.orderRef }}</h3>
                  <p>{{ new Date(r.createdAt).toLocaleString() }} · {{ r.customerKey ?? 'guest' }}</p>
                </ion-label>
                <ion-note slot="end">−{{ inr(r.discountPaise / 100) }} · {{ r.status }}</ion-note>
              </ion-item>
              <ion-item v-if="!redemptions.length" lines="none"
                ><ion-label>Not used yet.</ion-label></ion-item
              >
            </ion-list>
            <ion-button
              v-if="auth.can('website.delete')"
              expand="block"
              fill="clear"
              color="danger"
              @click="remove"
              >Delete coupon</ion-button
            >
          </template>
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
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import type { CouponDiscountType, CouponDto, CouponValidationResult } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { api } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { websiteApi, type CouponRedemptionDto, type NamedRef } from './api';

type Num = number | string | null;
interface Form {
  code: string;
  description: string;
  discountType: CouponDiscountType;
  discountValue: Num;
  maxDiscount: Num;
  minAmount: Num;
  validFrom: string;
  validUntil: string;
  usageLimit: Num;
  perCustomerLimit: Num;
  courseIds: number[];
  isActive: boolean;
}

const auth = useAuthStore();
const items = ref<CouponDto[]>([]);
const courses = ref<NamedRef[]>([]);
const search = ref('');
const form = ref<Form | null>(null);
const editingId = ref<number | null>(null);
const redemptions = ref<CouponRedemptionDto[]>([]);
const saving = ref(false);
const test = reactive({ code: '', amount: 10000 as number | string });
const testResult = ref<CouponValidationResult | null>(null);

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (d: string) => d.slice(0, 10);
const num = (v: Num) => (v === null || v === '' ? null : Number(v));

async function load() {
  try {
    items.value = (await websiteApi.coupons({ search: search.value })).items;
  } catch (e) {
    await toastError(e);
  }
}

async function openEditor(c?: CouponDto) {
  if (c && !auth.can('website.edit')) return;
  editingId.value = c?.id ?? null;
  form.value = {
    code: c?.code ?? '',
    description: c?.description ?? '',
    discountType: c?.discountType ?? 'percent',
    discountValue: c?.discountValue ?? 10,
    maxDiscount: c?.maxDiscount ?? null,
    minAmount: c?.minAmount ?? null,
    validFrom: c?.validFrom ? day(c.validFrom) : '',
    validUntil: c?.validUntil ? day(c.validUntil) : '',
    usageLimit: c?.usageLimit ?? null,
    perCustomerLimit: c?.perCustomerLimit ?? null,
    courseIds: c?.courseIds ?? [],
    isActive: c?.isActive ?? true,
  };
  redemptions.value = c ? (await websiteApi.redemptions(c.id).catch(() => ({ items: [] }))).items : [];
}

async function save() {
  const f = form.value;
  if (!f) return;
  saving.value = true;
  try {
    await websiteApi.saveCoupon(editingId.value, {
      code: f.code,
      description: f.description || null,
      discountType: f.discountType,
      discountValue: Number(f.discountValue),
      maxDiscount: f.discountType === 'percent' ? num(f.maxDiscount) : null,
      minAmount: num(f.minAmount),
      validFrom: f.validFrom || null,
      validUntil: f.validUntil ? `${f.validUntil}T23:59:59` : null,
      usageLimit: num(f.usageLimit),
      perCustomerLimit: num(f.perCustomerLimit),
      courseIds: f.courseIds.length ? f.courseIds : null,
      isActive: f.isActive,
    });
    form.value = null;
    await toast('Coupon saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!editingId.value) return;
  try {
    await websiteApi.removeCoupon(editingId.value);
    form.value = null;
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function runTest() {
  try {
    testResult.value = await websiteApi.validateCoupon({
      code: test.code,
      amountPaise: Math.round(Number(test.amount) * 100),
    });
  } catch (e) {
    await toastError(e);
  }
}

onMounted(async () => {
  await load();
  const c = await api
    .get<{ items: NamedRef[] }>('/academics/courses', { pageSize: 100 })
    .catch(() => ({ items: [] }));
  courses.value = c.items.map(({ id, name }) => ({ id, name }));
});
</script>

<style scoped>
.muted {
  color: var(--ion-color-medium);
}
.ok {
  color: var(--ion-color-success);
}
.bad {
  color: var(--ion-color-danger);
}
</style>

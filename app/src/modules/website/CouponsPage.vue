<template>
  <AppPage :title="t('website.coupons.title')" :on-refresh="load">
    <template #actions>
      <ion-button
        v-if="auth.can('website.create')"
        :aria-label="t('website.coupons.new')"
        @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <ion-searchbar
      v-model="search"
      :debounce="300"
      :placeholder="t('website.coupons.searchCode')"
      @ion-input="load"
    />
    <ion-list>
      <ion-item v-for="c in items" :key="c.id" button :detail="false" @click="openEditor(c)">
        <ion-label class="ion-text-wrap">
          <h2>
            <strong>{{ c.code }}</strong> —
            {{
              c.discountType === 'percent'
                ? t('website.coupons.percentOff', { n: formatNumber(c.discountValue) })
                : t('website.coupons.amountOff', { amount: inr(c.discountValue) })
            }}
            <span v-if="c.maxDiscount" class="muted">{{
              t('website.coupons.max', { amount: inr(c.maxDiscount) })
            }}</span>
          </h2>
          <p v-if="c.description">{{ c.description }}</p>
          <p>
            {{ t('website.coupons.used', { n: formatNumber(c.usedCount) })
            }}{{ c.usageLimit ? ` / ${formatNumber(c.usageLimit)}` : '' }} ·
            {{ c.validFrom ? formatDate(day(c.validFrom)) : t('website.coupons.now') }} →
            {{ c.validUntil ? formatDate(day(c.validUntil)) : t('website.coupons.noExpiry') }}
            <span v-if="c.minAmount"> · {{ t('website.coupons.min', { amount: inr(c.minAmount) }) }}</span>
            <span v-if="c.courseIds?.length">
              · {{ t('website.coupons.courseCount', { n: c.courseIds.length }, c.courseIds.length) }}</span
            >
          </p>
        </ion-label>
        <StatusChip
          slot="end"
          :label="c.isActive ? t('common.status.active') : t('common.status.inactive')"
          :tone="c.isActive ? 'success' : 'medium'"
        />
      </ion-item>
      <ion-item v-if="!items.length" lines="none"
        ><ion-label>{{ t('website.coupons.empty') }}</ion-label></ion-item
      >
    </ion-list>

    <ion-card>
      <ion-card-header
        ><ion-card-subtitle>{{ t('website.coupons.test') }}</ion-card-subtitle></ion-card-header
      >
      <ion-card-content>
        <ion-item>
          <ion-input v-model="test.code" :label="t('website.coupons.code')" label-placement="stacked" />
          <ion-input
            v-model.number="test.amount"
            type="number"
            :label="t('website.coupons.orderAmount')"
            label-placement="stacked"
          />
          <ion-button slot="end" @click="runTest">{{ t('website.coupons.check') }}</ion-button>
        </ion-item>
        <p v-if="testResult" :class="testResult.valid ? 'ok' : 'bad'">
          {{ testResult.message }}
          <template v-if="testResult.valid">
            —
            {{
              t('website.coupons.testResult', {
                discount: formatMoney(testResult.discountPaise),
                pay: formatMoney(testResult.finalAmountPaise),
              })
            }}
          </template>
        </p>
      </ion-card-content>
    </ion-card>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? t('website.coupons.edit') : t('website.coupons.new') }}</ion-title>
          <ion-buttons slot="end"
            ><ion-button @click="form = null">{{ t('common.actions.close') }}</ion-button></ion-buttons
          >
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item>
              <ion-input
                v-model="form.code"
                :label="t('website.coupons.code')"
                label-placement="stacked"
                required
                :helper-text="t('website.coupons.codeHelp')"
              />
            </ion-item>
            <ion-item
              ><ion-input
                v-model="form.description"
                :label="t('website.coupons.description')"
                label-placement="stacked"
            /></ion-item>
            <ion-item>
              <ion-select
                v-model="form.discountType"
                :label="t('website.coupons.discountType')"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option value="percent">{{ t('website.coupons.percentage') }}</ion-select-option>
                <ion-select-option value="fixed">{{ t('website.coupons.fixed') }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.discountValue"
                type="number"
                :label="
                  form.discountType === 'percent'
                    ? t('website.coupons.discountPercent')
                    : t('website.coupons.discountAmount')
                "
                label-placement="stacked"
                required
              />
            </ion-item>
            <ion-item v-if="form.discountType === 'percent'">
              <ion-input
                v-model="form.maxDiscount"
                type="number"
                :label="t('website.coupons.maxDiscount')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.minAmount"
                type="number"
                :label="t('website.coupons.minOrder')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.validFrom"
                type="date"
                :label="t('website.coupons.validFrom')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.validUntil"
                type="date"
                :label="t('website.coupons.validUntil')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.usageLimit"
                type="number"
                :label="t('website.coupons.totalUses')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.perCustomerLimit"
                type="number"
                :label="t('website.coupons.perCustomer')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.courseIds"
                :label="t('website.coupons.eligibleCourses')"
                label-placement="stacked"
                :multiple="true"
                :placeholder="t('website.coupons.allCourses')"
              >
                <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{
                  c.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-toggle v-model="form.isActive">{{ t('common.status.active') }}</ion-toggle></ion-item
            >
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">{{
            t('common.actions.save')
          }}</ion-button>
          <template v-if="editingId">
            <ion-list>
              <ion-list-header
                ><ion-label>{{ t('website.coupons.redemptions') }}</ion-label></ion-list-header
              >
              <ion-item v-for="r in redemptions" :key="r.id">
                <ion-label>
                  <h3>{{ r.orderRef }}</h3>
                  <p>{{ formatDateTime(r.createdAt) }} · {{ r.customerKey ?? t('website.coupons.guest') }}</p>
                </ion-label>
                <ion-note slot="end"
                  >−{{ formatMoney(r.discountPaise) }} · {{ statusText(r.status) }}</ion-note
                >
              </ion-item>
              <ion-item v-if="!redemptions.length" lines="none"
                ><ion-label>{{ t('website.coupons.notUsed') }}</ion-label></ion-item
              >
            </ion-list>
            <ion-button
              v-if="auth.can('website.delete')"
              expand="block"
              fill="clear"
              color="danger"
              @click="remove"
              >{{ t('website.coupons.delete') }}</ion-button
            >
          </template>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { api } from '@/core/api';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/core/format';
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

const { t, te } = useI18n();
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

/** Coupon amounts are stored in rupees. */
const inr = (rupees: number) => formatMoney(Math.round(rupees * 100));
const statusText = (s: string) => (te(`common.status.${s}`, 'en') ? t(`common.status.${s}`) : s);
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
    await toast(t('website.coupons.saved'));
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

<template>
  <ion-modal
    :is-open="isOpen"
    :initial-breakpoint="1"
    :breakpoints="[0, 1]"
    class="collect-fee"
    @did-present="focusSearch"
    @did-dismiss="close"
  >
    <ion-header>
      <ion-toolbar>
        <ion-buttons v-if="step === 'pay' && !fixedAccount" slot="start">
          <ion-button :aria-label="t('fees.collect.back')" @click="step = 'find'">
            <ion-icon slot="icon-only" :icon="arrowBackOutline" />
          </ion-button>
        </ion-buttons>
        <ion-title>{{ t('fees.collect.title') }}</ion-title>
        <ion-buttons slot="end">
          <ion-button @click="close">{{ t('common.actions.close') }}</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <!-- 1. Find the student -->
      <template v-if="step === 'find'">
        <ion-searchbar
          ref="searchbar"
          v-model="search"
          :debounce="250"
          :placeholder="t('fees.collect.searchPlaceholder')"
          @ion-input="find"
        />
        <ion-list v-if="results.length">
          <ion-item v-for="r in results" :key="r.id" button detail @click="choose(r.id)">
            <ion-label>
              <h2>{{ r.studentName }}</h2>
              <p>{{ r.admissionNumber }} · {{ r.title }}</p>
            </ion-label>
            <ion-note slot="end" class="due">{{
              t('fees.collect.due', { amount: formatMoney(r.balance) })
            }}</ion-note>
          </ion-item>
        </ion-list>
        <EmptyState
          v-else-if="!loading"
          :icon="searchOutline"
          :title="search ? t('fees.collect.noMatchTitle') : t('fees.collect.noDuesTitle')"
          :message="search ? t('fees.collect.noMatchMessage') : t('fees.collect.noDuesMessage')"
        />
      </template>

      <!-- 2. Amount and mode -->
      <template v-else-if="step === 'pay' && account && form">
        <div class="who">
          <div class="name">{{ account.studentName }}</div>
          <div class="muted">
            {{ account.admissionNumber }} · {{ account.title }} ·
            {{ t('fees.collect.due', { amount: formatMoney(account.balance) }) }}
          </div>
        </div>

        <label class="amount">
          <span class="currency" aria-hidden="true">₹</span>
          <input
            v-model="form.amount"
            type="number"
            inputmode="decimal"
            min="1"
            :aria-label="t('fees.collect.amount')"
          />
        </label>
        <p v-if="suggestion" class="hint">
          {{ t(`fees.collect.suggestion.${suggestion.kind}`, { label: suggestion.label ?? '' }) }}
          <span v-if="suggestion.dueDate">
            · {{ t('fees.collect.dueOn', { date: formatDate(suggestion.dueDate) }) }}</span
          >
        </p>

        <div class="modes" role="radiogroup" :aria-label="t('fees.collect.mode')">
          <button
            v-for="m in COLLECT_MODES"
            :key="m"
            type="button"
            role="radio"
            :aria-checked="form.mode === m"
            :class="['mode', { on: form.mode === m }]"
            @click="form.mode = m"
          >
            {{ t(`fees.collect.modes.${m}`) }}
          </button>
        </div>

        <ion-list>
          <ion-item v-if="form.mode === 'upi' || form.mode === 'bank_transfer'">
            <ion-input
              v-model="form.referenceNo"
              :label="t('fees.collect.reference')"
              label-placement="stacked"
            />
          </ion-item>
          <template v-if="form.mode === 'cheque'">
            <ion-item>
              <ion-input
                v-model="form.chequeNumber"
                :label="t('fees.collect.chequeNumber')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.bankName"
                :label="t('fees.collect.bankName')"
                label-placement="stacked"
              />
            </ion-item>
          </template>
        </ion-list>

        <FormSection advanced>
          <ion-list>
            <ion-item>
              <ion-input
                v-model="form.paidOn"
                type="date"
                :label="t('fees.collect.paidOn')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item v-if="form.mode === 'cheque'">
              <ion-input
                v-model="form.chequeDate"
                type="date"
                :label="t('fees.collect.chequeDate')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item v-if="form.mode !== 'cash' && banks.length">
              <ion-select
                v-model="form.bankAccountId"
                :label="t('fees.collect.depositedTo')"
                label-placement="stacked"
              >
                <ion-select-option :value="null">{{ t('fees.collect.defaultBank') }}</ion-select-option>
                <ion-select-option v-for="b in banks" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-textarea v-model="form.notes" :label="t('fees.collect.notes')" label-placement="stacked" />
            </ion-item>
          </ion-list>
          <p class="muted">{{ t('fees.collect.advanceNote') }}</p>
        </FormSection>

        <ion-button expand="block" class="primary" :disabled="saving || amountPaise <= 0" @click="record">
          {{ t('fees.collect.submit', { amount: formatMoney(amountPaise) }) }}
        </ion-button>
      </template>

      <!-- 3. Receipt -->
      <template v-else-if="step === 'done' && done">
        <div class="done" role="status">
          <ion-icon :icon="done.receiptId ? checkmarkCircle : timeOutline" class="big" aria-hidden="true" />
          <h2>
            {{
              done.receiptId
                ? t('fees.collect.doneTitle', { amount: formatMoney(done.amount) })
                : t('fees.collect.pendingTitle')
            }}
          </h2>
          <p class="muted">
            {{
              done.receiptId
                ? t('fees.collect.doneMessage', { receipt: done.receiptNumber, name: done.studentName })
                : t('fees.collect.pendingMessage')
            }}
          </p>
        </div>
        <template v-if="done.receiptId">
          <ion-button expand="block" class="primary" :disabled="saving" @click="share(done.receiptId)">
            <ion-icon slot="start" :icon="logoWhatsapp" />{{ t('fees.collect.shareWhatsapp') }}
          </ion-button>
          <ion-button expand="block" fill="outline" @click="pdf(done.receiptId)">
            <ion-icon slot="start" :icon="documentOutline" />{{ t('fees.collect.receiptPdf') }}
          </ion-button>
        </template>
        <ion-button v-if="!fixedAccount" expand="block" fill="clear" @click="restart">
          {{ t('fees.collect.another') }}
        </ion-button>
        <ion-button expand="block" fill="clear" @click="close">{{ t('fees.collect.finish') }}</ion-button>
      </template>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import {
  arrowBackOutline,
  checkmarkCircle,
  documentOutline,
  logoWhatsapp,
  searchOutline,
  timeOutline,
} from 'ionicons/icons';
import type { BankAccountDto, FeeAccountDto, OfflinePaymentMode } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import FormSection from '@/components/FormSection.vue';
import { formatDate, formatMoney } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { todayIso } from '../hr/api';
import { feesApi, openSigned, toPaise, type AccountDetail } from './api';
import { COLLECT_MODES, suggestedAmount } from './collect';

/**
 * Collect a fee in a few taps: find the student → amount (prefilled with what is due) → Cash/UPI/Cheque →
 * receipt on WhatsApp. Pass `accountId` to skip the search (from a fee account page).
 */
const props = defineProps<{ isOpen: boolean; accountId?: number | null }>();
const emit = defineEmits<{ close: []; recorded: [accountId: number] }>();
const { t } = useI18n();

type Step = 'find' | 'pay' | 'done';
interface PayForm {
  amount: string;
  mode: OfflinePaymentMode;
  paidOn: string;
  referenceNo: string;
  chequeNumber: string;
  chequeDate: string;
  bankName: string;
  bankAccountId: number | null;
  notes: string;
}

const step = ref<Step>('find');
const search = ref('');
const results = ref<FeeAccountDto[]>([]);
const loading = ref(false);
const account = ref<AccountDetail | null>(null);
const form = ref<PayForm | null>(null);
const banks = ref<BankAccountDto[]>([]);
const saving = ref(false);
const done = ref<{
  amount: number;
  receiptId: number | null;
  receiptNumber: string | null;
  studentName: string;
} | null>(null);
const searchbar = ref<InstanceType<typeof IonSearchbar> | null>(null);

const fixedAccount = computed(() => !!props.accountId);
const suggestion = computed(() => (account.value ? suggestedAmount(account.value) : null));
const amountPaise = computed(() => (form.value?.amount ? toPaise(form.value.amount) : 0));

async function find() {
  loading.value = true;
  try {
    const page = await feesApi.accounts({
      search: search.value.trim() || undefined,
      status: 'active',
      dues: 'true',
      pageSize: 20,
    });
    results.value = page.items;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

async function choose(id: number) {
  try {
    account.value = await feesApi.account(id);
  } catch (e) {
    return toastError(e);
  }
  const s = suggestedAmount(account.value);
  form.value = {
    amount: s.amount ? String(s.amount / 100) : '',
    mode: 'cash',
    paidOn: todayIso(),
    referenceNo: '',
    chequeNumber: '',
    chequeDate: '',
    bankName: '',
    bankAccountId: null,
    notes: '',
  };
  step.value = 'pay';
  if (!banks.value.length) banks.value = await feesApi.bankAccounts().catch(() => []);
}

async function record() {
  const a = account.value;
  const f = form.value;
  if (!a || !f || saving.value) return;
  saving.value = true;
  try {
    const r = await feesApi.recordOffline({
      accountId: a.id,
      amount: amountPaise.value,
      mode: f.mode,
      paidOn: f.paidOn,
      referenceNo: f.referenceNo || null,
      chequeNumber: f.chequeNumber || null,
      chequeDate: f.chequeDate || null,
      bankName: f.bankName || null,
      bankAccountId: f.bankAccountId,
      notes: f.notes || null,
    });
    const issued = r.status === 'successful' && r.receiptId;
    done.value = {
      amount: r.amount,
      receiptId: issued ? r.receiptId : null,
      receiptNumber: r.receiptNumber,
      studentName: a.studentName ?? '',
    };
    step.value = 'done';
    emit('recorded', a.id);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function share(receiptId: number) {
  saving.value = true;
  try {
    await feesApi.shareReceipt(receiptId);
    await toast(t('fees.collect.shared'));
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function pdf(receiptId: number) {
  try {
    openSigned(await feesApi.receiptPdf(receiptId));
  } catch (e) {
    toastError(e);
  }
}

function reset() {
  step.value = 'find';
  search.value = '';
  results.value = [];
  account.value = null;
  form.value = null;
  done.value = null;
}

function restart() {
  reset();
  void find();
  focusSearch();
}

function focusSearch() {
  if (step.value === 'find') setTimeout(() => searchbar.value?.$el?.setFocus?.(), 150);
}

function close() {
  if (props.isOpen) emit('close');
}

watch(
  () => props.isOpen,
  (open) => {
    if (!open) return reset();
    if (props.accountId) void choose(props.accountId);
    else void find();
  },
  { immediate: true },
);
</script>

<style scoped>
.who {
  margin-bottom: 12px;
}
.name {
  font-size: 20px;
  font-weight: 700;
}
.muted {
  color: var(--ion-color-medium);
}
.due {
  font-weight: 600;
  color: var(--ion-color-danger);
}
.amount {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 14px;
  border: 2px solid var(--ion-color-primary);
  border-radius: 14px;
}
.amount .currency {
  font-size: 28px;
  font-weight: 700;
}
.amount input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ion-text-color);
  font: inherit;
  font-size: 32px;
  font-weight: 700;
}
.hint {
  margin: 6px 2px 14px;
  color: var(--ion-color-medium-shade);
  font-size: 14px;
}
.modes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}
.mode {
  min-height: var(--app-tap-target);
  border: 1px solid var(--ion-color-step-200, #ccc);
  border-radius: 12px;
  background: var(--ion-item-background, #fff);
  color: var(--ion-text-color);
  font: inherit;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
}
.mode.on {
  border-color: var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary);
}
.primary {
  min-height: var(--app-tap-target);
  margin-top: 16px;
}
.done {
  text-align: center;
  padding: 16px 0;
}
.done .big {
  font-size: 64px;
  color: var(--ion-color-success);
}
</style>

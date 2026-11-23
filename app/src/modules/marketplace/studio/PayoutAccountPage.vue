<template>
  <AppPage title="Payout details" :back-href="`/market/studio/${scope}/revenue`">
    <ion-card v-if="current" class="current" data-testid="payout-account-current">
      <ion-card-content>
        <div class="label">Payouts are sent to</div>
        <h2>
          {{
            current.method === 'bank'
              ? `${current.bankName ?? 'Bank account'} ${current.maskedAccount}`
              : `UPI ${current.maskedAccount}`
          }}
        </h2>
        <p>
          {{ current.holderName }}<template v-if="current.ifsc"> · IFSC {{ current.ifsc }}</template> ·
          updated
          {{ dateLabel(current.updatedAt) }}
        </p>
      </ion-card-content>
    </ion-card>
    <p v-else-if="loaded" class="muted">
      Tell us where to send your earnings. Payouts are made monthly by bank transfer (NEFT/IMPS) or UPI.
    </p>

    <form v-if="loaded" @submit.prevent="save">
      <h3>{{ current ? 'Change payout details' : 'Add payout details' }}</h3>
      <ion-segment
        :value="form.method"
        @ion-change="form.method = $event.detail.value === 'upi' ? 'upi' : 'bank'"
      >
        <ion-segment-button value="bank"><ion-label>Bank account</ion-label></ion-segment-button>
        <ion-segment-button value="upi"><ion-label>UPI</ion-label></ion-segment-button>
      </ion-segment>
      <ion-list>
        <ion-item>
          <ion-input
            v-model="form.holderName"
            :label="form.method === 'bank' ? 'Account holder name' : 'Name on UPI'"
            label-placement="stacked"
            autocomplete="name"
            :maxlength="150"
            required
            data-testid="payout-holder"
          />
        </ion-item>
        <template v-if="form.method === 'bank'">
          <ion-item>
            <ion-input
              v-model="form.accountNumber"
              label="Account number"
              label-placement="stacked"
              inputmode="numeric"
              autocomplete="off"
              :maxlength="20"
              required
              data-testid="payout-account-number"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.confirmNumber"
              label="Re-enter account number"
              label-placement="stacked"
              inputmode="numeric"
              autocomplete="off"
              :maxlength="20"
              required
              data-testid="payout-account-confirm"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.ifsc"
              label="IFSC"
              label-placement="stacked"
              placeholder="e.g. HDFC0001234"
              autocapitalize="characters"
              :maxlength="11"
              required
              data-testid="payout-ifsc"
            />
          </ion-item>
          <ion-item>
            <ion-input v-model="form.bankName" label="Bank name" label-placement="stacked" :maxlength="150" />
          </ion-item>
        </template>
        <ion-item v-else>
          <ion-input
            v-model="form.upiId"
            label="UPI ID"
            label-placement="stacked"
            placeholder="e.g. name@okaxis"
            autocomplete="off"
            required
            data-testid="payout-upi"
          />
        </ion-item>
      </ion-list>
      <p v-if="problem" class="error" role="alert">{{ problem }}</p>
      <p class="muted">
        Your details are stored encrypted. Only the marketplace finance team can see the full number, when
        paying you.
      </p>
      <ion-button type="submit" :disabled="busy" data-testid="payout-save">Save payout details</ion-button>
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import { IFSC_PATTERN, UPI_ID_PATTERN, type MktPayoutAccountDto, type MktPayoutMethod } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import type { StudioScope } from '../api';
import { dateLabel, payoutStudioApi } from '../payouts-api';

const route = useRoute();
const scope = route.params.scope as StudioScope;
const api = payoutStudioApi(scope);
const current = ref<MktPayoutAccountDto | null>(null);
const loaded = ref(false);
const busy = ref(false);
const submitted = ref(false);
const form = reactive({
  method: 'bank' as MktPayoutMethod,
  holderName: '',
  accountNumber: '',
  confirmNumber: '',
  ifsc: '',
  bankName: '',
  upiId: '',
});

const problem = computed(() => {
  if (!submitted.value) return '';
  if (form.holderName.trim().length < 2) return 'Enter the name on the account.';
  if (form.method === 'upi')
    return UPI_ID_PATTERN.test(form.upiId.trim()) ? '' : 'Enter a valid UPI ID, e.g. name@okaxis.';
  const number = form.accountNumber.replace(/[\s-]/g, '');
  if (!/^\d{6,20}$/.test(number)) return 'Enter a valid account number (6–20 digits).';
  if (number !== form.confirmNumber.replace(/[\s-]/g, '')) return 'The account numbers do not match.';
  if (!IFSC_PATTERN.test(form.ifsc.trim().toUpperCase())) return 'Enter a valid IFSC, e.g. HDFC0001234.';
  return '';
});

async function load() {
  try {
    current.value = (await api.account()).account;
    if (current.value) {
      form.method = current.value.method;
      form.holderName = current.value.holderName;
      form.bankName = current.value.bankName ?? '';
      form.ifsc = current.value.ifsc ?? '';
    }
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}

async function save() {
  submitted.value = true;
  if (problem.value) return;
  busy.value = true;
  try {
    current.value = await api.saveAccount(
      form.method === 'bank'
        ? {
            method: 'bank',
            holderName: form.holderName.trim(),
            accountNumber: form.accountNumber.replace(/[\s-]/g, ''),
            ifsc: form.ifsc.trim().toUpperCase(),
            bankName: form.bankName.trim() || null,
          }
        : { method: 'upi', holderName: form.holderName.trim(), upiId: form.upiId.trim() },
    );
    form.accountNumber = '';
    form.confirmNumber = '';
    form.upiId = '';
    submitted.value = false;
    await toast('Payout details saved');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
form {
  max-width: 560px;
}
ion-segment {
  max-width: 320px;
  margin-bottom: 8px;
}
.current {
  margin: 0 0 16px;
  max-width: 560px;
}
.label {
  font-size: 12px;
  text-transform: uppercase;
  color: var(--ion-color-medium);
}
.muted {
  color: var(--ion-color-medium);
}
.error {
  color: var(--ion-color-danger);
}
</style>

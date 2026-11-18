<template>
  <AppPage title="Billing settings" :on-refresh="load">
    <p v-if="!profile || !policy" class="muted">{{ failed ? 'Could not load the settings.' : 'Loading…' }}</p>
    <template v-else>
      <form class="card" @submit.prevent="saveProfile">
        <div class="card-title">Seller details (printed on SaaS invoices)</div>
        <div class="grid">
          <ion-input
            v-model="profile.legalName"
            class="span-wide"
            fill="outline"
            label="Legal name"
            label-placement="stacked"
            :maxlength="150"
            required
          />
          <ion-input
            v-model="profile.gstin"
            fill="outline"
            label="GSTIN"
            label-placement="stacked"
            :maxlength="15"
            helper-text="Leave blank if not registered"
          />
          <ion-input
            v-model="profile.phone"
            fill="outline"
            label="Phone"
            label-placement="stacked"
            :maxlength="20"
          />
          <ion-input
            v-model="profile.email"
            fill="outline"
            label="Email"
            label-placement="stacked"
            type="email"
            :maxlength="150"
          />
          <ion-input
            v-model="profile.address"
            class="span-wide"
            fill="outline"
            label="Address"
            label-placement="stacked"
            :maxlength="255"
          />
          <ion-input
            v-model="profile.city"
            fill="outline"
            label="City"
            label-placement="stacked"
            :maxlength="100"
          />
          <ion-input
            v-model="profile.state"
            fill="outline"
            label="State"
            label-placement="stacked"
            :maxlength="100"
            helper-text="Same state as the institute: CGST + SGST; otherwise IGST"
          />
          <ion-input
            v-model="profile.pincode"
            fill="outline"
            label="PIN code"
            label-placement="stacked"
            :maxlength="12"
          />
        </div>

        <div class="card-title spaced">Numbering and tax</div>
        <div class="grid">
          <ion-input
            v-model="profile.invoicePrefix"
            fill="outline"
            label="Invoice prefix"
            label-placement="stacked"
            :maxlength="12"
            :helper-text="`Numbers look like ${profile.invoicePrefix || 'SAAS'}/25-26/000001`"
            required
          />
          <ion-input
            v-model="profile.creditNotePrefix"
            fill="outline"
            label="Credit note prefix"
            label-placement="stacked"
            :maxlength="12"
            required
          />
          <ion-input
            v-model="profile.sacCode"
            fill="outline"
            label="SAC code"
            label-placement="stacked"
            :maxlength="8"
            required
          />
          <ion-input
            v-model.number="profile.gstRatePercent"
            fill="outline"
            label="GST rate (%)"
            label-placement="stacked"
            type="number"
            :min="0"
            :max="28"
            step="0.01"
            helper-text="0 issues invoices without tax"
            required
          />
        </div>
        <p class="muted note">
          Changes apply to invoices issued from now on; issued invoices keep their details.
        </p>
        <div class="actions">
          <ion-button type="submit" :disabled="busy">Save seller details</ion-button>
        </div>
      </form>

      <form class="card" @submit.prevent="savePolicy">
        <div class="card-title">Renewals and expiry</div>
        <div class="grid">
          <ion-input
            v-model.number="policy.renewalLeadDays"
            fill="outline"
            label="Issue renewal invoices (days before expiry)"
            label-placement="stacked"
            type="number"
            :min="1"
            :max="60"
            required
          />
          <ion-input
            v-model.number="policy.invoiceDueDays"
            fill="outline"
            label="Other invoices due after (days)"
            label-placement="stacked"
            type="number"
            :min="0"
            :max="90"
            helper-text="Upgrades, add-ons, usage and manual invoices"
            required
          />
          <ion-input
            v-model.number="policy.graceDays"
            fill="outline"
            label="Grace period after a paid period (days)"
            label-placement="stacked"
            type="number"
            :min="0"
            :max="90"
            required
          />
          <ion-input
            v-model.number="policy.trialGraceDays"
            fill="outline"
            label="Grace period after a trial (days)"
            label-placement="stacked"
            type="number"
            :min="0"
            :max="90"
            required
          />
          <ion-select
            v-model="policy.afterGrace"
            fill="outline"
            label="After the grace period"
            label-placement="stacked"
            interface="popover"
          >
            <ion-select-option value="restricted">Restricted (read-only)</ion-select-option>
            <ion-select-option value="suspended">Suspended (billing only)</ion-select-option>
          </ion-select>
          <ion-input
            v-if="policy.afterGrace === 'restricted'"
            v-model="suspendAfter"
            fill="outline"
            label="Then suspend after (days)"
            label-placement="stacked"
            type="number"
            :min="0"
            :max="365"
            helper-text="Leave blank to never suspend automatically"
          />
        </div>
        <p class="muted note">
          During the grace period the institute keeps full access. Restricted institutes can view their data
          but not change it; suspended institutes can only open billing and data export.
        </p>
        <div class="actions">
          <ion-button type="submit" :disabled="busy">Save policy</ion-button>
        </div>
      </form>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonButton, IonInput, IonSelect, IonSelectOption } from '@ionic/vue';
import type { BillingPolicyDto, BillingProfileDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { billingAdminApi } from '../api';

const profile = ref<BillingProfileDto | null>(null);
const policy = ref<BillingPolicyDto | null>(null);
/** Text so that blank means "never". */
const suspendAfter = ref('');
const failed = ref(false);
const busy = ref(false);

const blankToNull = (v: string | null | undefined) => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

async function load() {
  try {
    const s = await billingAdminApi.settings();
    profile.value = s.profile;
    policy.value = s.policy;
    suspendAfter.value = s.policy.suspendAfterDays === null ? '' : String(s.policy.suspendAfterDays);
    failed.value = false;
  } catch (e) {
    failed.value = true;
    void toastError(e);
  }
}

async function saveProfile() {
  if (!profile.value) return;
  const p = profile.value;
  busy.value = true;
  try {
    profile.value = await billingAdminApi.saveProfile({
      legalName: p.legalName.trim(),
      gstin: blankToNull(p.gstin)?.toUpperCase() ?? null,
      address: blankToNull(p.address),
      city: blankToNull(p.city),
      state: blankToNull(p.state),
      pincode: blankToNull(p.pincode),
      email: blankToNull(p.email),
      phone: blankToNull(p.phone),
      invoicePrefix: p.invoicePrefix.trim().toUpperCase(),
      creditNotePrefix: p.creditNotePrefix.trim().toUpperCase(),
      sacCode: p.sacCode.trim(),
      gstRatePercent: Number(p.gstRatePercent),
    });
    await toast('Seller details saved');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function savePolicy() {
  if (!policy.value) return;
  const p = policy.value;
  const suspend =
    suspendAfter.value === '' || suspendAfter.value === null ? null : Number(suspendAfter.value);
  busy.value = true;
  try {
    policy.value = await billingAdminApi.savePolicy({
      graceDays: Number(p.graceDays),
      trialGraceDays: Number(p.trialGraceDays),
      afterGrace: p.afterGrace,
      suspendAfterDays: p.afterGrace === 'restricted' ? suspend : null,
      renewalLeadDays: Number(p.renewalLeadDays),
      invoiceDueDays: Number(p.invoiceDueDays),
    });
    await toast('Billing policy saved');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.card {
  border: 1px solid var(--ion-color-step-150, #ddd);
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
}
.card-title {
  font-size: 17px;
  margin-bottom: 8px;
}
.spaced {
  margin-top: 20px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
@media (min-width: 768px) {
  .grid {
    grid-template-columns: 1fr 1fr;
  }
  .span-wide {
    grid-column: span 2;
  }
}
.note {
  font-size: 13px;
}
.actions {
  display: flex;
  justify-content: flex-end;
}
</style>

<template>
  <ion-modal :is-open="open" @did-dismiss="close">
    <ion-header>
      <ion-toolbar>
        <ion-title>Buy an add-on</ion-title>
        <ion-buttons slot="end"><ion-button @click="close">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <p v-if="lapsed" class="danger">Renew the subscription before buying add-ons.</p>
      <p v-else-if="!options.length" class="muted">Your plan has no add-ons to buy.</p>
      <ion-list v-else>
        <ion-radio-group v-model="selected">
          <ion-item v-for="o in options" :key="o.key">
            <ion-radio :value="o.key" :disabled="!!o.blocked" justify="space-between">
              <div class="name">{{ o.title }}</div>
              <div class="muted small ion-text-wrap">
                {{ rupees(o.price) }} {{ o.priceUnit }}
                <template v-if="o.blocked"> · {{ o.blocked }}</template>
              </div>
            </ion-radio>
          </ion-item>
        </ion-radio-group>
        <ion-item v-if="choice && choice.entry.kind !== 'module'">
          <ion-input
            v-model.number="quantity"
            type="number"
            :min="1"
            :max="1000"
            label="Number of packs"
            label-placement="stacked"
          />
        </ion-item>
      </ion-list>

      <template v-if="choice && !lapsed">
        <p class="small">
          {{
            quantityOk
              ? `${qty} × ${packSize(choice.entry.kind, choice.entry.unitSize, choice.entry.moduleKey)}`
              : ''
          }}
          <template v-if="quantityOk">
            = <strong>{{ rupees(choice.price * qty) }}</strong> {{ choice.priceUnit }}</template
          >
        </p>
        <p class="muted small">
          <template v-if="choice.entry.kind === 'ai_credits'"
            >AI credits apply to this calendar month only and cannot be refunded.</template
          >
          <template v-else
            >Billed now for the rest of the current period (prorated), then renews with your subscription
            until you cancel it.</template
          >
          GST ({{ overview.gstRatePercent }}%) is added to the invoice.
        </p>
      </template>

      <ion-button expand="block" :disabled="lapsed || !choice || !quantityOk || busy" @click="buy"
        >Continue</ion-button
      >
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonRadio,
  IonRadioGroup,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import {
  ADDON_LABELS,
  type BillingActionResultDto,
  type BillingOverviewDto,
  type PlanAddonPrice,
} from '@erp/shared';
import { toastError } from '@/core/toast';
import { rupees } from '@/modules/hr/api';
import { billingApi } from '../api';
import { addonCyclePrice, packSize } from '../format';

const props = defineProps<{ open: boolean; overview: BillingOverviewDto }>();
const emit = defineEmits<{ close: []; done: [result: BillingActionResultDto] }>();

interface Option {
  key: string;
  entry: PlanAddonPrice;
  title: string;
  price: number;
  priceUnit: string;
  /** Why the add-on cannot be bought right now (mirrors the API's checks). */
  blocked: string | null;
}

const selected = ref<string | null>(null);
const quantity = ref<number | string>(1);
const busy = ref(false);

const lapsed = computed(() => ['grace', 'restricted', 'suspended'].includes(props.overview.status.state));

const options = computed<Option[]>(() => {
  const o = props.overview;
  const sub = o.subscription;
  const cycle = sub?.billingCycle ?? 'monthly';
  const modules = o.limits?.enabledModules;
  return o.addonCatalogue.map((entry) => {
    const recurring = entry.kind !== 'ai_credits';
    let blocked: string | null = null;
    if (recurring && !o.selfService) blocked = 'Contact support to change a managed plan';
    else if (recurring && sub?.status === 'trial') blocked = 'Available once the subscription is paid';
    else if (entry.kind === 'module' && (modules === null || modules?.includes(entry.moduleKey ?? '')))
      blocked = 'Already enabled';
    else if (
      entry.kind === 'module' &&
      o.addons.some((a) => a.kind === 'module' && a.moduleKey === entry.moduleKey && a.status === 'pending')
    )
      blocked = 'Awaiting payment';
    return {
      key: `${entry.kind}:${entry.moduleKey ?? ''}`,
      entry,
      title:
        entry.kind === 'module'
          ? `Module: ${entry.moduleKey ?? ''}`
          : `${ADDON_LABELS[entry.kind]} · ${packSize(entry.kind, entry.unitSize)} per pack`,
      price: addonCyclePrice(entry, cycle),
      priceUnit: recurring ? (cycle === 'yearly' ? 'per year' : 'per month') : 'one-time',
      blocked,
    };
  });
});

const choice = computed(() => options.value.find((o) => o.key === selected.value && !o.blocked) ?? null);
const qty = computed(() => (choice.value?.entry.kind === 'module' ? 1 : Number(quantity.value)));
const quantityOk = computed(() => Number.isInteger(qty.value) && qty.value >= 1 && qty.value <= 1000);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    selected.value = options.value.find((o) => !o.blocked)?.key ?? null;
    quantity.value = 1;
  },
  { immediate: true },
);

function close() {
  if (props.open) emit('close');
}

async function buy() {
  const c = choice.value;
  if (!c || !quantityOk.value || lapsed.value) return;
  busy.value = true;
  try {
    emit(
      'done',
      await billingApi.buyAddon({
        kind: c.entry.kind,
        moduleKey: c.entry.moduleKey ?? null,
        quantity: qty.value,
      }),
    );
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.name {
  font-weight: 600;
}
.small {
  font-size: 13px;
}
.danger {
  color: var(--ion-color-danger);
}
</style>

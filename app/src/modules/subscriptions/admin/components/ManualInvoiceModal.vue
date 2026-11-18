<template>
  <ion-modal :is-open="open" @did-dismiss="emit('close')">
    <ion-header>
      <ion-toolbar>
        <ion-title>New invoice</ion-title>
        <ion-buttons slot="end"><ion-button @click="emit('close')">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <p class="muted">
        For setup fees, custom work or dues migrated from another system. GST is added at
        {{ gstRatePercent }}%.
      </p>
      <form @submit.prevent="save">
        <ion-list>
          <template v-for="(l, idx) in lines" :key="idx">
            <ion-list-header>
              <ion-label>Line {{ idx + 1 }}</ion-label>
              <ion-button v-if="lines.length > 1" color="danger" @click="lines.splice(idx, 1)"
                >Remove</ion-button
              >
            </ion-list-header>
            <ion-item>
              <ion-input
                v-model="l.description"
                label="Description"
                label-placement="stacked"
                :maxlength="255"
                required
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model.number="l.quantity"
                label="Quantity"
                label-placement="stacked"
                type="number"
                :min="1"
                :max="100000"
                required
              />
              <ion-input
                v-model="l.unitPrice"
                label="Unit price (₹, before GST)"
                label-placement="stacked"
                type="number"
                :min="0.01"
                step="0.01"
                required
              />
            </ion-item>
          </template>
        </ion-list>
        <ion-button v-if="lines.length < 50" fill="clear" @click="addLine">Add line</ion-button>
        <ion-list>
          <ion-item>
            <ion-input v-model="dueDate" label="Due date (optional)" label-placement="stacked" type="date" />
          </ion-item>
          <ion-item>
            <ion-textarea
              v-model="notes"
              label="Notes (printed on the invoice)"
              label-placement="stacked"
              :maxlength="1000"
              :auto-grow="true"
            />
          </ion-item>
        </ion-list>
        <p>
          Subtotal <strong>{{ rupees(subtotal) }}</strong>, about
          <strong>{{ rupees(subtotal + Math.round((subtotal * gstRatePercent) / 100)) }}</strong> with GST
        </p>
        <ion-button expand="block" type="submit" :disabled="busy || !valid">Issue invoice</ion-button>
      </form>
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
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import type { SaasInvoiceDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { rupees } from '@/modules/hr/api';
import { billingAdminApi } from '../../api';
import { toPaise } from '../../format';

const props = defineProps<{ open: boolean; instituteId: number; gstRatePercent: number }>();
const emit = defineEmits<{ close: []; created: [invoice: SaasInvoiceDto] }>();

interface Line {
  description: string;
  quantity: number;
  unitPrice: string;
}
const blank = (): Line => ({ description: '', quantity: 1, unitPrice: '' });

const lines = ref<Line[]>([blank()]);
const dueDate = ref('');
const notes = ref('');
const busy = ref(false);

const linePaise = (l: Line) => toPaise(l.unitPrice || 0) * (Number(l.quantity) || 0);
const subtotal = computed(() => lines.value.reduce((t, l) => t + linePaise(l), 0));
const valid = computed(() =>
  lines.value.every(
    (l) =>
      l.description.trim().length >= 2 &&
      Number.isInteger(Number(l.quantity)) &&
      Number(l.quantity) >= 1 &&
      Number(l.quantity) <= 100000 &&
      toPaise(l.unitPrice || 0) >= 1,
  ),
);

const addLine = () => lines.value.push(blank());

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    lines.value = [blank()];
    dueDate.value = '';
    notes.value = '';
  },
);

async function save() {
  if (!valid.value) return;
  busy.value = true;
  try {
    const invoice = await billingAdminApi.createInvoice({
      instituteId: props.instituteId,
      lines: lines.value.map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity),
        unitPricePaise: toPaise(l.unitPrice),
      })),
      dueDate: dueDate.value || undefined,
      notes: notes.value.trim() || null,
    });
    await toast(`Invoice ${invoice.number} issued`);
    emit('created', invoice);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

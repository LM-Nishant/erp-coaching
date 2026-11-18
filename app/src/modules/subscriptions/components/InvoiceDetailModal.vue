<template>
  <ion-modal :is-open="invoiceId !== null" @did-dismiss="close">
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ detail?.invoice.number ?? 'Invoice' }}</ion-title>
        <ion-buttons slot="end"><ion-button @click="close">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <p v-if="!detail" class="muted">Loading…</p>
      <template v-else>
        <div class="chip-row">
          <ion-badge :color="INVOICE_STATUS_COLORS[inv!.status]">{{ inv!.status }}</ion-badge>
          <ion-badge color="light">{{ INVOICE_KIND_LABELS[inv!.kind] }}</ion-badge>
        </div>
        <div class="parties">
          <div>
            <div class="muted small">Billed to</div>
            <strong>{{ inv!.billedTo.name }}</strong>
            <div v-if="inv!.billedTo.gstin" class="small">GSTIN {{ inv!.billedTo.gstin }}</div>
            <div class="small">{{ partyAddress(inv!.billedTo) }}</div>
          </div>
          <div>
            <div class="muted small">From</div>
            <strong>{{ inv!.seller.name }}</strong>
            <div v-if="inv!.seller.gstin" class="small">GSTIN {{ inv!.seller.gstin }}</div>
            <div class="small">{{ partyAddress(inv!.seller) }}</div>
          </div>
        </div>
        <p class="small">
          Issued {{ formatDay(inv!.issueDate) }} · Due {{ formatDay(inv!.dueDate) }}
          <template v-if="inv!.periodStart">
            · Period {{ formatDate(inv!.periodStart) }} – {{ formatDate(inv!.periodEnd) }}</template
          >
        </p>

        <ion-list>
          <ion-item v-for="(l, i) in inv!.lines ?? []" :key="l.id ?? i">
            <ion-label class="ion-text-wrap">
              {{ l.description }}
              <p>
                {{ l.quantity }} × {{ rupees(l.unitPricePaise)
                }}<template v-if="l.sacCode"> · SAC {{ l.sacCode }}</template>
              </p>
            </ion-label>
            <ion-note slot="end">{{ rupees(l.amountPaise) }}</ion-note>
          </ion-item>
          <ion-item lines="none">
            <ion-label>Subtotal</ion-label><ion-note slot="end">{{ rupees(inv!.subtotalPaise) }}</ion-note>
          </ion-item>
          <ion-item v-if="inv!.cgstPaise" lines="none">
            <ion-label>CGST</ion-label><ion-note slot="end">{{ rupees(inv!.cgstPaise) }}</ion-note>
          </ion-item>
          <ion-item v-if="inv!.sgstPaise" lines="none">
            <ion-label>SGST</ion-label><ion-note slot="end">{{ rupees(inv!.sgstPaise) }}</ion-note>
          </ion-item>
          <ion-item v-if="inv!.igstPaise" lines="none">
            <ion-label>IGST</ion-label><ion-note slot="end">{{ rupees(inv!.igstPaise) }}</ion-note>
          </ion-item>
          <ion-item lines="none">
            <ion-label><strong>Total</strong></ion-label>
            <ion-note slot="end"
              ><strong>{{ rupees(inv!.totalPaise) }}</strong></ion-note
            >
          </ion-item>
          <ion-item v-if="inv!.creditedPaise" lines="none">
            <ion-label>Credited</ion-label><ion-note slot="end">− {{ rupees(inv!.creditedPaise) }}</ion-note>
          </ion-item>
          <ion-item v-if="inv!.paidPaise" lines="none">
            <ion-label>Paid</ion-label><ion-note slot="end">− {{ rupees(inv!.paidPaise) }}</ion-note>
          </ion-item>
          <ion-item lines="none">
            <ion-label><strong>Balance</strong></ion-label>
            <ion-note slot="end"
              ><strong>{{ rupees(Math.max(0, inv!.balancePaise)) }}</strong></ion-note
            >
          </ion-item>
        </ion-list>
        <p v-if="inv!.notes" class="small">{{ inv!.notes }}</p>
        <p v-if="inv!.voidedAt" class="small">
          Voided {{ formatDateTime(inv!.voidedAt)
          }}<template v-if="inv!.voidReason">: {{ inv!.voidReason }}</template>
        </p>

        <div class="actions">
          <ion-button v-if="canPay && payable" color="primary" @click="emit('pay', inv!)">
            Pay {{ rupees(inv!.balancePaise) }}
          </ion-button>
          <ion-button fill="outline" :disabled="busy" @click="openPdf(() => source.invoicePdf(inv!.id))">
            <ion-icon slot="start" :icon="downloadOutline" />PDF
          </ion-button>
          <template v-if="admin">
            <ion-button v-if="payable" fill="outline" :disabled="busy" @click="recordPayment"
              >Record payment</ion-button
            >
            <ion-button v-if="inv!.status !== 'void'" fill="outline" :disabled="busy" @click="creditNote"
              >Credit note</ion-button
            >
            <ion-button
              v-if="inv!.status === 'open' && !inv!.paidPaise && !inv!.creditedPaise"
              fill="outline"
              color="danger"
              :disabled="busy"
              @click="voidInvoice"
              >Void</ion-button
            >
          </template>
        </div>

        <ion-list v-if="detail.payments.length">
          <ion-list-header><ion-label>Payments</ion-label></ion-list-header>
          <ion-item v-for="p in detail.payments" :key="p.id">
            <ion-label class="ion-text-wrap">
              {{ rupees(p.amountPaise) }} · {{ p.method === 'manual' ? 'Manual' : (p.gateway ?? 'Gateway') }}
              <p>
                {{ formatDateTime(p.paidAt ?? p.createdAt) }}
                <template v-if="p.reference"> · Ref {{ p.reference }}</template>
                <template v-if="p.note"> · {{ p.note }}</template>
              </p>
            </ion-label>
            <ion-button
              v-if="p.status === 'pending' && p.method === 'gateway' && (admin || canPay)"
              slot="end"
              fill="clear"
              size="small"
              :disabled="busy"
              @click="act(() => source.syncPayment(p.id), 'Payment status updated')"
              >Check status</ion-button
            >
            <ion-badge slot="end" :color="PAYMENT_STATUS_COLORS[p.status]">{{ p.status }}</ion-badge>
          </ion-item>
        </ion-list>

        <ion-list v-if="detail.creditNotes.length">
          <ion-list-header><ion-label>Credit notes</ion-label></ion-list-header>
          <ion-item v-for="c in detail.creditNotes" :key="c.id">
            <ion-label class="ion-text-wrap">
              {{ c.number }} · {{ rupees(c.amountPaise) }}
              <p>{{ formatDate(c.createdAt) }} · {{ c.reason }}</p>
            </ion-label>
            <ion-button
              slot="end"
              fill="clear"
              :disabled="busy"
              aria-label="Credit note PDF"
              @click="openPdf(() => source.creditNotePdf(c.id))"
              ><ion-icon :icon="downloadOutline"
            /></ion-button>
          </ion-item>
        </ion-list>
      </template>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonTitle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import type { BilledPartyDto, SaasInvoiceDetailDto, SaasInvoiceDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { rupees } from '@/modules/hr/api';
import { billingAdminApi, openLink, type InvoiceSource, type SignedLink } from '../api';
import {
  INVOICE_KIND_LABELS,
  INVOICE_STATUS_COLORS,
  PAYMENT_STATUS_COLORS,
  formatDate,
  formatDateTime,
  formatDay,
  toPaise,
} from '../format';

const props = withDefaults(
  defineProps<{ invoiceId: number | null; source: InvoiceSource; admin?: boolean; canPay?: boolean }>(),
  { admin: false, canPay: false },
);
const emit = defineEmits<{ close: []; pay: [invoice: SaasInvoiceDto]; changed: [] }>();

const detail = ref<SaasInvoiceDetailDto | null>(null);
const busy = ref(false);
const inv = computed(() => detail.value?.invoice);
const payable = computed(() => inv.value?.status === 'open' && inv.value.balancePaise > 0);

const partyAddress = (p: BilledPartyDto) => [p.address, p.city, p.state].filter(Boolean).join(', ');

async function load() {
  if (props.invoiceId === null) return;
  try {
    detail.value = await props.source.detail(props.invoiceId);
  } catch (e) {
    void toastError(e);
    close();
  }
}

watch(
  () => props.invoiceId,
  (id) => {
    detail.value = null;
    if (id !== null) void load();
  },
  { immediate: true },
);

function close() {
  if (props.invoiceId !== null) emit('close');
}

async function openPdf(link: () => Promise<SignedLink>) {
  busy.value = true;
  try {
    openLink(await link());
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function act(fn: () => Promise<unknown>, done: string) {
  busy.value = true;
  try {
    await fn();
    await toast(done);
    emit('changed');
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function recordPayment() {
  const invoice = inv.value;
  if (!invoice) return;
  const alert = await alertController.create({
    header: 'Record payment',
    message: `Balance ${rupees(invoice.balancePaise)}. Use this for bank transfers, cheques or cash received offline.`,
    inputs: [
      {
        name: 'amount',
        type: 'number',
        placeholder: 'Amount (₹)',
        value: invoice.balancePaise / 100,
        min: 0.01,
      },
      { name: 'reference', type: 'text', placeholder: 'UTR / cheque / reference' },
      { name: 'note', type: 'text', placeholder: 'Note (optional)' },
    ],
    buttons: [
      'Cancel',
      {
        text: 'Record',
        handler: (v: { amount: string; reference: string; note: string }) => {
          const amountPaise = toPaise(v.amount);
          if (!(amountPaise > 0)) return false;
          void act(
            () =>
              billingAdminApi.recordPayment(invoice.id, {
                amountPaise,
                reference: v.reference.trim() || null,
                note: v.note.trim() || null,
              }),
            'Payment recorded',
          );
        },
      },
    ],
  });
  await alert.present();
}

async function creditNote() {
  const invoice = inv.value;
  if (!invoice) return;
  const creditable = invoice.totalPaise - invoice.creditedPaise;
  const alert = await alertController.create({
    header: 'Issue credit note',
    message: `Up to ${rupees(creditable)} (including GST). Credit beyond the unpaid balance is a refund you settle offline.`,
    inputs: [
      {
        name: 'amount',
        type: 'number',
        placeholder: 'Amount incl. GST (₹)',
        value: Math.max(0, Math.min(creditable, invoice.balancePaise)) / 100 || undefined,
        min: 0.01,
      },
      { name: 'reason', type: 'text', placeholder: 'Reason' },
    ],
    buttons: [
      'Cancel',
      {
        text: 'Issue',
        handler: (v: { amount: string; reason: string }) => {
          const amountPaise = toPaise(v.amount);
          if (!(amountPaise > 0) || v.reason.trim().length < 3) {
            void toast('Enter an amount and a reason (3+ characters)', 'warning');
            return false;
          }
          void act(
            () => billingAdminApi.creditNote(invoice.id, amountPaise, v.reason.trim()),
            'Credit note issued',
          );
        },
      },
    ],
  });
  await alert.present();
}

async function voidInvoice() {
  const invoice = inv.value;
  if (!invoice) return;
  const alert = await alertController.create({
    header: `Void ${invoice.number}?`,
    message: 'The invoice stops being payable. Pending add-ons it was issued for are cancelled.',
    inputs: [{ name: 'reason', type: 'text', placeholder: 'Reason' }],
    buttons: [
      'Cancel',
      {
        text: 'Void',
        role: 'destructive',
        handler: (v: { reason: string }) => {
          if (v.reason.trim().length < 3) {
            void toast('Enter a reason (3+ characters)', 'warning');
            return false;
          }
          void act(() => billingAdminApi.voidInvoice(invoice.id, v.reason.trim()), 'Invoice voided');
        },
      },
    ],
  });
  await alert.present();
}
</script>

<style scoped>
.parties {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin: 12px 0;
}
.small {
  font-size: 13px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 8px 0 16px;
}
</style>

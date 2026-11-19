<template>
  <AppPage title="Academic sessions" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'academics.configure'" @click="promo = { fromBatchId: null, toBatchId: null }"
        >Promote</ion-button
      >
      <ion-button v-can="'academics.create'" aria-label="New academic session" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-list>
      <ion-item v-for="s in sessions" :key="s.id">
        <ion-label>
          <h2>
            {{ s.name }}
            <ion-badge v-if="s.isCurrent" color="success">current</ion-badge>
            <ion-badge :color="statusColor(s.status)">{{ s.status }}</ion-badge>
          </h2>
          <p>{{ s.startDate }} → {{ s.endDate }}</p>
        </ion-label>
        <ion-button
          v-if="!s.isCurrent"
          slot="end"
          v-can="'academics.configure'"
          fill="clear"
          @click="makeCurrent(s)"
          >Make current</ion-button
        >
        <ion-button
          slot="end"
          v-can="'academics.edit'"
          fill="clear"
          :aria-label="`Edit ${s.name}`"
          @click="openEditor(s)"
          ><ion-icon slot="icon-only" :icon="createOutline"
        /></ion-button>
        <ion-button
          slot="end"
          v-can="'academics.delete'"
          fill="clear"
          color="danger"
          :aria-label="`Delete ${s.name}`"
          @click="remove(s)"
          ><ion-icon slot="icon-only" :icon="trashOutline"
        /></ion-button>
      </ion-item>
      <ion-item v-if="!loading && !sessions.length"
        ><ion-label class="muted">No academic sessions yet.</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit session' : 'New session' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item
              ><ion-input v-model="form.name" label="Name (e.g. 2025-26)" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.startDate"
                type="date"
                label="Start"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.endDate" type="date" label="End" label-placement="stacked" required
            /></ion-item>
            <ion-item>
              <ion-select v-model="form.status" label="Status" label-placement="stacked">
                <ion-select-option value="planned">Planned</ion-select-option>
                <ion-select-option value="active">Active</ion-select-option>
                <ion-select-option value="closed">Closed</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!promo" @did-dismiss="closePromotion">
      <ion-header>
        <ion-toolbar>
          <ion-title>Promote students</ion-title>
          <ion-buttons slot="end"><ion-button @click="promo = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <template v-if="promoSummary">
          <h2>{{ promoSummary.headline }}</h2>
          <ion-list v-if="promoSummary.skipped.length">
            <ion-item v-for="g in promoSummary.skipped" :key="g.reason">
              <ion-label class="ion-text-wrap">Not promoted ({{ g.count }}): {{ g.reason }}</ion-label>
            </ion-item>
          </ion-list>
          <template v-if="promoSummary.fees">
            <h2>{{ promoSummary.fees.headline }}</h2>
            <ion-list v-if="promoSummary.fees.skipped.length">
              <ion-item v-for="g in promoSummary.fees.skipped" :key="g.reason">
                <ion-label class="ion-text-wrap">
                  <h3>Not billed ({{ g.count }}): {{ g.reason }}</h3>
                  <p v-if="g.names.length">{{ g.names.join(', ') }}</p>
                </ion-label>
              </ion-item>
            </ion-list>
          </template>
          <ion-button expand="block" @click="promo = null">Done</ion-button>
        </template>
        <template v-else>
          <p class="muted">
            Moves every active student of the source batch into a batch of a later session. The old enrollment
            is kept as history with status “promoted”.
          </p>
          <ion-list v-if="promo">
            <ion-item>
              <ion-select v-model="promo.fromBatchId" label="From batch" label-placement="stacked">
                <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{
                  batchLabel(b)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="promo.toBatchId" label="To batch" label-placement="stacked">
                <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{
                  batchLabel(b)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <template v-if="feeOptions?.available">
              <ion-item>
                <ion-toggle v-model="fee.apply" :disabled="!feeOptions.structures.length"
                  >Apply new-session fees</ion-toggle
                >
              </ion-item>
              <template v-if="fee.apply && feeStructure">
                <ion-item>
                  <ion-select v-model="fee.structureId" label="Fee structure" label-placement="stacked">
                    <ion-select-option v-for="s in feeOptions.structures" :key="s.id" :value="s.id">{{
                      structureLabel(s)
                    }}</ion-select-option>
                  </ion-select>
                </ion-item>
                <ion-item v-if="takesFirstDueDate(feeStructure)">
                  <ion-input
                    v-model="fee.firstDueDate"
                    type="date"
                    label="First due date"
                    label-placement="stacked"
                    :helper-text="firstDueDateHint(feeStructure)"
                  />
                </ion-item>
              </template>
              <ion-item v-if="!feeOptions.structures.length" lines="none">
                <ion-label class="muted ion-text-wrap"
                  >No active fee structure applies to the target batch, so nobody will be billed. Add one
                  under Fee structures to bill the promoted students.</ion-label
                >
              </ion-item>
              <ion-item v-else-if="!fee.apply" lines="none">
                <ion-label class="muted ion-text-wrap"
                  >Promoted students won't be billed for the new session. Bill them later under Fee
                  accounts.</ion-label
                >
              </ion-item>
            </template>
          </ion-list>
          <ion-button
            expand="block"
            :disabled="
              !promo?.fromBatchId || !promo?.toBatchId || saving || feeLoading || (fee.apply && !feeStructure)
            "
            @click="promote"
            >Promote</ion-button
          >
        </template>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
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
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToggle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, createOutline, trashOutline } from 'ionicons/icons';
import type { AcademicSessionDto, AcademicSessionStatus, BatchDto, PromotionFeeOptions } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi, statusColor } from './api';
import {
  defaultFeeChoice,
  firstDueDateHint,
  noFees,
  promotionRequest,
  promotionSummary,
  structureLabel,
  takesFirstDueDate,
  type PromotionSummary,
} from './promotion';

const auth = useAuthStore();
const sessions = ref<AcademicSessionDto[]>([]);
const batches = ref<BatchDto[]>([]);
const loading = ref(true);
const saving = ref(false);
const editingId = ref<number | null>(null);
const form = ref<{ name: string; startDate: string; endDate: string; status: AcademicSessionStatus } | null>(
  null,
);
const promo = ref<{ fromBatchId: number | null; toBatchId: number | null } | null>(null);
const promoSummary = ref<PromotionSummary | null>(null);
const feeOptions = ref<PromotionFeeOptions | null>(null);
const feeLoading = ref(false);
const fee = ref(noFees());
const feeStructure = computed(() => feeOptions.value?.structures.find((s) => s.id === fee.value.structureId));
const canBill = computed(() => auth.can('fees.create') && auth.moduleEnabled('fees'));
let feeRequest = 0;

const sessionName = (id: number) => sessions.value.find((s) => s.id === id)?.name ?? '';
const batchLabel = (b: BatchDto) => `${b.name} (${b.code}) · ${sessionName(b.academicSessionId)}`;

async function load() {
  loading.value = true;
  try {
    sessions.value = await academicsApi.sessions();
    if (auth.can('academics.configure')) batches.value = (await academicsApi.batches()).items;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

function openEditor(s?: AcademicSessionDto) {
  editingId.value = s?.id ?? null;
  form.value = {
    name: s?.name ?? '',
    startDate: s?.startDate ?? '',
    endDate: s?.endDate ?? '',
    status: s?.status ?? 'planned',
  };
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  try {
    await academicsApi.saveSession({ ...form.value }, editingId.value ?? undefined);
    form.value = null;
    await toast('Session saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function makeCurrent(s: AcademicSessionDto) {
  try {
    await academicsApi.makeCurrent(s.id);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function remove(s: AcademicSessionDto) {
  const alert = await alertController.create({
    header: `Delete ${s.name}?`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () => academicsApi.removeSession(s.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

// The fee structures on offer depend on the target batch; a newer choice discards older responses.
watch(
  () => promo.value?.toBatchId ?? null,
  async (toBatchId) => {
    const current = ++feeRequest;
    feeOptions.value = null;
    fee.value = noFees();
    feeLoading.value = !!toBatchId && canBill.value;
    if (!toBatchId || !feeLoading.value) return;
    try {
      const options = await academicsApi.promotionFees(toBatchId);
      if (current !== feeRequest) return;
      feeOptions.value = options;
      fee.value = defaultFeeChoice(options);
    } catch (e) {
      if (current === feeRequest) await toastError(e);
    } finally {
      if (current === feeRequest) feeLoading.value = false;
    }
  },
);

async function promote() {
  const p = promo.value;
  if (!p?.fromBatchId || !p.toBatchId) return;
  saving.value = true;
  try {
    const r = await academicsApi.promote(
      promotionRequest({ fromBatchId: p.fromBatchId, toBatchId: p.toBatchId }, fee.value, feeOptions.value),
    );
    promoSummary.value = promotionSummary(r);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

function closePromotion() {
  promo.value = null;
  promoSummary.value = null;
}

onMounted(load);
</script>

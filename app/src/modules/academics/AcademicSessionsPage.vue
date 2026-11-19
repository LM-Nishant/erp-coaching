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

    <ion-modal :is-open="!!promo" @did-dismiss="promo = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Promote students</ion-title>
          <ion-buttons slot="end"><ion-button @click="promo = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
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
        </ion-list>
        <ion-button
          expand="block"
          :disabled="!promo?.fromBatchId || !promo?.toBatchId || saving"
          @click="promote"
          >Promote</ion-button
        >
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, createOutline, trashOutline } from 'ionicons/icons';
import type { AcademicSessionDto, AcademicSessionStatus, BatchDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi, statusColor } from './api';

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

async function promote() {
  if (!promo.value?.fromBatchId || !promo.value.toBatchId) return;
  saving.value = true;
  try {
    const r = await academicsApi.promote({
      fromBatchId: promo.value.fromBatchId,
      toBatchId: promo.value.toBatchId,
    });
    promo.value = null;
    await toast(
      `Promoted ${r.promoted} student(s)${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}`,
    );
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

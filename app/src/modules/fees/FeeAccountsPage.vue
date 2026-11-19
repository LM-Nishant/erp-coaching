<template>
  <AppPage title="Fee accounts" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'fees.create'" aria-label="Assign fees" @click="openCreate"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <ion-searchbar
      v-model="search"
      :debounce="400"
      placeholder="Student name / admission no."
      @ion-input="load"
    />
    <ion-item lines="none"
      ><ion-checkbox v-model="duesOnly" @ion-change="load">Only with dues</ion-checkbox></ion-item
    >
    <ion-list>
      <ion-item v-for="a in accounts" :key="a.id" button :router-link="`/fees/accounts/${a.id}`">
        <ion-label>
          <h3>
            {{ a.studentName }} <small class="muted">{{ a.admissionNumber }}</small>
          </h3>
          <p>{{ a.title }}</p>
          <p class="muted">Net {{ rupees(a.net) }} · paid {{ rupees(a.paid) }}</p>
        </ion-label>
        <ion-badge slot="end" :color="a.balance > 0 ? 'warning' : STATUS_COLORS[a.status]">{{
          a.balance > 0 ? `${rupees(a.balance)} due` : a.status
        }}</ion-badge>
      </ion-item>
      <ion-item v-if="!accounts.length"><ion-label class="muted">No fee accounts.</ion-label></ion-item>
    </ion-list>

    <ion-modal :is-open="!!create" @did-dismiss="create = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Assign fees</ion-title>
          <ion-buttons slot="end"><ion-button @click="create = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="create" class="ion-padding">
        <ion-segment v-model="create.target">
          <ion-segment-button value="student">One student</ion-segment-button>
          <ion-segment-button value="batch">Whole batch</ion-segment-button>
        </ion-segment>
        <ion-list>
          <template v-if="create.target === 'student'">
            <ion-searchbar
              v-model="create.query"
              :debounce="400"
              placeholder="Find student"
              @ion-input="findStudents"
            />
            <ion-item v-for="s in studentHits" :key="s.id" button @click="create.studentId = s.id">
              <ion-label
                >{{ s.name }} <small class="muted">{{ s.admissionNumber }}</small></ion-label
              >
              <ion-note v-if="create.studentId === s.id" slot="end">✓</ion-note>
            </ion-item>
          </template>
          <ion-item v-else>
            <ion-select v-model="create.batchId" label="Batch" label-placement="stacked">
              <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{
                b.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select v-model="create.structureId" label="Fee structure" label-placement="stacked">
              <ion-select-option v-if="create.target === 'batch'" :value="null"
                >Auto (batch/course match)</ion-select-option
              >
              <ion-select-option v-for="s in structures" :key="s.id" :value="s.id"
                >{{ s.name }} v{{ s.version }} · {{ rupees(s.total) }}</ion-select-option
              >
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-input
              v-model="create.firstDueDate"
              type="date"
              label="First due date"
              label-placement="stacked"
            />
          </ion-item>
        </ion-list>
        <ion-button expand="block" :disabled="saving" @click="saveCreate">Create</ion-button>
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
  IonCheckbox,
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
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import type { BatchDto, FeeAccountDto, FeeStructureDto, StudentDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { academicsApi } from '../academics/api';
import { rupees } from '../hr/api';
import { studentsApi } from '../students/api';
import { STATUS_COLORS, feesApi } from './api';

const accounts = ref<FeeAccountDto[]>([]);
const search = ref('');
const duesOnly = ref(false);
const structures = ref<FeeStructureDto[]>([]);
const batches = ref<BatchDto[]>([]);
const studentHits = ref<StudentDto[]>([]);
const saving = ref(false);
const create = ref<{
  target: 'student' | 'batch';
  query: string;
  studentId: number | null;
  batchId: number | null;
  structureId: number | null;
  firstDueDate: string;
} | null>(null);

async function load() {
  try {
    accounts.value = (
      await feesApi.accounts({ search: search.value || undefined, dues: duesOnly.value ? 'true' : undefined })
    ).items;
  } catch (e) {
    void toastError(e);
  }
}

async function openCreate() {
  create.value = {
    target: 'student',
    query: '',
    studentId: null,
    batchId: null,
    structureId: null,
    firstDueDate: '',
  };
  try {
    const [s, b] = await Promise.all([feesApi.structures({ status: 'active' }), academicsApi.batches()]);
    structures.value = s.items;
    batches.value = b.items;
  } catch (e) {
    void toastError(e);
  }
}

async function findStudents() {
  if (!create.value?.query) return;
  try {
    studentHits.value = (await studentsApi.list({ search: create.value.query, pageSize: 10 })).items;
  } catch (e) {
    void toastError(e);
  }
}

async function saveCreate() {
  const c = create.value;
  if (!c) return;
  saving.value = true;
  try {
    const firstDueDate = c.firstDueDate || undefined;
    if (c.target === 'student') {
      if (!c.studentId || !c.structureId) throw new Error('Pick a student and a fee structure');
      await feesApi.createAccount({ studentId: c.studentId, structureId: c.structureId, firstDueDate });
      await toast('Fee account created');
    } else {
      if (!c.batchId) throw new Error('Pick a batch');
      const r = await feesApi.generateBatch({
        batchId: c.batchId,
        structureId: c.structureId ?? undefined,
        firstDueDate,
      });
      await toast(`${r.created} account(s) created, ${r.skipped} already had one`);
    }
    create.value = null;
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

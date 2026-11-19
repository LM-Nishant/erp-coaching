<template>
  <AppPage title="Staff" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'hr.create'" aria-label="New staff member" @click="openEditor"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar v-model="search" :debounce="300" placeholder="Name, code, mobile" @ion-input="load" />
    <ion-segment v-model="status" @ion-change="load">
      <ion-segment-button value="active">Active</ion-segment-button>
      <ion-segment-button value="on_notice">On notice</ion-segment-button>
      <ion-segment-button value="exited">Exited</ion-segment-button>
      <ion-segment-button value="">All</ion-segment-button>
    </ion-segment>
    <ion-list>
      <ion-item v-for="e in employees" :key="e.id" :router-link="`/hr/employees/${e.id}`" button>
        <ion-label>
          <h2>
            {{ e.name }}
            <ion-badge v-if="e.isTeacher" color="tertiary">Teacher</ion-badge>
          </h2>
          <p>{{ [e.employeeCode, e.designation, e.department].filter(Boolean).join(' · ') }}</p>
        </ion-label>
        <ion-badge slot="end" :color="e.status === 'active' ? 'success' : 'medium'">{{ e.status }}</ion-badge>
      </ion-item>
      <ion-item v-if="!loading && !employees.length"
        ><ion-label class="muted">No staff found.</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>New staff member</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item>
              <ion-select
                v-model="form.userId"
                label="Linked user login (optional)"
                label-placement="stacked"
              >
                <ion-select-option :value="null">No login</ion-select-option>
                <ion-select-option v-for="c in candidates" :key="c.id" :value="c.id">
                  {{ c.name }} ({{ c.roles.join(', ') }})
                </ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="!form.userId">
              <ion-input v-model="form.name" label="Name" label-placement="stacked" required />
            </ion-item>
            <ion-item v-if="!form.userId">
              <ion-input v-model="form.mobile" label="Mobile" label-placement="stacked" type="tel" />
            </ion-item>
            <ion-item>
              <ion-input v-model="form.designation" label="Designation" label-placement="stacked" />
            </ion-item>
            <ion-item>
              <ion-input v-model="form.department" label="Department" label-placement="stacked" />
            </ion-item>
            <ion-item>
              <ion-select v-model="form.employmentType" label="Employment type" label-placement="stacked">
                <ion-select-option v-for="t in EMPLOYMENT_TYPES" :key="t" :value="t">{{
                  t
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item><ion-checkbox v-model="form.isTeacher">Teacher</ion-checkbox></ion-item>
            <ion-item>
              <ion-input
                v-model="form.dateOfJoining"
                label="Date of joining"
                label-placement="stacked"
                type="date"
                required
              />
            </ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
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
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import { EMPLOYMENT_TYPES, type EmployeeDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { blankToNull, hrApi, todayIso, type Candidate } from './api';

const router = useRouter();
const employees = ref<EmployeeDto[]>([]);
const candidates = ref<Candidate[]>([]);
const search = ref('');
const status = ref('active');
const loading = ref(true);
const saving = ref(false);
const form = ref<Partial<EmployeeDto> | null>(null);

async function load() {
  loading.value = true;
  try {
    employees.value = (await hrApi.employees({ search: search.value, status: status.value })).items;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

async function openEditor() {
  form.value = {
    userId: null,
    name: '',
    employmentType: 'full_time',
    isTeacher: false,
    dateOfJoining: todayIso(),
  };
  candidates.value = await hrApi.candidates().catch(() => []);
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  try {
    const f = form.value;
    const emp = await hrApi.createEmployee({
      ...f,
      name: f.userId ? undefined : f.name,
      mobile: f.userId ? undefined : (blankToNull(f.mobile) as string | null),
      designation: blankToNull(f.designation) as string | null,
      department: blankToNull(f.department) as string | null,
    });
    form.value = null;
    await toast('Staff member added');
    await router.push(`/hr/employees/${emp.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

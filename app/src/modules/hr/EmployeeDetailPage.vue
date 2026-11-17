<template>
  <AppPage :title="emp?.name ?? 'Staff'" back-href="/hr/employees" :on-refresh="load">
    <ion-segment v-model="tab" scrollable>
      <ion-segment-button value="profile">Profile</ion-segment-button>
      <ion-segment-button v-for="(cfg, k) in CHILDREN" :key="k" :value="k">{{
        cfg.title
      }}</ion-segment-button>
      <ion-segment-button value="documents">Documents</ion-segment-button>
      <ion-segment-button value="leave">Leave</ion-segment-button>
    </ion-segment>

    <form v-if="tab === 'profile' && form" @submit.prevent="saveProfile">
      <ion-list>
        <ion-item
          ><ion-note>{{ emp?.employeeCode }} · {{ emp?.status }}</ion-note></ion-item
        >
        <ion-item v-for="f in PROFILE_FIELDS" :key="f.key">
          <ion-input
            v-model="form[f.key]"
            :label="f.label"
            label-placement="stacked"
            :type="f.type ?? 'text'"
            :disabled="!canEdit"
          />
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.employmentType"
            label="Employment type"
            label-placement="stacked"
            :disabled="!canEdit"
          >
            <ion-select-option v-for="t in EMPLOYMENT_TYPES" :key="t" :value="t">{{ t }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="form.status" label="Status" label-placement="stacked" :disabled="!canEdit">
            <ion-select-option v-for="t in EMPLOYEE_STATUSES" :key="t" :value="t">{{ t }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="form.shiftId" label="Shift" label-placement="stacked" :disabled="!canEdit">
            <ion-select-option :value="null">None</ion-select-option>
            <ion-select-option v-for="s in shifts" :key="s.id" :value="s.id">{{ s.name }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item><ion-checkbox v-model="isTeacher" :disabled="!canEdit">Teacher</ion-checkbox></ion-item>
      </ion-list>
      <ion-button v-can="'hr.edit'" expand="block" type="submit" :disabled="saving">Save profile</ion-button>
      <ion-button v-can="'hr.delete'" expand="block" fill="clear" color="danger" @click="removeEmployee">
        Delete staff member
      </ion-button>
    </form>

    <template v-if="childCfg">
      <ion-list>
        <ion-item v-for="row in rows" :key="row.id">
          <ion-label>
            <h3>{{ row[childCfg.fields[0].key] }}</h3>
            <p>
              {{
                childCfg.fields
                  .slice(1)
                  .map((f) => row[f.key])
                  .filter((v) => v !== null && v !== undefined && v !== '')
                  .join(' · ')
              }}
            </p>
          </ion-label>
          <ion-button slot="end" v-can="'hr.edit'" fill="clear" color="danger" @click="removeChild(row.id)">
            <ion-icon slot="icon-only" :icon="trashOutline" />
          </ion-button>
        </ion-item>
        <ion-item v-if="!rows.length"><ion-label class="muted">Nothing recorded.</ion-label></ion-item>
      </ion-list>
      <form v-can="'hr.edit'" @submit.prevent="addChild">
        <ion-list>
          <ion-list-header>Add {{ childCfg.title.toLowerCase() }}</ion-list-header>
          <ion-item v-for="f in childCfg.fields" :key="f.key">
            <ion-input
              v-model="childForm[f.key]"
              :label="f.label"
              label-placement="stacked"
              :type="f.type ?? 'text'"
              :required="f.required"
            />
          </ion-item>
        </ion-list>
        <ion-button expand="block" type="submit">Add</ion-button>
      </form>
    </template>

    <template v-if="tab === 'documents'">
      <ion-list>
        <ion-item v-for="d in documents" :key="d.id">
          <ion-label>
            <h3>{{ d.title || d.file?.originalName }}</h3>
            <p>{{ d.docType }} · {{ d.createdAt.slice(0, 10) }}</p>
          </ion-label>
          <ion-button v-if="d.file" slot="end" fill="clear" :href="d.file.url" target="_blank"
            >Open</ion-button
          >
          <ion-button slot="end" v-can="'hr.edit'" fill="clear" color="danger" @click="removeDocument(d.id)">
            <ion-icon slot="icon-only" :icon="trashOutline" />
          </ion-button>
        </ion-item>
        <ion-item v-if="!documents.length"><ion-label class="muted">No documents.</ion-label></ion-item>
      </ion-list>
      <div v-can="'hr.edit'">
        <ion-item>
          <ion-select v-model="docType" label="Document type" label-placement="stacked">
            <ion-select-option v-for="t in DOC_TYPES" :key="t" :value="t">{{ t }}</ion-select-option>
          </ion-select>
        </ion-item>
        <input type="file" @change="upload" />
      </div>
    </template>

    <ion-list v-if="tab === 'leave'">
      <ion-item v-for="b in balances" :key="b.leaveTypeId">
        <ion-label>
          <h3>{{ b.name }}</h3>
          <p>Used {{ b.used }} · pending {{ b.pending }}</p>
        </ion-label>
        <ion-note slot="end">{{ b.available === null ? 'Unlimited' : `${b.available} left` }}</ion-note>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonButton,
  IonCheckbox,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  alertController,
} from '@ionic/vue';
import { trashOutline } from 'ionicons/icons';
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, type EmployeeDto, type LeaveBalanceDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { blankToNull, hrApi, type ChildKind, type EmployeeDocument, type Row, type Shift } from './api';

interface Field {
  key: string;
  label: string;
  type?: 'text' | 'date' | 'number' | 'email' | 'tel';
  required?: boolean;
}
const PROFILE_FIELDS: Field[] = [
  { key: 'name', label: 'Name' },
  { key: 'mobile', label: 'Mobile', type: 'tel' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'designation', label: 'Designation' },
  { key: 'department', label: 'Department' },
  { key: 'dateOfJoining', label: 'Date of joining', type: 'date' },
  { key: 'dateOfBirth', label: 'Date of birth', type: 'date' },
  { key: 'pan', label: 'PAN' },
  { key: 'uan', label: 'UAN (PF)' },
  { key: 'esiNumber', label: 'ESI number' },
  { key: 'bankAccountName', label: 'Bank account name' },
  { key: 'bankAccountNumber', label: 'Bank account number' },
  { key: 'bankIfsc', label: 'IFSC' },
  { key: 'biometricEnrolmentId', label: 'Biometric enrolment ID' },
  { key: 'address', label: 'Address' },
];
const CHILDREN: Record<ChildKind, { title: string; fields: Field[] }> = {
  qualifications: {
    title: 'Qualifications',
    fields: [
      { key: 'degree', label: 'Degree', required: true },
      { key: 'institution', label: 'Institution' },
      { key: 'yearOfPassing', label: 'Year of passing', type: 'number' },
      { key: 'grade', label: 'Grade' },
    ],
  },
  experiences: {
    title: 'Experience',
    fields: [
      { key: 'organisation', label: 'Organisation', required: true },
      { key: 'role', label: 'Role' },
      { key: 'fromDate', label: 'From', type: 'date' },
      { key: 'toDate', label: 'To', type: 'date' },
    ],
  },
  assignments: {
    title: 'Assignments',
    fields: [
      { key: 'role', label: 'Role (e.g. Physics faculty)', required: true },
      { key: 'branchId', label: 'Branch ID', type: 'number', required: true },
      { key: 'fromDate', label: 'From', type: 'date' },
      { key: 'toDate', label: 'To', type: 'date' },
    ],
  },
  contracts: {
    title: 'Contracts',
    fields: [
      { key: 'contractType', label: 'Contract type', required: true },
      { key: 'startDate', label: 'Start', type: 'date', required: true },
      { key: 'endDate', label: 'End', type: 'date' },
      { key: 'noticePeriodDays', label: 'Notice period (days)', type: 'number' },
      { key: 'probationMonths', label: 'Probation (months)', type: 'number' },
      { key: 'status', label: 'Status (draft/active/expired/terminated)' },
    ],
  },
};
const DOC_TYPES = ['id_proof', 'address_proof', 'qualification', 'offer_letter', 'contract', 'other'];

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id));
const canEdit = computed(() => auth.can('hr.edit'));
const tab = ref<string>('profile');
const emp = ref<EmployeeDto | null>(null);
type Value = string | number | null | undefined;
const form = ref<Record<string, Value> | null>(null);
const isTeacher = ref(false);
const shifts = ref<Shift[]>([]);
const rows = ref<Row[]>([]);
const childForm = ref<Record<string, Value>>({});
const documents = ref<EmployeeDocument[]>([]);
const balances = ref<LeaveBalanceDto[]>([]);
const docType = ref('other');
const saving = ref(false);
const childCfg = computed(() => CHILDREN[tab.value as ChildKind] ?? null);

async function load() {
  try {
    emp.value = await hrApi.employee(id.value);
    form.value = { ...emp.value } as unknown as Record<string, Value>;
    isTeacher.value = emp.value.isTeacher;
    shifts.value = await hrApi.shifts();
    await loadTab();
  } catch (e) {
    await toastError(e);
  }
}

async function loadTab() {
  childForm.value = {};
  if (childCfg.value) rows.value = await hrApi.children(id.value, tab.value as ChildKind);
  if (tab.value === 'documents') documents.value = await hrApi.documents(id.value);
  if (tab.value === 'leave') balances.value = await hrApi.balances(id.value);
}

async function saveProfile() {
  if (!form.value) return;
  saving.value = true;
  try {
    const body: Record<string, unknown> = {};
    for (const f of PROFILE_FIELDS) body[f.key] = blankToNull(form.value[f.key]);
    for (const k of ['name', 'dateOfJoining']) body[k] = body[k] ?? undefined;
    for (const k of ['employmentType', 'status', 'shiftId']) body[k] = form.value[k];
    body.isTeacher = isTeacher.value;
    emp.value = await hrApi.updateEmployee(id.value, body as Partial<EmployeeDto>);
    await toast('Profile saved');
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function addChild() {
  if (!childCfg.value) return;
  const body: Record<string, unknown> = {};
  for (const f of childCfg.value.fields) {
    const v = blankToNull(childForm.value[f.key]);
    if (v !== null) body[f.key] = f.type === 'number' ? Number(v) : v;
  }
  try {
    await hrApi.addChild(id.value, tab.value as ChildKind, body);
    await loadTab();
  } catch (e) {
    await toastError(e);
  }
}

async function removeChild(childId: number) {
  await hrApi
    .removeChild(id.value, tab.value as ChildKind, childId)
    .then(loadTab)
    .catch(toastError);
}

async function upload(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    await hrApi.uploadDocument(id.value, file, docType.value);
    input.value = '';
    await toast('Document uploaded');
    await loadTab();
  } catch (e) {
    await toastError(e);
  }
}

async function removeDocument(docId: number) {
  await hrApi.removeDocument(id.value, docId).then(loadTab).catch(toastError);
}

async function removeEmployee() {
  const alert = await alertController.create({
    header: `Delete ${emp.value?.name}?`,
    message: 'Prefer marking the employee as exited; deleting removes their HR history.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () =>
          hrApi
            .removeEmployee(id.value)
            .then(() => router.replace('/hr/employees'))
            .catch(toastError),
      },
    ],
  });
  await alert.present();
}

onMounted(load);
watch(tab, () => loadTab().catch(toastError));
</script>

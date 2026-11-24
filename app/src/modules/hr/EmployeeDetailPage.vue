<template>
  <AppPage :title="emp?.name ?? t('hr.employees.title')" back-href="/hr/employees" :on-refresh="load">
    <ion-segment v-model="tab" scrollable>
      <ion-segment-button value="profile">{{ t('hr.detail.profile') }}</ion-segment-button>
      <ion-segment-button v-for="(cfg, k) in CHILDREN" :key="k" :value="k">{{
        t(cfg.title)
      }}</ion-segment-button>
      <ion-segment-button value="documents">{{ t('hr.detail.documents') }}</ion-segment-button>
      <ion-segment-button value="leave">{{ t('hr.detail.leave') }}</ion-segment-button>
    </ion-segment>

    <form v-if="tab === 'profile' && form" @submit.prevent="saveProfile">
      <ion-list>
        <ion-item
          ><ion-note>{{ emp?.employeeCode }}</ion-note
          ><StatusChip
            v-if="emp"
            slot="end"
            :label="t(EMPLOYEE_STATUS[emp.status].label)"
            :tone="EMPLOYEE_STATUS[emp.status].tone"
        /></ion-item>
        <ion-item v-for="f in PROFILE_FIELDS" :key="f.key">
          <ion-input
            v-model="form[f.key]"
            :label="t(f.label)"
            label-placement="stacked"
            :type="f.type ?? 'text'"
            :disabled="!canEdit"
          />
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.employmentType"
            :label="t('hr.fields.employmentType')"
            label-placement="stacked"
            :disabled="!canEdit"
          >
            <ion-select-option v-for="et in EMPLOYMENT_TYPES" :key="et" :value="et">{{
              t(`hr.employmentType.${et}`)
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.status"
            :label="t('common.labels.status')"
            label-placement="stacked"
            :disabled="!canEdit"
          >
            <ion-select-option v-for="es in EMPLOYEE_STATUSES" :key="es" :value="es">{{
              t(EMPLOYEE_STATUS[es].label)
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.shiftId"
            :label="t('hr.fields.shift')"
            label-placement="stacked"
            :disabled="!canEdit"
          >
            <ion-select-option :value="null">{{ t('common.labels.none') }}</ion-select-option>
            <ion-select-option v-for="s in shifts" :key="s.id" :value="s.id">{{ s.name }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item
          ><ion-checkbox v-model="isTeacher" :disabled="!canEdit">{{
            t('hr.teacher')
          }}</ion-checkbox></ion-item
        >
      </ion-list>
      <ion-button v-can="'hr.edit'" expand="block" type="submit" :disabled="saving">{{
        t('hr.detail.saveProfile')
      }}</ion-button>
      <ion-button v-can="'hr.delete'" expand="block" fill="clear" color="danger" @click="removeEmployee">
        {{ t('hr.detail.deleteEmployee') }}
      </ion-button>
    </form>

    <template v-if="childCfg">
      <ion-list>
        <ion-item v-for="row in rows" :key="row.id">
          <ion-label>
            <h3>{{ cell(row, childCfg.fields[0]) }}</h3>
            <p>
              {{
                childCfg.fields
                  .slice(1)
                  .map((f) => cell(row, f))
                  .filter((v) => v !== '')
                  .join(' · ')
              }}
            </p>
          </ion-label>
          <ion-button
            slot="end"
            v-can="'hr.edit'"
            fill="clear"
            color="danger"
            :aria-label="t('hr.detail.deleteRow', { section: t(childCfg.title) })"
            @click="removeChild(row.id)"
          >
            <ion-icon slot="icon-only" :icon="trashOutline" />
          </ion-button>
        </ion-item>
        <ion-item v-if="!rows.length"
          ><ion-label class="muted">{{ t('hr.detail.nothing') }}</ion-label></ion-item
        >
      </ion-list>
      <form v-can="'hr.edit'" @submit.prevent="addChild">
        <ion-list>
          <ion-list-header>{{ t('hr.detail.addTitle', { section: t(childCfg.title) }) }}</ion-list-header>
          <ion-item v-for="f in childCfg.fields" :key="f.key">
            <ion-input
              v-model="childForm[f.key]"
              :label="t(f.label)"
              label-placement="stacked"
              :type="f.type ?? 'text'"
              :required="f.required"
            />
          </ion-item>
        </ion-list>
        <ion-button expand="block" type="submit">{{ t('common.actions.add') }}</ion-button>
      </form>
    </template>

    <template v-if="tab === 'documents'">
      <ion-list>
        <ion-item v-for="d in documents" :key="d.id">
          <ion-label>
            <h3>{{ d.title || d.file?.originalName }}</h3>
            <p>{{ docTypeLabel(d.docType) }} · {{ formatDate(d.createdAt) }}</p>
          </ion-label>
          <ion-button v-if="d.file" slot="end" fill="clear" :href="d.file.url" target="_blank">{{
            t('common.actions.open')
          }}</ion-button>
          <ion-button
            slot="end"
            v-can="'hr.edit'"
            fill="clear"
            color="danger"
            :aria-label="t('hr.detail.deleteDocument')"
            @click="removeDocument(d.id)"
          >
            <ion-icon slot="icon-only" :icon="trashOutline" />
          </ion-button>
        </ion-item>
        <ion-item v-if="!documents.length"
          ><ion-label class="muted">{{ t('hr.detail.noDocuments') }}</ion-label></ion-item
        >
      </ion-list>
      <div v-can="'hr.edit'">
        <ion-item>
          <ion-select v-model="docType" :label="t('hr.detail.documentType')" label-placement="stacked">
            <ion-select-option v-for="dt in DOC_TYPES" :key="dt" :value="dt">{{
              t(`hr.docType.${dt}`)
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <input type="file" @change="upload" />
      </div>
    </template>

    <ion-list v-if="tab === 'leave'">
      <ion-item v-for="b in balances" :key="b.leaveTypeId">
        <ion-label>
          <h3>{{ b.name }}</h3>
          <p>
            {{ t('hr.detail.usedPending', { used: formatNumber(b.used), pending: formatNumber(b.pending) }) }}
          </p>
        </ion-label>
        <ion-note slot="end">{{
          b.available === null
            ? t('hr.detail.unlimited')
            : t('hr.detail.left', { n: formatNumber(b.available) })
        }}</ion-note>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
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
import StatusChip from '@/components/StatusChip.vue';
import { formatDate, formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import {
  EMPLOYEE_STATUS,
  blankToNull,
  hrApi,
  type ChildKind,
  type EmployeeDocument,
  type Row,
  type Shift,
} from './api';

interface Field {
  key: string;
  /** i18n key */
  label: string;
  type?: 'text' | 'date' | 'number' | 'email' | 'tel';
  required?: boolean;
}
const PROFILE_FIELDS: Field[] = [
  { key: 'name', label: 'hr.fields.name' },
  { key: 'mobile', label: 'hr.fields.mobile', type: 'tel' },
  { key: 'email', label: 'hr.fields.email', type: 'email' },
  { key: 'designation', label: 'hr.fields.designation' },
  { key: 'department', label: 'hr.fields.department' },
  { key: 'dateOfJoining', label: 'hr.fields.dateOfJoining', type: 'date' },
  { key: 'dateOfBirth', label: 'hr.fields.dateOfBirth', type: 'date' },
  { key: 'pan', label: 'hr.fields.pan' },
  { key: 'uan', label: 'hr.fields.uan' },
  { key: 'esiNumber', label: 'hr.fields.esiNumber' },
  { key: 'bankAccountName', label: 'hr.fields.bankAccountName' },
  { key: 'bankAccountNumber', label: 'hr.fields.bankAccountNumber' },
  { key: 'bankIfsc', label: 'hr.fields.bankIfsc' },
  { key: 'biometricEnrolmentId', label: 'hr.fields.biometricEnrolmentId' },
  { key: 'address', label: 'hr.fields.address' },
];
const CHILDREN: Record<ChildKind, { title: string; fields: Field[] }> = {
  qualifications: {
    title: 'hr.detail.qualifications',
    fields: [
      { key: 'degree', label: 'hr.fields.degree', required: true },
      { key: 'institution', label: 'hr.fields.institution' },
      { key: 'yearOfPassing', label: 'hr.fields.yearOfPassing', type: 'number' },
      { key: 'grade', label: 'hr.fields.grade' },
    ],
  },
  experiences: {
    title: 'hr.detail.experiences',
    fields: [
      { key: 'organisation', label: 'hr.fields.organisation', required: true },
      { key: 'role', label: 'hr.fields.role' },
      { key: 'fromDate', label: 'common.labels.from', type: 'date' },
      { key: 'toDate', label: 'common.labels.to', type: 'date' },
    ],
  },
  assignments: {
    title: 'hr.detail.assignments',
    fields: [
      { key: 'role', label: 'hr.fields.assignmentRole', required: true },
      { key: 'branchId', label: 'hr.fields.branchId', type: 'number', required: true },
      { key: 'fromDate', label: 'common.labels.from', type: 'date' },
      { key: 'toDate', label: 'common.labels.to', type: 'date' },
    ],
  },
  contracts: {
    title: 'hr.detail.contracts',
    fields: [
      { key: 'contractType', label: 'hr.fields.contractType', required: true },
      { key: 'startDate', label: 'hr.fields.start', type: 'date', required: true },
      { key: 'endDate', label: 'hr.fields.end', type: 'date' },
      { key: 'noticePeriodDays', label: 'hr.fields.noticePeriodDays', type: 'number' },
      { key: 'probationMonths', label: 'hr.fields.probationMonths', type: 'number' },
      { key: 'status', label: 'hr.fields.contractStatus' },
    ],
  },
};
const DOC_TYPES = ['id_proof', 'address_proof', 'qualification', 'offer_letter', 'contract', 'other'];

const { t, te } = useI18n();
const docTypeLabel = (d: string) => (te(`hr.docType.${d}`) ? t(`hr.docType.${d}`) : d);
const cell = (row: Row, f: Field) => {
  const v = row[f.key];
  if (v === null || v === undefined || v === '') return '';
  return f.type === 'date' ? formatDate(String(v)) : String(v);
};

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
    await toast(t('hr.detail.profileSaved'));
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
    await toast(t('hr.detail.uploaded'));
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
    header: t('hr.detail.deleteTitle', { name: emp.value?.name ?? '' }),
    message: t('hr.detail.deleteMessage'),
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      {
        text: t('common.actions.delete'),
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

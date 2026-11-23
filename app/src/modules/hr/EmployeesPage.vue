<template>
  <AppPage :title="t('hr.employees.title')" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'hr.create'" :aria-label="t('hr.employees.new')" @click="openEditor"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar
      v-model="search"
      :debounce="300"
      :placeholder="t('hr.employees.searchPlaceholder')"
      @ion-input="load"
    />
    <ion-segment v-model="status" @ion-change="load">
      <ion-segment-button value="active">{{ t('common.status.active') }}</ion-segment-button>
      <ion-segment-button value="on_notice">{{ t('hr.status.onNotice') }}</ion-segment-button>
      <ion-segment-button value="exited">{{ t('hr.status.exited') }}</ion-segment-button>
      <ion-segment-button value="">{{ t('common.labels.all') }}</ion-segment-button>
    </ion-segment>
    <ion-list>
      <ion-item v-for="e in employees" :key="e.id" :router-link="`/hr/employees/${e.id}`" button>
        <ion-label>
          <h2>
            {{ e.name }}
            <StatusChip v-if="e.isTeacher" :label="t('hr.teacher')" tone="primary" />
          </h2>
          <p>{{ [e.employeeCode, e.designation, e.department].filter(Boolean).join(' · ') }}</p>
        </ion-label>
        <StatusChip
          slot="end"
          :label="t(EMPLOYEE_STATUS[e.status].label)"
          :tone="EMPLOYEE_STATUS[e.status].tone"
        />
      </ion-item>
      <ion-item v-if="!loading && !employees.length"
        ><ion-label class="muted">{{ t('hr.employees.empty') }}</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ t('hr.employees.new') }}</ion-title>
          <ion-buttons slot="end"
            ><ion-button @click="form = null">{{ t('common.actions.close') }}</ion-button></ion-buttons
          >
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item>
              <ion-select
                v-model="form.userId"
                :label="t('hr.employees.linkedUser')"
                label-placement="stacked"
              >
                <ion-select-option :value="null">{{ t('hr.employees.noLogin') }}</ion-select-option>
                <ion-select-option v-for="c in candidates" :key="c.id" :value="c.id">
                  {{ c.name }} ({{ c.roles.join(', ') }})
                </ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="!form.userId">
              <ion-input
                v-model="form.name"
                :label="t('hr.fields.name')"
                label-placement="stacked"
                required
              />
            </ion-item>
            <ion-item v-if="!form.userId">
              <ion-input
                v-model="form.mobile"
                :label="t('hr.fields.mobile')"
                label-placement="stacked"
                type="tel"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.designation"
                :label="t('hr.fields.designation')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.department"
                :label="t('hr.fields.department')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.employmentType"
                :label="t('hr.fields.employmentType')"
                label-placement="stacked"
              >
                <ion-select-option v-for="et in EMPLOYMENT_TYPES" :key="et" :value="et">{{
                  t(`hr.employmentType.${et}`)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-checkbox v-model="form.isTeacher">{{ t('hr.teacher') }}</ion-checkbox></ion-item
            >
            <ion-item>
              <ion-input
                v-model="form.dateOfJoining"
                :label="t('hr.fields.dateOfJoining')"
                label-placement="stacked"
                type="date"
                required
              />
            </ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">{{
            t('common.actions.save')
          }}</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { toast, toastError } from '@/core/toast';
import { EMPLOYEE_STATUS, blankToNull, hrApi, todayIso, type Candidate } from './api';

const { t } = useI18n();

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
    await toast(t('hr.employees.added'));
    await router.push(`/hr/employees/${emp.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

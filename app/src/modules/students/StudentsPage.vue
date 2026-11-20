<template>
  <AppPage title="Students" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'students.configure'" router-link="/students/settings" aria-label="Student settings"
        ><ion-icon slot="icon-only" :icon="settingsOutline"
      /></ion-button>
      <ion-button v-can="'students.create'" aria-label="New student" @click="openCreate"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar
      v-model="search"
      :debounce="300"
      placeholder="Name, mobile, admission or roll no."
      @ion-input="reload"
    />
    <ion-segment v-model="status" scrollable @ion-change="reload">
      <ion-segment-button value="all"><ion-label>All</ion-label></ion-segment-button>
      <ion-segment-button v-for="s in STUDENT_STATUSES" :key="s" :value="s"
        ><ion-label>{{ humanize(s) }}</ion-label></ion-segment-button
      >
    </ion-segment>

    <ion-list>
      <ion-item v-for="s in students" :key="s.id" button :router-link="`/students/${s.id}`" detail>
        <ion-label>
          <h2>
            {{ s.name }} <ion-badge :color="STATUS_COLORS[s.status]">{{ s.status }}</ion-badge>
          </h2>
          <p>
            {{ s.admissionNumber }}<span v-if="s.rollNumber"> · Roll {{ s.rollNumber }}</span> ·
            {{ s.mobile }}
            <span v-if="branchName(s.branchId)"> · {{ branchName(s.branchId) }}</span>
          </p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!loading && !students.length"
        ><ion-label class="muted">No students found.</ion-label></ion-item
      >
    </ion-list>
    <ion-infinite-scroll :disabled="students.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>New student</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save()">
          <ion-list>
            <ion-item
              ><ion-input v-model="form.name" label="Full name *" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.mobile"
                label="Mobile *"
                label-placement="stacked"
                type="tel"
                required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.email" label="Email" label-placement="stacked" type="email"
            /></ion-item>
            <ion-item v-if="branches.length > 1">
              <ion-select
                v-model="form.branchId"
                label="Branch"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input
                v-model="form.dateOfBirth"
                label="Date of birth"
                label-placement="stacked"
                type="date"
            /></ion-item>
            <ion-item>
              <ion-select v-model="form.gender" label="Gender" label-placement="stacked" interface="popover">
                <ion-select-option value="male">Male</ion-select-option>
                <ion-select-option value="female">Female</ion-select-option>
                <ion-select-option value="other">Other</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input v-model="form.idNumber" label="ID number (e.g. Aadhaar)" label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.schoolName" label="School / college" label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.classGrade" label="Class / grade" label-placement="stacked"
            /></ion-item>
          </ion-list>
          <ion-card v-if="duplicates.length" color="warning">
            <ion-card-content>
              <strong>Possible duplicates</strong>
              <p v-for="d in duplicates" :key="`${d.kind}-${d.id}`">
                {{ humanize(d.kind) }}: {{ d.name }} ({{ d.reference ?? d.mobile }}) – matched on
                {{ d.matchedOn.join(', ') }}
              </p>
              <p>
                Siblings may share a mobile; saving anyway gives the student a login of their own on that
                mobile.
              </p>
              <ion-button size="small" @click="save(true)">Save anyway</ion-button>
            </ion-card-content>
          </ion-card>
          <ion-button expand="block" type="submit" :disabled="saving">Admit student</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
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
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add, settingsOutline } from 'ionicons/icons';
import { STUDENT_STATUSES, type DuplicateMatch, type StudentDto, type StudentStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { ApiError } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { branchesApi, type Branch } from '@/modules/branches/api';
import { STATUS_COLORS, humanize, studentsApi } from './api';

const route = useRoute();
const router = useRouter();
const students = ref<StudentDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);
const search = ref('');
const status = ref<'all' | StudentStatus>('all');
const branches = ref<Branch[]>([]);
const saving = ref(false);
const duplicates = ref<DuplicateMatch[]>([]);

interface CreateForm {
  name: string;
  mobile: string;
  email: string;
  branchId: number | undefined;
  dateOfBirth: string;
  gender: 'male' | 'female' | 'other' | null;
  idNumber: string;
  schoolName: string;
  classGrade: string;
}
const form = ref<CreateForm | null>(null);

const branchName = (id: number) => branches.value.find((b) => b.id === id)?.name;

async function fetchPage() {
  const res = await studentsApi.list({
    page: page.value,
    search: search.value || undefined,
    status: status.value === 'all' ? undefined : status.value,
  });
  total.value = res.total;
  return res.items;
}

async function load() {
  loading.value = true;
  page.value = 1;
  try {
    students.value = await fetchPage();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}
const reload = () => load();

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  try {
    students.value.push(...(await fetchPage()));
  } catch (e) {
    await toastError(e);
  } finally {
    await ev.target.complete();
  }
}

function openCreate() {
  duplicates.value = [];
  form.value = {
    name: '',
    mobile: '',
    email: '',
    branchId: undefined,
    dateOfBirth: '',
    gender: null,
    idNumber: '',
    schoolName: '',
    classGrade: '',
  };
}

const orNull = (v: string) => (v.trim() ? v.trim() : null);

async function save(allowDuplicate = false) {
  if (!form.value) return;
  const f = form.value;
  saving.value = true;
  try {
    const s = await studentsApi.create({
      name: f.name.trim(),
      mobile: f.mobile.trim(),
      email: orNull(f.email),
      branchId: f.branchId,
      dateOfBirth: orNull(f.dateOfBirth),
      gender: f.gender,
      idNumber: orNull(f.idNumber),
      academicInfo:
        f.schoolName || f.classGrade
          ? { schoolName: orNull(f.schoolName), classGrade: orNull(f.classGrade) }
          : null,
      allowDuplicate,
    });
    form.value = null;
    await toast(`Admitted ${s.name} (${s.admissionNumber})`);
    await router.push(`/students/${s.id}`);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DUPLICATE_STUDENT')
      duplicates.value = (e.details as { matches: DuplicateMatch[] }).matches;
    else await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await load();
  branches.value = await branchesApi.list().catch(() => []);
});
watch(() => route.query.b, load);
</script>

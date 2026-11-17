<template>
  <AppPage title="Applications" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'admissions.create'" @click="openCreate"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar v-model="search" :debounce="300" placeholder="Name, mobile or email" @ion-input="load" />
    <ion-segment v-model="status" scrollable @ion-change="load">
      <ion-segment-button value="all"><ion-label>All</ion-label></ion-segment-button>
      <ion-segment-button v-for="s in APPLICATION_STATUSES" :key="s" :value="s">
        <ion-label>{{ s === 'waitlisted' ? 'Waiting list' : humanize(s) }}</ion-label>
      </ion-segment-button>
    </ion-segment>

    <ion-list>
      <ion-item v-for="a in applications" :key="a.id">
        <ion-label class="ion-text-wrap">
          <h2>
            <span v-if="a.waitlistPosition">#{{ a.waitlistPosition }} · </span>{{ a.name }}
            <ion-badge :color="APPLICATION_COLORS[a.status]">{{ humanize(a.status) }}</ion-badge>
          </h2>
          <p>
            {{ a.mobile }}<span v-if="a.email"> · {{ a.email }}</span> · applied {{ fmtDate(a.createdAt) }}
            <span v-if="a.courseId"> · course #{{ a.courseId }}</span
            ><span v-if="a.batchId"> · batch #{{ a.batchId }}</span>
          </p>
          <p v-if="a.remarks" class="muted">{{ a.remarks }}</p>
          <p v-if="a.studentId"><router-link :to="`/students/${a.studentId}`">View student →</router-link></p>
        </ion-label>
        <ion-button v-if="isOpen(a)" slot="end" fill="clear" @click="actions(a)"
          ><ion-icon slot="icon-only" :icon="ellipsisVertical"
        /></ion-button>
      </ion-item>
      <ion-item v-if="!loading && !applications.length"
        ><ion-label class="muted">No applications.</ion-label></ion-item
      >
    </ion-list>
    <ion-infinite-scroll :disabled="applications.length >= total" @ion-infinite="more"
      ><ion-infinite-scroll-content
    /></ion-infinite-scroll>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>New application</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="form = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="create">
          <ion-list>
            <ion-item
              ><ion-input v-model="form.name" label="Name *" label-placement="stacked" required
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
            <ion-item v-if="batchOptions.length">
              <ion-select
                v-model="form.batchId"
                label="Batch (enrolled on admission)"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option :value="null">No batch</ion-select-option>
                <ion-select-option v-for="b in batchOptions" :key="b.id" :value="b.id"
                  >{{ b.name }} ({{ b.code }})</ion-select-option
                >
              </ion-select>
            </ion-item>
            <CustomFieldsInput v-if="customForm" v-model="form.formData" :fields="customForm.fields" />
            <ion-item><ion-checkbox v-model="form.waitlist">Add to waiting list</ion-checkbox></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="busy">Submit application</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCheckbox,
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
  actionSheetController,
  alertController,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add, ellipsisVertical } from 'ionicons/icons';
import {
  APPLICATION_STATUSES,
  type AdmissionFormDto,
  type ApplicationDto,
  type ApplicationStatus,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { ApiError } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { branchesApi, type Branch } from '@/modules/branches/api';
import CustomFieldsInput from '@/modules/students/CustomFieldsInput.vue';
import { fmtDate, humanize } from '@/modules/students/api';
import type { BatchDto } from '@erp/shared';
import { academicsApi } from '@/modules/academics/api';
import { APPLICATION_COLORS, admissionsApi } from './api';

const auth = useAuthStore();
const router = useRouter();
const applications = ref<ApplicationDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);
const busy = ref(false);
const search = ref('');
const status = ref<'all' | ApplicationStatus>('all');
const branches = ref<Branch[]>([]);
const customForm = ref<AdmissionFormDto | null>(null);

const isOpen = (a: ApplicationDto) => ['pending', 'waitlisted', 'approved'].includes(a.status);

async function fetchPage() {
  const res = await admissionsApi.applications({
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
    applications.value = await fetchPage();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  try {
    applications.value.push(...(await fetchPage()));
  } catch (e) {
    await toastError(e);
  } finally {
    await ev.target.complete();
  }
}

async function prompt(
  header: string,
  input: { name: string; type: 'text' | 'number'; placeholder: string; value?: string },
) {
  const a = await alertController.create({
    header,
    inputs: [input],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'OK', role: 'confirm' },
    ],
  });
  await a.present();
  const r = await a.onDidDismiss<{ values: Record<string, string> }>();
  return r.role === 'confirm' ? (r.data?.values[input.name] ?? '') : null;
}

async function act(fn: () => Promise<unknown>, done: string) {
  busy.value = true;
  try {
    await fn();
    await toast(done);
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function admit(a: ApplicationDto, allowDuplicate = false): Promise<void> {
  try {
    const { student } = await admissionsApi.admit(a.id, { allowDuplicate });
    await toast(`Admitted ${student.name} (${student.admissionNumber})`);
    await router.push(`/students/${student.id}`);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DUPLICATE_STUDENT') {
      const matches = (e.details as { matches: { name: string; reference: string | null }[] }).matches;
      const alert = await alertController.create({
        header: 'Possible duplicate',
        message: matches.map((m) => `${m.name} (${m.reference ?? ''})`).join(', '),
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          { text: 'Admit anyway', role: 'confirm' },
        ],
      });
      await alert.present();
      if ((await alert.onDidDismiss()).role === 'confirm') return admit(a, true);
    } else await toastError(e);
  }
}

async function actions(a: ApplicationDto) {
  const canApprove = auth.can('admissions.approve');
  const buttons: { text: string; role?: string; handler?: () => void }[] = [];
  if (canApprove) {
    if (a.status !== 'approved')
      buttons.push({ text: 'Approve', handler: () => act(() => admissionsApi.approve(a.id), 'Approved') });
    buttons.push({ text: 'Admit as student', handler: () => void admit(a) });
    if (a.status === 'pending')
      buttons.push({
        text: 'Move to waiting list',
        handler: () => act(() => admissionsApi.waitlist(a.id), 'Waitlisted'),
      });
    if (a.status === 'waitlisted')
      buttons.push({
        text: 'Change position',
        handler: async () => {
          const v = await prompt('Waiting list position', {
            name: 'position',
            type: 'number',
            placeholder: '1',
            value: String(a.waitlistPosition ?? 1),
          });
          if (v && Number(v) > 0) await act(() => admissionsApi.move(a.id, Number(v)), 'Moved');
        },
      });
    buttons.push({
      text: 'Reject',
      role: 'destructive',
      handler: async () => {
        const v = await prompt('Reject application', {
          name: 'remarks',
          type: 'text',
          placeholder: 'Reason (optional)',
        });
        if (v !== null) await act(() => admissionsApi.reject(a.id, v || undefined), 'Rejected');
      },
    });
  }
  if (auth.can('admissions.edit'))
    buttons.push({
      text: 'Withdraw',
      role: 'destructive',
      handler: () => act(() => admissionsApi.withdraw(a.id), 'Withdrawn'),
    });
  buttons.push({ text: 'Cancel', role: 'cancel' });
  const sheet = await actionSheetController.create({ header: a.name, buttons });
  await sheet.present();
}

// ---- create
interface CreateForm {
  name: string;
  mobile: string;
  email: string;
  branchId: number | undefined;
  batchId: number | null;
  waitlist: boolean;
  formData: Record<string, unknown>;
}
const form = ref<CreateForm | null>(null);
const batches = ref<BatchDto[]>([]);
// Admission enrols the student in the chosen batch through academics, so offer only open batches
// of the selected (or only) branch.
const batchOptions = computed(() => {
  const branchId = form.value?.branchId ?? (branches.value.length === 1 ? branches.value[0].id : undefined);
  return batches.value.filter(
    (b) => (b.status === 'planned' || b.status === 'active') && (!branchId || b.branchId === branchId),
  );
});
async function openCreate() {
  form.value = {
    name: '',
    mobile: '',
    email: '',
    branchId: undefined,
    batchId: null,
    waitlist: false,
    formData: {},
  };
  customForm.value = await admissionsApi.activeForm('admission').catch(() => null);
  if (auth.can('academics.view'))
    batches.value = await academicsApi
      .batches()
      .then((p) => p.items)
      .catch(() => []);
}
async function create() {
  const f = form.value!;
  busy.value = true;
  try {
    await admissionsApi.createApplication({
      name: f.name.trim(),
      mobile: f.mobile.trim(),
      email: f.email.trim() || null,
      branchId: f.branchId,
      batchId: f.batchId,
      formId: customForm.value?.id ?? null,
      formData: customForm.value ? f.formData : null,
      waitlist: f.waitlist,
    });
    form.value = null;
    await toast(f.waitlist ? 'Added to waiting list' : 'Application submitted');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await load();
  branches.value = await branchesApi.list().catch(() => []);
});
</script>

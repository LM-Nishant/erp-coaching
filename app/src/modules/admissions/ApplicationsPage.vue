<template>
  <AppPage title="Applications" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'admissions.create'" aria-label="New application" @click="openCreate"
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
            <span v-if="a.courseId"> · {{ a.courseName ?? `course #${a.courseId}` }}</span
            ><span v-if="a.batchId"> · {{ a.batchName ?? `batch #${a.batchId}` }}</span>
          </p>
          <p v-if="a.remarks" class="muted">{{ a.remarks }}</p>
          <p v-if="a.studentId"><router-link :to="`/students/${a.studentId}`">View student →</router-link></p>
        </ion-label>
        <ion-button
          v-if="isOpen(a)"
          slot="end"
          fill="clear"
          :aria-label="`Actions for ${a.name}`"
          @click="actions(a)"
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
          ><ion-title>{{ form?.id ? 'Edit application' : 'New application' }}</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="form = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <div v-if="form.linked" class="notice medium">
            <ion-icon :icon="informationCircleOutline" />
            <span
              >The student registered themselves, so their name, mobile, email and branch come from their
              profile. Change those on the student's profile.</span
            >
          </div>
          <ion-list>
            <ion-item
              ><ion-input
                v-model="form.name"
                label="Name *"
                label-placement="stacked"
                required
                :disabled="form.linked"
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.mobile"
                label="Mobile *"
                label-placement="stacked"
                type="tel"
                required
                :disabled="form.linked"
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.email"
                label="Email"
                label-placement="stacked"
                type="email"
                :disabled="form.linked"
            /></ion-item>
            <ion-item v-if="branches.length > 1">
              <ion-select
                v-model="form.branchId"
                label="Branch"
                label-placement="stacked"
                interface="popover"
                :disabled="form.linked"
              >
                <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="courseOptions.length">
              <ion-select
                v-model="form.courseId"
                label="Course"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option :value="null">No course</ion-select-option>
                <ion-select-option v-for="c in courseOptions" :key="c.id" :value="c.id"
                  >{{ c.name }} ({{ c.code }})</ion-select-option
                >
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
            <ion-item v-if="!form.id"
              ><ion-checkbox v-model="form.waitlist">Add to waiting list</ion-checkbox></ion-item
            >
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="busy">{{
            form.id ? 'Save changes' : 'Submit application'
          }}</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!admitting" @did-dismiss="admitting = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ admitting?.studentId ? 'Confirm admission' : 'Admit as student' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="admitting = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="admitting" class="ion-padding">
        <p>
          <strong>{{ admitting.name }}</strong><span v-if="admitting.courseId">
            · {{ admitting.courseName ?? `course #${admitting.courseId}` }}</span
          >
        </p>
        <div v-if="!admitting.courseId" class="notice medium">
          <ion-icon :icon="informationCircleOutline" />
          <span
            >The application has no course, so there is no batch to choose. To pick one now, edit the
            application and choose a course. Otherwise assign a batch later under Academics → Batches.</span
          >
        </div>
        <template v-else-if="admitBatches">
          <div v-if="admitting.batchId && !admitBatchOffered" class="notice warning">
            <ion-icon :icon="alertCircleOutline" />
            <span
              >{{ admitting.batchName ?? 'The batch on the application' }} is closed or full. Choose another
              batch, or admit without one.</span
            >
          </div>
          <ion-list>
            <ion-radio-group v-model="admitChoice">
              <ion-item>
                <ion-radio :value="NO_BATCH">No batch: assign it later in Academics</ion-radio>
              </ion-item>
              <ion-item v-for="b in admitBatches" :key="b.id">
                <ion-radio :value="b.id">{{ batchOptionLabel(b) }}</ion-radio>
              </ion-item>
            </ion-radio-group>
          </ion-list>
          <p v-if="!admitBatches.length" class="muted">
            No open batch of this course has free seats in the student's branch.
          </p>
        </template>
        <ion-button
          expand="block"
          :disabled="busy || (!!admitting.courseId && !admitBatches)"
          @click="confirmAdmit()"
          >{{ admitting.studentId ? 'Confirm admission' : 'Admit' }}</ion-button
        >
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
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
  IonRadio,
  IonRadioGroup,
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
import { add, alertCircleOutline, ellipsisVertical, informationCircleOutline } from 'ionicons/icons';
import {
  APPLICATION_STATUSES,
  type AdmissionFormDto,
  type ApplicationDto,
  type ApplicationStatus,
  type BatchDto,
  type CourseBatchOptionDto,
  type CourseDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { ApiError } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { branchesApi, type Branch } from '@/modules/branches/api';
import CustomFieldsInput from '@/modules/students/CustomFieldsInput.vue';
import { fmtDate, humanize } from '@/modules/students/api';
import { academicsApi } from '@/modules/academics/api';
import { batchOptionLabel } from '@/modules/fees/api';
import { APPLICATION_COLORS, admissionsApi, type ApplicationPatch } from './api';

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

// ---- admit
/** The admit modal's choice for admitting without a batch (batch ids are positive). */
const NO_BATCH = 0;
const admitting = ref<ApplicationDto | null>(null);
/** Batches the student can be admitted into; null while loading. */
const admitBatches = ref<CourseBatchOptionDto[] | null>(null);
const admitChoice = ref(NO_BATCH);
const admitBatchOffered = computed(() =>
  (admitBatches.value ?? []).some((b) => b.id === admitting.value?.batchId),
);

async function openAdmit(a: ApplicationDto) {
  admitting.value = a;
  admitBatches.value = null;
  admitChoice.value = NO_BATCH;
  if (!a.courseId) return;
  try {
    const options = await admissionsApi.applicationBatches(a.id);
    if (admitting.value !== a) return;
    admitBatches.value = options;
    // The batch picked on the application stays chosen while it can still take the student.
    if (options.some((b) => b.id === a.batchId)) admitChoice.value = a.batchId!;
  } catch (e) {
    admitting.value = null;
    await toastError(e);
  }
}

/** Asks whether to admit despite students who may be the same person. */
async function confirmDuplicate(e: ApiError): Promise<boolean> {
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
  return (await alert.onDidDismiss()).role === 'confirm';
}

async function confirmAdmit(allowDuplicate = false): Promise<void> {
  const a = admitting.value;
  if (!a) return;
  // Without a course there is no batch to choose, so the application's own (if any) is kept.
  const batchId = a.courseId ? admitChoice.value || null : undefined;
  let retry = false;
  busy.value = true;
  try {
    const { student, batchEnrolment } = await admissionsApi.admit(a.id, { allowDuplicate, batchId });
    admitting.value = null;
    const admitted = `Admitted ${student.name} (${student.admissionNumber})`;
    await toast(
      batchEnrolment === 'no_login'
        ? `${admitted}. They share a mobile number and have no login of their own yet, so add them to the batch in Academics once they do.`
        : admitted,
      batchEnrolment === 'no_login' ? 'warning' : 'success',
    );
    await router.push(`/students/${student.id}`);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DUPLICATE_STUDENT') retry = await confirmDuplicate(e);
    else await toastError(e);
  } finally {
    busy.value = false;
  }
  if (retry) await confirmAdmit(true);
}

async function actions(a: ApplicationDto) {
  const canApprove = auth.can('admissions.approve');
  const buttons: { text: string; role?: string; handler?: () => void }[] = [];
  if (auth.can('admissions.edit')) buttons.push({ text: 'Edit details', handler: () => void openEdit(a) });
  if (canApprove) {
    if (a.status !== 'approved')
      buttons.push({ text: 'Approve', handler: () => act(() => admissionsApi.approve(a.id), 'Approved') });
    buttons.push({
      text: a.studentId ? 'Confirm admission' : 'Admit as student',
      handler: () => void openAdmit(a),
    });
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

// ---- create and edit
interface ApplicationForm {
  /** Set when editing. */
  id: number | null;
  /** The student registered themselves: name, mobile, email and branch come from their profile. */
  linked: boolean;
  name: string;
  mobile: string;
  email: string;
  branchId: number | undefined;
  courseId: number | null;
  batchId: number | null;
  waitlist: boolean;
  formData: Record<string, unknown>;
}
const form = ref<ApplicationForm | null>(null);
/** The application being edited, as loaded. */
const editing = ref<ApplicationDto | null>(null);
const courses = ref<CourseDto[]>([]);
const batches = ref<BatchDto[]>([]);
const courseOptions = computed(() =>
  courses.value.filter((c) => (c.status === 'active' && !c.isTemplate) || c.id === editing.value?.courseId),
);
// Admission enrols the student in the chosen batch through academics, so offer only open batches
// of the selected (or only) branch and course.
const batchOptions = computed(() => {
  const f = form.value;
  const branchId = f?.branchId ?? (branches.value.length === 1 ? branches.value[0].id : undefined);
  return batches.value.filter(
    (b) =>
      (b.status === 'planned' || b.status === 'active') &&
      (!branchId || b.branchId === branchId) &&
      (!f?.courseId || b.courseId === f.courseId),
  );
});
// A batch belongs to one branch and course: changing either drops a batch that no longer fits, and
// picking a batch picks its course.
watch(
  () => [form.value, form.value?.branchId, form.value?.courseId] as const,
  ([f], [prev]) => {
    if (f && f === prev && f.batchId && !batchOptions.value.some((b) => b.id === f.batchId)) f.batchId = null;
  },
);
watch(
  () => form.value?.batchId,
  (batchId) => {
    const batch = batches.value.find((b) => b.id === batchId);
    if (form.value && batch) form.value.courseId = batch.courseId;
  },
);

/** Courses and batches come from academics. */
async function loadPlacementOptions() {
  if (!auth.can('academics.view')) return;
  [courses.value, batches.value] = await Promise.all([
    academicsApi
      .courses()
      .then((p) => p.items)
      .catch(() => []),
    academicsApi
      .batches()
      .then((p) => p.items)
      .catch(() => []),
  ]);
}

async function openCreate() {
  editing.value = null;
  customForm.value = null;
  form.value = {
    id: null,
    linked: false,
    name: '',
    mobile: '',
    email: '',
    branchId: undefined,
    courseId: null,
    batchId: null,
    waitlist: false,
    formData: {},
  };
  customForm.value = await admissionsApi.activeForm('admission').catch(() => null);
  await loadPlacementOptions();
}

async function openEdit(a: ApplicationDto) {
  editing.value = a;
  customForm.value = null;
  form.value = {
    id: a.id,
    linked: !!a.studentId,
    name: a.name,
    mobile: a.mobile,
    email: a.email ?? '',
    branchId: a.branchId,
    courseId: a.courseId,
    batchId: a.batchId,
    waitlist: false,
    formData: { ...(a.formData ?? {}) },
  };
  // Answers are checked against the form the application was made with (none: nothing to edit).
  if (a.formId) customForm.value = await admissionsApi.form(a.formId).catch(() => null);
  await loadPlacementOptions();
}

async function save() {
  const f = form.value!;
  busy.value = true;
  try {
    if (f.id) {
      const patch = changes(f, editing.value!);
      const changed = Object.keys(patch).length > 0;
      if (changed) await admissionsApi.updateApplication(f.id, patch);
      await toast(changed ? 'Application updated' : 'No changes to save', changed ? 'success' : 'medium');
    } else {
      await admissionsApi.createApplication({
        name: f.name.trim(),
        mobile: f.mobile.trim(),
        email: f.email.trim() || null,
        branchId: f.branchId,
        courseId: f.courseId,
        batchId: f.batchId,
        formId: customForm.value?.id ?? null,
        formData: customForm.value ? f.formData : null,
        waitlist: f.waitlist,
      });
      await toast(f.waitlist ? 'Added to waiting list' : 'Application submitted');
    }
    form.value = null;
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

/** What the user changed; the API keeps the rest. A self-registered student's profile fields are never sent. */
function changes(f: ApplicationForm, a: ApplicationDto): ApplicationPatch {
  const patch: ApplicationPatch = {};
  if (!f.linked) {
    const email = f.email.trim() || null;
    if (f.name.trim() !== a.name) patch.name = f.name.trim();
    if (f.mobile.trim() !== a.mobile) patch.mobile = f.mobile.trim();
    if (email !== a.email) patch.email = email;
    if (f.branchId !== undefined && f.branchId !== a.branchId) patch.branchId = f.branchId;
  }
  if (f.courseId !== a.courseId) patch.courseId = f.courseId;
  if (f.batchId !== a.batchId) patch.batchId = f.batchId;
  if (customForm.value && JSON.stringify(f.formData) !== JSON.stringify(a.formData ?? {})) {
    patch.formData = f.formData;
  }
  return patch;
}

onMounted(async () => {
  await load();
  branches.value = await branchesApi.list().catch(() => []);
});
</script>

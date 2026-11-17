<template>
  <AppPage title="Enquiries" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'admissions.create'" @click="openCreate"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar v-model="search" :debounce="300" placeholder="Name, mobile or email" @ion-input="load" />
    <ion-segment v-model="status" scrollable @ion-change="load">
      <ion-segment-button value="all"><ion-label>All</ion-label></ion-segment-button>
      <ion-segment-button v-for="s in ENQUIRY_STATUSES" :key="s" :value="s">
        <ion-label>{{ humanize(s) }} ({{ summary[s] ?? 0 }})</ion-label>
      </ion-segment-button>
    </ion-segment>
    <div class="filters">
      <ion-chip :outline="!mine" @click="toggle('mine')">Assigned to me</ion-chip>
      <ion-chip :outline="!followUpDue" @click="toggle('followUpDue')">Follow-up due</ion-chip>
    </div>

    <ion-list>
      <ion-item v-for="e in enquiries" :key="e.id" button detail @click="openDetail(e.id)">
        <ion-label>
          <h2>
            {{ e.name }} <ion-badge :color="ENQUIRY_COLORS[e.status]">{{ humanize(e.status) }}</ion-badge>
          </h2>
          <p>
            {{ e.mobile }} · {{ humanize(e.source)
            }}<span v-if="e.courseInterest"> · {{ e.courseInterest }}</span>
            <span v-if="e.counsellorName"> · 👤 {{ e.counsellorName }}</span>
          </p>
          <p v-if="e.nextFollowUpAt">Next follow-up {{ fmtDate(e.nextFollowUpAt, true) }}</p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!loading && !enquiries.length"
        ><ion-label class="muted">No enquiries.</ion-label></ion-item
      >
    </ion-list>
    <ion-infinite-scroll :disabled="enquiries.length >= total" @ion-infinite="more"
      ><ion-infinite-scroll-content
    /></ion-infinite-scroll>

    <!-- Create -->
    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>New enquiry</ion-title
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
            <ion-item>
              <ion-select v-model="form.source" label="Source" label-placement="stacked" interface="popover">
                <ion-select-option v-for="s in sources" :key="s" :value="s">{{
                  humanize(s)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input v-model="form.courseInterest" label="Course interest" label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-textarea v-model="form.notes" label="Notes" label-placement="stacked" auto-grow
            /></ion-item>
            <ion-item
              ><ion-checkbox v-model="form.assignToMe">Assign to me as counsellor</ion-checkbox></ion-item
            >
            <CustomFieldsInput v-if="customForm" v-model="form.customFields" :fields="customForm.fields" />
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="busy">Save enquiry</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <!-- Detail -->
    <ion-modal :is-open="!!detail" @did-dismiss="detail = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>{{ detail?.name }}</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="detail = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content class="ion-padding">
        <template v-if="detail">
          <p>
            {{ detail.mobile }}<span v-if="detail.email"> · {{ detail.email }}</span> ·
            {{ humanize(detail.source) }}
          </p>
          <p v-if="detail.courseInterest">Interested in: {{ detail.courseInterest }}</p>
          <p v-if="detail.notes" class="pre">{{ detail.notes }}</p>
          <p v-for="(v, k) in detail.customFields ?? {}" :key="k">{{ humanize(String(k)) }}: {{ v }}</p>
          <p v-if="detail.counsellorName">Counsellor: {{ detail.counsellorName }}</p>
          <p v-if="detail.studentId">
            <router-link :to="`/students/${detail.studentId}`">View student →</router-link>
          </p>

          <template v-if="!detail.studentId && auth.can('admissions.edit')">
            <ion-item>
              <ion-select
                :value="detail.status"
                label="Status"
                label-placement="stacked"
                interface="popover"
                @ion-change="setStatus($event.detail.value)"
              >
                <ion-select-option
                  v-for="s in ENQUIRY_STATUSES.filter((x) => x !== 'converted')"
                  :key="s"
                  :value="s"
                  >{{ humanize(s) }}</ion-select-option
                >
              </ion-select>
            </ion-item>
            <ion-button
              v-if="detail.counsellorUserId !== auth.me?.user.id"
              size="small"
              fill="outline"
              @click="assignToMe"
              >Assign to me</ion-button
            >
            <ion-button v-can="'admissions.create'" size="small" fill="outline" @click="toApplication(false)"
              >Create application</ion-button
            >
            <ion-button v-can="'admissions.create'" size="small" fill="outline" @click="toApplication(true)"
              >Add to waiting list</ion-button
            >
            <ion-button v-can="'students.create'" size="small" @click="convert()"
              >Admit as student</ion-button
            >
            <ion-card v-if="duplicates.length" color="warning">
              <ion-card-content>
                <p v-for="d in duplicates" :key="`${d.kind}-${d.id}`">
                  Possible duplicate {{ d.kind }}: {{ d.name }} ({{ d.reference ?? d.mobile }})
                </p>
                <ion-button size="small" @click="convert(true)">Admit anyway</ion-button>
              </ion-card-content>
            </ion-card>
          </template>

          <ion-list>
            <ion-list-header><ion-label>Follow-ups</ion-label></ion-list-header>
            <ion-item v-for="f in detail.followUps" :key="f.id">
              <ion-label class="ion-text-wrap">
                <h3>
                  <span v-if="f.scheduledAt">📅 {{ fmtDate(f.scheduledAt, true) }}</span>
                  <ion-badge v-if="f.completedAt" color="success">done</ion-badge>
                  <ion-badge v-else-if="f.scheduledAt" color="warning">scheduled</ion-badge>
                </h3>
                <p v-if="f.note">{{ f.note }}</p>
                <p v-if="f.outcome">Outcome: {{ humanize(f.outcome) }}</p>
                <p class="muted">{{ fmtDate(f.createdAt, true) }}</p>
              </ion-label>
              <ion-button
                v-if="!f.completedAt && f.scheduledAt"
                slot="end"
                v-can="'admissions.edit'"
                fill="clear"
                @click="completeFollowUp(f.id)"
                >Mark done</ion-button
              >
            </ion-item>
            <ion-item v-if="!detail.followUps.length"
              ><ion-label class="muted">No follow-ups yet.</ion-label></ion-item
            >
          </ion-list>

          <form v-if="!detail.studentId" v-can="'admissions.edit'" @submit.prevent="addFollowUp">
            <ion-list>
              <ion-list-header><ion-label>Log / schedule follow-up</ion-label></ion-list-header>
              <ion-item
                ><ion-textarea v-model="fu.note" label="Note" label-placement="stacked" auto-grow
              /></ion-item>
              <ion-item
                ><ion-input
                  v-model="fu.outcome"
                  label="Outcome (e.g. call_back, visited)"
                  label-placement="stacked"
              /></ion-item>
              <ion-item
                ><ion-input
                  v-model="fu.scheduledAt"
                  label="Next follow-up at"
                  label-placement="stacked"
                  type="datetime-local"
              /></ion-item>
            </ion-list>
            <p class="muted">A reminder is sent to the counsellor before the scheduled time.</p>
            <ion-button expand="block" type="submit" :disabled="busy || (!fu.note && !fu.scheduledAt)"
              >Save follow-up</ion-button
            >
          </form>

          <ion-button v-can="'admissions.delete'" expand="block" fill="clear" color="danger" @click="remove"
            >Delete enquiry</ion-button
          >
        </template>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCheckbox,
  IonChip,
  IonContent,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToolbar,
  alertController,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import {
  DEFAULT_ENQUIRY_SOURCES,
  ENQUIRY_STATUSES,
  type AdmissionFormDto,
  type DuplicateMatch,
  type EnquiryDto,
  type EnquiryStatus,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { ApiError } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { branchesApi, type Branch } from '@/modules/branches/api';
import CustomFieldsInput from '@/modules/students/CustomFieldsInput.vue';
import { fmtDate, humanize, studentsApi } from '@/modules/students/api';
import { ENQUIRY_COLORS, admissionsApi, type EnquiryDetail } from './api';

const auth = useAuthStore();
const router = useRouter();
const enquiries = ref<EnquiryDto[]>([]);
const summary = ref<Partial<Record<EnquiryStatus, number>>>({});
const total = ref(0);
const page = ref(1);
const loading = ref(true);
const busy = ref(false);
const search = ref('');
const status = ref<'all' | EnquiryStatus>('all');
const mine = ref(false);
const followUpDue = ref(false);
const branches = ref<Branch[]>([]);
const sources = ref<string[]>([...DEFAULT_ENQUIRY_SOURCES]);
const customForm = ref<AdmissionFormDto | null>(null);
const detail = ref<EnquiryDetail | null>(null);
const duplicates = ref<DuplicateMatch[]>([]);
const fu = reactive({ note: '', outcome: '', scheduledAt: '' });

const orNull = (v: string) => (v.trim() ? v.trim() : null);

async function fetchPage() {
  const res = await admissionsApi.enquiries({
    page: page.value,
    search: search.value || undefined,
    status: status.value === 'all' ? undefined : status.value,
    mine: mine.value || undefined,
    followUpDue: followUpDue.value || undefined,
  });
  total.value = res.total;
  return res.items;
}

async function load() {
  loading.value = true;
  page.value = 1;
  try {
    [enquiries.value, summary.value] = await Promise.all([fetchPage(), admissionsApi.summary()]);
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  try {
    enquiries.value.push(...(await fetchPage()));
  } catch (e) {
    await toastError(e);
  } finally {
    await ev.target.complete();
  }
}

function toggle(which: 'mine' | 'followUpDue') {
  if (which === 'mine') mine.value = !mine.value;
  else followUpDue.value = !followUpDue.value;
  return load();
}

// ---- create
interface CreateForm {
  name: string;
  mobile: string;
  email: string;
  branchId: number | undefined;
  source: string;
  courseInterest: string;
  notes: string;
  assignToMe: boolean;
  customFields: Record<string, unknown>;
}
const form = ref<CreateForm | null>(null);
async function openCreate() {
  form.value = {
    name: '',
    mobile: '',
    email: '',
    branchId: undefined,
    source: sources.value[0] ?? 'walk_in',
    courseInterest: '',
    notes: '',
    assignToMe: true,
    customFields: {},
  };
  customForm.value = await admissionsApi.activeForm('enquiry').catch(() => null);
}
async function create() {
  const f = form.value!;
  busy.value = true;
  try {
    const e = await admissionsApi.createEnquiry({
      name: f.name.trim(),
      mobile: f.mobile.trim(),
      email: orNull(f.email),
      branchId: f.branchId,
      source: f.source,
      courseInterest: orNull(f.courseInterest),
      notes: orNull(f.notes),
      counsellorUserId: f.assignToMe ? auth.me?.user.id : null,
      customFields: customForm.value ? f.customFields : null,
    });
    form.value = null;
    if (e.duplicates.length)
      await toast(
        `Saved. Possible duplicates: ${e.duplicates.map((d) => `${d.kind} ${d.name}`).join(', ')}`,
        'warning',
      );
    else await toast('Enquiry saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

// ---- detail
async function openDetail(id: number) {
  duplicates.value = [];
  Object.assign(fu, { note: '', outcome: '', scheduledAt: '' });
  try {
    detail.value = await admissionsApi.enquiry(id);
  } catch (e) {
    await toastError(e);
  }
}

async function act(fn: () => Promise<unknown>, done: string) {
  busy.value = true;
  try {
    await fn();
    await toast(done);
    if (detail.value) detail.value = await admissionsApi.enquiry(detail.value.id);
    await load();
    return true;
  } catch (e) {
    await toastError(e);
    return false;
  } finally {
    busy.value = false;
  }
}

const setStatus = (s: EnquiryStatus) =>
  s !== detail.value?.status &&
  act(() => admissionsApi.updateEnquiry(detail.value!.id, { status: s }), 'Status updated');
const assignToMe = () =>
  act(
    () => admissionsApi.updateEnquiry(detail.value!.id, { counsellorUserId: auth.me!.user.id }),
    'Assigned',
  );
const completeFollowUp = (id: number) =>
  act(() => admissionsApi.completeFollowUp(detail.value!.id, id), 'Marked done');

async function addFollowUp() {
  const ok = await act(
    () =>
      admissionsApi.addFollowUp(detail.value!.id, {
        note: orNull(fu.note),
        outcome: orNull(fu.outcome)?.toLowerCase().replace(/\s+/g, '_') ?? null,
        scheduledAt: fu.scheduledAt ? new Date(fu.scheduledAt).toISOString() : null,
        completed: !fu.scheduledAt,
      }),
    'Follow-up saved',
  );
  if (ok) Object.assign(fu, { note: '', outcome: '', scheduledAt: '' });
}

async function toApplication(waitlist: boolean) {
  const ok = await act(
    () => admissionsApi.toApplication(detail.value!, waitlist),
    waitlist ? 'Added to waiting list' : 'Application created',
  );
  if (ok) {
    detail.value = null;
    await router.push('/admissions/applications');
  }
}

async function convert(allowDuplicate = false) {
  busy.value = true;
  try {
    const s = await admissionsApi.convert(detail.value!.id, { allowDuplicate });
    detail.value = null;
    await toast(`Admitted ${s.name} (${s.admissionNumber})`);
    await router.push(`/students/${s.id}`);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DUPLICATE_STUDENT')
      duplicates.value = (e.details as { matches: DuplicateMatch[] }).matches;
    else await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  const a = await alertController.create({
    header: 'Delete enquiry?',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Delete', role: 'confirm' },
    ],
  });
  await a.present();
  if ((await a.onDidDismiss()).role !== 'confirm') return;
  try {
    await admissionsApi.removeEnquiry(detail.value!.id);
    detail.value = null;
    await toast('Deleted');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(async () => {
  await load();
  branches.value = await branchesApi.list().catch(() => []);
  if (auth.can('students.view')) {
    const s = await studentsApi.settings().catch(() => null);
    if (s?.enquirySources.length) sources.value = s.enquirySources;
  }
});
</script>

<style scoped>
.filters {
  padding: 4px 8px;
}
.pre {
  white-space: pre-line;
}
</style>

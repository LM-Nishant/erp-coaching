<template>
  <AppPage title="Course enrolments" :on-refresh="reload">
    <ion-searchbar v-model="search" :debounce="400" placeholder="Student name, admission no. or mobile" />
    <ion-segment v-model="status">
      <ion-segment-button value="awaiting_batch"><ion-label>Awaiting batch</ion-label></ion-segment-button>
      <ion-segment-button value="enrolled"><ion-label>Enrolled</ion-label></ion-segment-button>
      <ion-segment-button value="revoked"><ion-label>Revoked</ion-label></ion-segment-button>
    </ion-segment>
    <p class="muted ion-padding-horizontal">{{ STATUS_HINTS[status] }}</p>

    <ion-list>
      <ion-item v-for="r in rows" :key="r.id">
        <ion-label class="ion-text-wrap">
          <h3>
            {{ r.studentName ?? `Student #${r.studentId}` }}
            <small class="muted">{{ r.admissionNumber }}</small>
          </h3>
          <p>{{ r.courseName ?? `Course #${r.courseId}` }}</p>
          <p v-if="r.batchName">Batch {{ r.batchName }}</p>
          <p v-if="r.requestedBatchName && r.requestedBatchId !== r.batchId" class="muted">
            Chose {{ r.requestedBatchName }} at checkout
          </p>
          <p v-if="r.reason && r.status !== 'enrolled'" class="muted">
            {{ sentence(COURSE_BATCH_ISSUE_LABELS[r.reason]) }}
          </p>
          <p class="muted">
            Purchased {{ fmtDate(r.createdAt) }}
            <span v-if="r.enrolledAt"> · enrolled {{ fmtDate(r.enrolledAt) }}</span>
            <span v-if="r.revokedAt"> · revoked {{ fmtDate(r.revokedAt) }}</span>
          </p>
        </ion-label>
        <div slot="end" class="actions">
          <ion-button v-if="r.status === 'awaiting_batch'" v-can="'fees.approve'" @click="openAssign(r)"
            >Assign batch</ion-button
          >
          <ion-button fill="clear" size="small" :router-link="`/fees/accounts/${r.accountId}`"
            >Fee account</ion-button
          >
        </div>
      </ion-item>
      <ion-item v-if="!loading && !rows.length"
        ><ion-label class="muted">{{ EMPTY[status] }}</ion-label></ion-item
      >
    </ion-list>
    <ion-infinite-scroll :disabled="rows.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>

    <ion-modal :is-open="!!assigning" @did-dismiss="assigning = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Assign batch</ion-title>
          <ion-buttons slot="end"><ion-button @click="assigning = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="assigning" class="ion-padding">
        <p>
          <strong>{{ assigning.studentName }}</strong> · {{ assigning.courseName }}
        </p>
        <ion-list v-if="options.length">
          <ion-radio-group v-model="choice">
            <ion-item v-for="b in options" :key="b.id">
              <ion-radio :value="b.id">{{ batchOptionLabel(b) }}</ion-radio>
            </ion-item>
          </ion-radio-group>
        </ion-list>
        <div v-else-if="!optionsLoading" class="notice warning">
          <ion-icon :icon="alertCircleOutline" />
          <span
            >No open batch of this course has free seats in the student's branch. Create one, or raise a
            batch's capacity, under Academics → Batches, then come back.</span
          >
        </div>
        <ion-button expand="block" :disabled="saving || !choice" @click="assign">Enrol in batch</ion-button>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonRadio,
  IonRadioGroup,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { alertCircleOutline } from 'ionicons/icons';
import {
  COURSE_BATCH_ISSUE_LABELS,
  type CourseBatchOptionDto,
  type CourseEnrolmentDto,
  type FeeCourseEnrolmentStatus,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { fmtDate } from '../students/api';
import { batchOptionLabel, feesApi } from './api';

const STATUS_HINTS: Record<FeeCourseEnrolmentStatus, string> = {
  awaiting_batch:
    'Paid online purchases that no batch could take. Assign each one a batch; the student is notified.',
  enrolled: 'Online purchases whose student was admitted and enrolled in a batch of the course.',
  revoked: 'Refunded purchases. The student left any batch the purchase had put them in.',
};
const EMPTY: Record<FeeCourseEnrolmentStatus, string> = {
  awaiting_batch: 'No purchase is waiting for a batch.',
  enrolled: 'No enrolments from online purchases.',
  revoked: 'No revoked purchases.',
};
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const status = ref<FeeCourseEnrolmentStatus>('awaiting_batch');
const search = ref('');
const rows = ref<CourseEnrolmentDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);

const assigning = ref<CourseEnrolmentDto | null>(null);
const options = ref<CourseBatchOptionDto[]>([]);
const optionsLoading = ref(false);
const choice = ref<number | null>(null);
const saving = ref(false);

async function load(reset = true) {
  loading.value = true;
  if (reset) page.value = 1;
  try {
    const res = await feesApi.courseEnrolments({
      status: status.value,
      search: search.value.trim() || undefined,
      page: page.value,
    });
    rows.value = reset ? res.items : [...rows.value, ...res.items];
    total.value = res.total;
  } catch (e) {
    void toastError(e);
  } finally {
    loading.value = false;
  }
}

const reload = () => load(true);

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  await load(false);
  await ev.target.complete();
}

async function openAssign(r: CourseEnrolmentDto) {
  assigning.value = r;
  options.value = [];
  choice.value = null;
  optionsLoading.value = true;
  try {
    options.value = await feesApi.courseEnrolmentBatches(r.id);
    if (options.value.length === 1) choice.value = options.value[0].id;
  } catch (e) {
    void toastError(e);
  } finally {
    optionsLoading.value = false;
  }
}

async function assign() {
  const r = assigning.value;
  if (!r || !choice.value) return;
  saving.value = true;
  try {
    const saved = await feesApi.assignCourseEnrolment(r.id, choice.value);
    await toast(`${saved.studentName ?? 'Student'} enrolled in ${saved.batchName ?? 'the batch'}`);
    assigning.value = null;
    await reload();
  } catch (e) {
    void toastError(e);
  } finally {
    saving.value = false;
  }
}

onIonViewWillEnter(reload);
watch([status, search], reload);
</script>

<style scoped>
.actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
</style>

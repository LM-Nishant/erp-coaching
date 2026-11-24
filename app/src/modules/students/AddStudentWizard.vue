<template>
  <ion-modal :is-open="isOpen" class="add-student" @did-dismiss="emit('close')">
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ t('students.add.title') }}</ion-title>
        <ion-buttons slot="end">
          <ion-button @click="emit('close')">{{ t('common.actions.close') }}</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ol
        v-if="step !== 'done'"
        class="steps"
        :aria-label="t('students.add.progress', { step: stepIndex + 1, total: steps.length })"
      >
        <li v-for="(s, i) in steps" :key="s" :class="{ current: i === stepIndex, done: i < stepIndex }">
          <span class="dot">{{ i + 1 }}</span>
          <span class="label">{{ t(`students.add.steps.${s}`) }}</span>
        </li>
      </ol>

      <!-- 1. Details -->
      <form v-if="step === 'details'" @submit.prevent="saveStudent()">
        <ion-list>
          <ion-item>
            <ion-input
              v-model="form.name"
              :label="t('students.add.name')"
              label-placement="stacked"
              autocapitalize="words"
              required
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.mobile"
              :label="t('students.add.mobile')"
              :helper-text="t('students.add.mobileHelp')"
              label-placement="stacked"
              type="tel"
              inputmode="tel"
              required
            />
          </ion-item>
          <ion-item v-if="branches.length > 1">
            <ion-select
              v-model="form.branchId"
              :label="t('students.add.branch')"
              label-placement="stacked"
              interface="popover"
            >
              <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
                b.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.classGrade"
              :label="t('students.add.classGrade')"
              label-placement="stacked"
            />
          </ion-item>
        </ion-list>
        <FormSection advanced>
          <ion-list>
            <ion-item>
              <ion-input
                v-model="form.email"
                :label="t('students.add.email')"
                label-placement="stacked"
                type="email"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.dateOfBirth"
                :label="t('students.add.dateOfBirth')"
                label-placement="stacked"
                type="date"
              />
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.gender"
                :label="t('students.add.gender')"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option v-for="g in GENDERS" :key="g" :value="g">{{
                  t(`students.add.genders.${g}`)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.idNumber"
                :label="t('students.add.idNumber')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.schoolName"
                :label="t('students.add.school')"
                label-placement="stacked"
              />
            </ion-item>
          </ion-list>
        </FormSection>

        <ion-card v-if="duplicates.length" color="warning">
          <ion-card-content>
            <strong>{{ t('students.add.duplicatesTitle') }}</strong>
            <p v-for="d in duplicates" :key="`${d.kind}-${d.id}`">
              {{ d.name }} ({{ d.reference ?? d.mobile }}) ·
              {{ t('students.add.matchedOn', { fields: d.matchedOn.join(', ') }) }}
            </p>
            <p>{{ t('students.add.duplicatesHelp') }}</p>
            <ion-button size="small" :disabled="saving" @click="saveStudent(true)">{{
              t('students.add.saveAnyway')
            }}</ion-button>
          </ion-card-content>
        </ion-card>

        <ion-button
          expand="block"
          type="submit"
          :disabled="saving || !form.name.trim() || !form.mobile.trim()"
          >{{ steps.length > 1 ? t('students.add.saveNext') : t('students.add.save') }}</ion-button
        >
      </form>

      <!-- 2. Batch -->
      <template v-else-if="step === 'batch'">
        <h2 class="question">{{ t('students.add.whichBatch', { name: student?.name }) }}</h2>
        <ion-searchbar
          v-if="branchBatches.length > 6"
          v-model="batchSearch"
          :placeholder="t('students.add.findBatch')"
        />
        <ion-list v-if="shownBatches.length">
          <ion-item v-for="b in shownBatches" :key="b.id" button :disabled="saving" @click="enrol(b)">
            <ion-label>
              <h2>{{ b.name }}</h2>
              <p>
                {{ b.code }} ·
                {{ t('students.add.seats', { n: b.enrolledCount ?? 0, capacity: b.capacity }) }}
              </p>
            </ion-label>
          </ion-item>
        </ion-list>
        <p v-else class="muted">{{ t('students.add.noBatches') }}</p>
        <ion-button expand="block" fill="clear" @click="afterBatch()">{{
          t('students.add.skip')
        }}</ion-button>
      </template>

      <!-- 3. Fee plan -->
      <template v-else-if="step === 'fees'">
        <h2 class="question">{{ t('students.add.whichFee') }}</h2>
        <ion-list v-if="orderedStructures.length">
          <ion-item
            v-for="s in orderedStructures"
            :key="s.id"
            button
            :disabled="saving"
            @click="createFee(s)"
          >
            <ion-label>
              <h2>{{ s.name }}</h2>
              <p>
                {{ formatMoney(s.total) }}
                <span v-if="matches(s)"> · {{ t('students.add.forThisBatch') }}</span>
              </p>
            </ion-label>
          </ion-item>
        </ion-list>
        <p v-else class="muted">{{ t('students.add.noFees') }}</p>
        <ion-button expand="block" fill="clear" @click="step = 'done'">{{
          t('students.add.skip')
        }}</ion-button>
      </template>

      <!-- Done -->
      <template v-else-if="student">
        <div class="done" role="status">
          <ion-icon :icon="checkmarkCircle" color="success" aria-hidden="true" />
          <h2>{{ t('students.add.doneTitle', { name: student.name }) }}</h2>
          <p class="muted">{{ t('students.add.admissionNumber', { number: student.admissionNumber }) }}</p>
          <p v-if="enrolledIn" class="muted">
            {{ t('students.add.enrolledIn', { batch: enrolledIn.name }) }}
          </p>
        </div>
        <ion-button v-if="account" expand="block" @click="go(`/fees/accounts/${account.id}`)">{{
          t('students.add.collectFirst')
        }}</ion-button>
        <ion-button
          expand="block"
          :fill="account ? 'outline' : 'solid'"
          @click="go(`/students/${student.id}`)"
          >{{ t('students.add.openProfile') }}</ion-button
        >
        <ion-button expand="block" fill="clear" @click="reset()">{{ t('students.add.another') }}</ion-button>
      </template>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { checkmarkCircle } from 'ionicons/icons';
import type { BatchDto, DuplicateMatch, FeeAccountDto, FeeStructureDto, StudentDto } from '@erp/shared';
import FormSection from '@/components/FormSection.vue';
import { ApiError } from '@/core/api';
import { formatMoney } from '@/core/format';
import { toastError } from '@/core/toast';
import { academicsApi } from '@/modules/academics/api';
import type { Branch } from '@/modules/branches/api';
import { feesApi } from '@/modules/fees/api';
import { useAuthStore } from '@/stores/auth';
import { studentsApi } from './api';

const props = defineProps<{ isOpen: boolean; branches: Branch[] }>();
const emit = defineEmits<{ close: []; added: [student: StudentDto] }>();
const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

type Step = 'details' | 'batch' | 'fees' | 'done';
const GENDERS = ['male', 'female', 'other'] as const;

const step = ref<Step>('details');
const saving = ref(false);
const duplicates = ref<DuplicateMatch[]>([]);
const student = ref<StudentDto | null>(null);
const enrolledIn = ref<BatchDto | null>(null);
const account = ref<FeeAccountDto | null>(null);
const batches = ref<BatchDto[]>([]);
const structures = ref<FeeStructureDto[]>([]);
const batchSearch = ref('');
const form = reactive({
  name: '',
  mobile: '',
  email: '',
  branchId: undefined as number | undefined,
  dateOfBirth: '',
  gender: null as (typeof GENDERS)[number] | null,
  idNumber: '',
  schoolName: '',
  classGrade: '',
});

const canEnrol = computed(() => auth.can('academics.edit') && auth.moduleEnabled('academics'));
const canBill = computed(() => auth.can('fees.create') && auth.moduleEnabled('fees'));
const steps = computed<Step[]>(() => [
  'details',
  ...(canEnrol.value ? (['batch'] as const) : []),
  ...(canBill.value ? (['fees'] as const) : []),
]);
const stepIndex = computed(() => steps.value.indexOf(step.value));

const branchBatches = computed(() =>
  batches.value.filter((b) => !student.value || b.branchId === student.value.branchId),
);
const shownBatches = computed(() => {
  const q = batchSearch.value.trim().toLowerCase();
  return q
    ? branchBatches.value.filter((b) => `${b.name} ${b.code}`.toLowerCase().includes(q))
    : branchBatches.value;
});
const matches = (s: FeeStructureDto) =>
  !!enrolledIn.value &&
  (s.batchId === enrolledIn.value.id || (!s.batchId && s.courseId === enrolledIn.value.courseId));
/** Plans for the chosen batch or its course first, then the rest of the student's branch. */
const orderedStructures = computed(() =>
  structures.value
    .filter((s) => !s.branchId || s.branchId === student.value?.branchId)
    .sort((a, b) => Number(matches(b)) - Number(matches(a))),
);

function reset() {
  step.value = 'details';
  duplicates.value = [];
  student.value = null;
  enrolledIn.value = null;
  account.value = null;
  batchSearch.value = '';
  Object.assign(form, {
    name: '',
    mobile: '',
    email: '',
    branchId: props.branches.length === 1 ? props.branches[0].id : undefined,
    dateOfBirth: '',
    gender: null,
    idNumber: '',
    schoolName: '',
    classGrade: '',
  });
}

watch(
  () => props.isOpen,
  (open) => open && reset(),
);

const orNull = (v: string) => (v.trim() ? v.trim() : null);

function next(from: Step) {
  const i = steps.value.indexOf(from);
  step.value = steps.value[i + 1] ?? 'done';
}

async function saveStudent(allowDuplicate = false) {
  saving.value = true;
  try {
    const s = await studentsApi.create({
      name: form.name.trim(),
      mobile: form.mobile.trim(),
      email: orNull(form.email),
      branchId: form.branchId,
      dateOfBirth: orNull(form.dateOfBirth),
      gender: form.gender,
      idNumber: orNull(form.idNumber),
      academicInfo:
        form.schoolName.trim() || form.classGrade.trim()
          ? { schoolName: orNull(form.schoolName), classGrade: orNull(form.classGrade) }
          : null,
      allowDuplicate,
    });
    student.value = s;
    duplicates.value = [];
    emit('added', s);
    if (canEnrol.value && s.userId) {
      const page = await academicsApi.batches().catch(() => null);
      batches.value = (page?.items ?? []).filter((b) => b.status === 'active' || b.status === 'planned');
      step.value = 'batch';
    } else await afterBatch();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DUPLICATE_STUDENT')
      duplicates.value = (e.details as { matches: DuplicateMatch[] }).matches;
    else await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function enrol(b: BatchDto) {
  if (!student.value?.userId) return;
  saving.value = true;
  try {
    await academicsApi.enroll(b.id, [student.value.userId]);
    enrolledIn.value = b;
    await afterBatch();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function afterBatch() {
  if (canBill.value) {
    try {
      structures.value = (await feesApi.structures({ status: 'active' })).items;
    } catch (e) {
      await toastError(e);
    }
  }
  next('batch');
}

async function createFee(s: FeeStructureDto) {
  if (!student.value) return;
  saving.value = true;
  try {
    account.value = await feesApi.createAccount({ studentId: student.value.id, structureId: s.id });
    step.value = 'done';
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function go(path: string) {
  emit('close');
  await router.push(path);
}
</script>

<style scoped>
.steps {
  display: flex;
  gap: 8px;
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
}
.steps li {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ion-color-medium);
  font-size: 13px;
}
.steps .dot {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-weight: 600;
  flex: none;
}
.steps li.current,
.steps li.done {
  color: var(--ion-color-primary);
}
.steps li.current .dot,
.steps li.done .dot {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  border-color: var(--ion-color-primary);
}
.question {
  font-size: 18px;
  margin: 0 0 8px;
}
.muted {
  color: var(--ion-color-medium);
}
.done {
  text-align: center;
  margin: 24px 0;
}
.done ion-icon {
  font-size: 56px;
}
ion-item {
  --min-height: var(--app-tap-target, 48px);
}
</style>

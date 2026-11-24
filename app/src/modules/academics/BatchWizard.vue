<template>
  <ion-modal :is-open="isOpen" class="batch-wizard" @did-dismiss="emit('close')">
    <ion-header>
      <ion-toolbar>
        <ion-buttons v-if="step > 0" slot="start">
          <ion-button :aria-label="t('academics.wizard.back')" @click="step--">
            <ion-icon slot="icon-only" :icon="arrowBackOutline" />
          </ion-button>
        </ion-buttons>
        <ion-title>{{ t('academics.wizard.title') }}</ion-title>
        <ion-buttons slot="end">
          <ion-button @click="emit('close')">{{ t('common.actions.close') }}</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ol class="steps" :aria-label="t('academics.wizard.progress', { step: step + 1, total: 3 })">
        <li v-for="(s, i) in STEPS" :key="s" :class="{ current: i === step, done: i < step }">
          <span class="dot">{{ i + 1 }}</span>
          <span class="label">{{ t(`academics.wizard.steps.${s}`) }}</span>
        </li>
      </ol>

      <!-- 1. Course -->
      <template v-if="step === 0">
        <h2 class="question">{{ t('academics.wizard.whichCourse') }}</h2>
        <ion-list v-if="courses.length">
          <ion-item v-for="c in courses" :key="c.id" button detail @click="chooseCourse(c)">
            <ion-label>
              <h2>{{ c.name }}</h2>
              <p>{{ c.code }} · {{ t(`academics.wizard.mode.${c.mode}`) }}</p>
            </ion-label>
            <ion-icon v-if="form.courseId === c.id" slot="end" :icon="checkmarkCircle" color="primary" />
          </ion-item>
        </ion-list>
        <EmptyState
          v-else
          :icon="libraryOutline"
          :title="t('academics.wizard.noCoursesTitle')"
          :message="t('academics.wizard.noCoursesMessage')"
        >
          <ion-button router-link="/academics/courses" @click="emit('close')">{{
            t('academics.wizard.addCourse')
          }}</ion-button>
        </EmptyState>
      </template>

      <!-- 2. Name, branch, start -->
      <form v-else-if="step === 1" @submit.prevent="toTeachers">
        <p class="muted">{{ course?.name }}</p>
        <ion-list>
          <ion-item>
            <ion-input
              v-model="form.name"
              :label="t('academics.wizard.name')"
              label-placement="stacked"
              :placeholder="t('academics.wizard.namePlaceholder')"
              required
            />
          </ion-item>
          <ion-item v-if="courseBranches.length > 1">
            <ion-select
              v-model="form.branchId"
              :label="t('academics.wizard.branch')"
              label-placement="stacked"
              interface="popover"
            >
              <ion-select-option v-for="b in courseBranches" :key="b.id" :value="b.id">{{
                b.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.startDate"
              type="date"
              :label="t('academics.wizard.start')"
              label-placement="stacked"
              required
            />
          </ion-item>
        </ion-list>
        <FormSection advanced>
          <ion-list>
            <ion-item>
              <ion-input
                v-model="form.code"
                :label="t('academics.wizard.code')"
                label-placement="stacked"
                :helper-text="t('academics.wizard.codeHelp')"
                required
                @ion-input="codeEdited = true"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model.number="form.capacity"
                type="number"
                min="1"
                :label="t('academics.wizard.capacity')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.endDate"
                type="date"
                :label="t('academics.wizard.end')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.academicSessionId"
                :label="t('academics.wizard.session')"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option v-for="s in sessions" :key="s.id" :value="s.id">{{
                  s.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.mode"
                :label="t('academics.wizard.modeLabel')"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option v-for="m in COURSE_MODES" :key="m" :value="m">{{
                  t(`academics.wizard.mode.${m}`)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-toggle v-model="startsActive">{{ t('academics.wizard.activeNow') }}</ion-toggle>
            </ion-item>
          </ion-list>
        </FormSection>
        <ion-button expand="block" type="submit" :disabled="!basicsValid">{{
          t('academics.wizard.next')
        }}</ion-button>
      </form>

      <!-- 3. Teachers (optional) -->
      <template v-else>
        <h2 class="question">{{ t('academics.wizard.whoTeaches') }}</h2>
        <p class="muted">{{ t('academics.wizard.teachersOptional') }}</p>
        <ion-list v-if="branchTeachers.length">
          <ion-item v-for="u in branchTeachers" :key="u.id">
            <ion-checkbox
              :checked="picked.has(u.id)"
              justify="start"
              label-placement="end"
              @ion-change="toggleTeacher(u.id, $event.detail.checked)"
              >{{ u.name }}</ion-checkbox
            >
            <ion-select
              v-if="picked.has(u.id) && subjects.length"
              slot="end"
              :value="picked.get(u.id)"
              :aria-label="t('academics.wizard.subjectFor', { name: u.name })"
              interface="popover"
              :placeholder="t('academics.wizard.anySubject')"
              @ion-change="picked.set(u.id, $event.detail.value)"
            >
              <ion-select-option :value="null">{{ t('academics.wizard.anySubject') }}</ion-select-option>
              <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
                s.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
        </ion-list>
        <p v-else class="muted">{{ t('academics.wizard.noTeachers') }}</p>
        <ion-button expand="block" :disabled="saving" @click="save">{{
          picked.size ? t('academics.wizard.create') : t('academics.wizard.createWithout')
        }}</ion-button>
      </template>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
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
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import { arrowBackOutline, checkmarkCircle, libraryOutline } from 'ionicons/icons';
import {
  COURSE_MODES,
  type AcademicSessionDto,
  type BatchDto,
  type CourseDto,
  type CourseMode,
  type SubjectDto,
} from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import FormSection from '@/components/FormSection.vue';
import { toastError } from '@/core/toast';
import { academicsApi, isoToday, type BranchRef, type PersonRef } from './api';
import { suggestBatchCode } from './batch-code';

const props = defineProps<{
  isOpen: boolean;
  courses: CourseDto[];
  branches: BranchRef[];
  sessions: AcademicSessionDto[];
  subjects: SubjectDto[];
  teachers: PersonRef[];
  /** Existing codes, so the suggested one is free. */
  takenCodes: string[];
  initialCourseId?: number | null;
}>();
const emit = defineEmits<{ close: []; saved: [batch: BatchDto] }>();
const { t } = useI18n();

const STEPS = ['course', 'basics', 'teachers'] as const;
const step = ref(0);
const saving = ref(false);
const codeEdited = ref(false);
const startsActive = ref(false);
/** teacherUserId → subjectId (null = any subject). */
const picked = reactive(new Map<number, number | null>());
const form = reactive({
  courseId: null as number | null,
  name: '',
  code: '',
  branchId: null as number | null,
  academicSessionId: null as number | null,
  capacity: 30,
  startDate: isoToday(),
  endDate: '',
  mode: 'offline' as CourseMode,
});

const course = computed(() => props.courses.find((c) => c.id === form.courseId));
const courseBranches = computed(() =>
  course.value ? props.branches.filter((b) => course.value!.branchIds.includes(b.id)) : props.branches,
);
const branchTeachers = computed(() =>
  props.teachers.filter((u) => !form.branchId || !u.branchIds.length || u.branchIds.includes(form.branchId)),
);
const basicsValid = computed(
  () =>
    !!form.name.trim() &&
    !!form.code.trim() &&
    !!form.branchId &&
    !!form.startDate &&
    !!form.academicSessionId &&
    Number(form.capacity) > 0,
);

watch(
  () => props.isOpen,
  (open) => {
    if (!open) return;
    step.value = 0;
    codeEdited.value = false;
    startsActive.value = false;
    picked.clear();
    Object.assign(form, {
      courseId: null,
      name: '',
      code: '',
      branchId: null,
      academicSessionId: props.sessions.find((s) => s.isCurrent)?.id ?? props.sessions[0]?.id ?? null,
      capacity: 30,
      startDate: isoToday(),
      endDate: '',
      mode: 'offline',
    });
    const initial = props.courses.find((c) => c.id === props.initialCourseId);
    if (initial) chooseCourse(initial);
  },
);

watch(
  () => form.startDate,
  () => autoCode(),
);

function autoCode() {
  if (codeEdited.value || !course.value) return;
  form.code = suggestBatchCode(course.value.code, form.startDate, props.takenCodes);
}

function chooseCourse(c: CourseDto) {
  form.courseId = c.id;
  form.mode = c.mode;
  const allowed = courseBranches.value;
  if (!form.branchId || !allowed.some((b) => b.id === form.branchId)) form.branchId = allowed[0]?.id ?? null;
  autoCode();
  step.value = 1;
}

function toTeachers() {
  if (basicsValid.value) step.value = 2;
}

function toggleTeacher(id: number, on: boolean) {
  if (on) picked.set(id, null);
  else picked.delete(id);
}

async function save() {
  saving.value = true;
  try {
    const batch = await academicsApi.saveBatch({
      ...form,
      name: form.name.trim(),
      code: form.code.trim(),
      capacity: Number(form.capacity),
      endDate: form.endDate || null,
      status: startsActive.value ? 'active' : 'planned',
      teachers: [...picked].map(([teacherUserId, subjectId]) => ({ teacherUserId, subjectId })),
    });
    emit('saved', batch);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
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
ion-item {
  --min-height: var(--app-tap-target, 48px);
}
</style>

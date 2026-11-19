<template>
  <AppPage title="Batches" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'academics.create'" aria-label="New batch" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-item lines="none">
      <ion-select v-model="filters.academicSessionId" label="Session" interface="popover" @ion-change="load">
        <ion-select-option :value="null">All</ion-select-option>
        <ion-select-option v-for="s in sessions" :key="s.id" :value="s.id">{{ s.name }}</ion-select-option>
      </ion-select>
      <ion-select v-model="filters.courseId" label="Course" interface="popover" @ion-change="load">
        <ion-select-option :value="null">All</ion-select-option>
        <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
      </ion-select>
    </ion-item>

    <ion-list>
      <ion-item v-for="b in batches" :key="b.id" button :detail="false" @click="openRoster(b)">
        <ion-label>
          <h2>
            {{ b.name }} <ion-badge color="medium">{{ b.code }}</ion-badge>
            <ion-badge :color="statusColor(b.status)">{{ b.status }}</ion-badge>
          </h2>
          <p>
            {{ courseName(b.courseId) }} · {{ branchName(b.branchId) }} ·
            {{ sessionName(b.academicSessionId) }} ·
            {{ b.mode }}
          </p>
          <p>
            {{ b.enrolledCount ?? 0 }}/{{ b.capacity }} students · {{ b.startDate
            }}{{ b.endDate ? ` → ${b.endDate}` : '' }}
          </p>
          <p v-if="b.teachers.length">
            Teachers:
            {{
              b.teachers
                .map(
                  (t) =>
                    `${t.teacher?.name ?? t.teacherUserId}${t.subjectId ? ` (${subjectName(t.subjectId)})` : ''}`,
                )
                .join(', ')
            }}
          </p>
        </ion-label>
        <ion-button
          slot="end"
          v-can="'academics.edit'"
          fill="clear"
          :aria-label="`Edit ${b.name}`"
          @click.stop="openEditor(b)"
          ><ion-icon slot="icon-only" :icon="createOutline"
        /></ion-button>
        <ion-button
          slot="end"
          v-can="'academics.delete'"
          fill="clear"
          color="danger"
          :aria-label="`Delete ${b.name}`"
          @click.stop="remove(b)"
          ><ion-icon slot="icon-only" :icon="trashOutline"
        /></ion-button>
      </ion-item>
      <ion-item v-if="!loading && !batches.length"
        ><ion-label class="muted">No batches yet.</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit batch' : 'New batch' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item
              ><ion-input v-model="form.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.code" label="Code" label-placement="stacked" required
            /></ion-item>
            <ion-item>
              <ion-select
                v-model="form.courseId"
                label="Course"
                label-placement="stacked"
                @ion-change="onCourse"
              >
                <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{
                  c.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.branchId" label="Branch" label-placement="stacked">
                <ion-select-option v-for="b in courseBranches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.academicSessionId" label="Academic session" label-placement="stacked">
                <ion-select-option v-for="s in sessions" :key="s.id" :value="s.id">{{
                  s.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input
                v-model.number="form.capacity"
                type="number"
                min="1"
                label="Capacity"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.startDate"
                type="date"
                label="Start"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.endDate" type="date" label="End" label-placement="stacked"
            /></ion-item>
            <ion-item>
              <ion-select v-model="form.mode" label="Mode" label-placement="stacked">
                <ion-select-option v-for="m in COURSE_MODES" :key="m" :value="m">{{ m }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.status" label="Status" label-placement="stacked">
                <ion-select-option
                  v-for="s in ['planned', 'active', 'completed', 'cancelled']"
                  :key="s"
                  :value="s"
                  >{{ s }}</ion-select-option
                >
              </ion-select>
            </ion-item>
            <ion-list-header>Subject teachers</ion-list-header>
            <ion-item v-for="(t, i) in form.teachers" :key="i">
              <ion-select v-model="t.teacherUserId" label="Teacher" label-placement="stacked">
                <ion-select-option v-for="u in teachers" :key="u.id" :value="u.id">{{
                  u.name
                }}</ion-select-option>
              </ion-select>
              <ion-select v-model="t.subjectId" label="Subject" label-placement="stacked">
                <ion-select-option :value="null">Any</ion-select-option>
                <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
                  s.name
                }}</ion-select-option>
              </ion-select>
              <ion-button
                slot="end"
                fill="clear"
                color="danger"
                aria-label="Remove teacher"
                @click="form.teachers.splice(i, 1)"
                ><ion-icon slot="icon-only" :icon="closeOutline"
              /></ion-button>
            </ion-item>
            <ion-item lines="none">
              <ion-button
                fill="outline"
                size="small"
                @click="form.teachers.push({ teacherUserId: null, subjectId: null })"
                >Add teacher</ion-button
              >
            </ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!rosterBatch" @did-dismiss="rosterBatch = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ rosterBatch?.name }} · students</ion-title>
          <ion-buttons slot="end"><ion-button @click="rosterBatch = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <ion-list>
          <ion-item v-for="e in roster" :key="e.id">
            <ion-label>
              <h3>{{ e.student?.name ?? `#${e.studentUserId}` }}</h3>
              <p>
                joined {{ e.joinedOn }}<span v-if="e.leftOn"> · left {{ e.leftOn }}</span>
              </p>
            </ion-label>
            <ion-badge slot="end" :color="statusColor(e.status)">{{ e.status }}</ion-badge>
            <ion-button
              v-if="e.status === 'active'"
              slot="end"
              v-can="'academics.edit'"
              fill="clear"
              color="danger"
              :aria-label="`Remove ${e.student?.name ?? 'student'} from the batch`"
              @click="unenroll(e.studentUserId)"
              ><ion-icon slot="icon-only" :icon="closeOutline"
            /></ion-button>
          </ion-item>
          <ion-item v-if="!roster.length"
            ><ion-label class="muted">No students enrolled.</ion-label></ion-item
          >
        </ion-list>
        <div v-can="'academics.edit'">
          <ion-item>
            <ion-select v-model="toEnroll" label="Enroll students" label-placement="stacked" multiple>
              <ion-select-option v-for="s in availableStudents" :key="s.id" :value="s.id"
                >{{ s.name }} · {{ s.mobile }}</ion-select-option
              >
            </ion-select>
          </ion-item>
          <ion-button expand="block" :disabled="!toEnroll.length" @click="enroll">Enroll</ion-button>
        </div>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, closeOutline, createOutline, trashOutline } from 'ionicons/icons';
import {
  COURSE_MODES,
  type AcademicSessionDto,
  type BatchDto,
  type BatchStatus,
  type BatchStudentDto,
  type CourseDto,
  type CourseMode,
  type SubjectDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi, isoToday, statusColor, type BranchRef, type PersonRef } from './api';

interface Form {
  name: string;
  code: string;
  courseId: number | null;
  branchId: number | null;
  academicSessionId: number | null;
  capacity: number;
  startDate: string;
  endDate: string;
  mode: CourseMode;
  status: BatchStatus;
  teachers: { teacherUserId: number | null; subjectId: number | null }[];
}

const auth = useAuthStore();
const batches = ref<BatchDto[]>([]);
const sessions = ref<AcademicSessionDto[]>([]);
const courses = ref<CourseDto[]>([]);
const branches = ref<BranchRef[]>([]);
const subjects = ref<SubjectDto[]>([]);
const teachers = ref<PersonRef[]>([]);
const students = ref<PersonRef[]>([]);
const filters = reactive<{ academicSessionId: number | null; courseId: number | null }>({
  academicSessionId: null,
  courseId: null,
});
const loading = ref(true);
const saving = ref(false);
const editingId = ref<number | null>(null);
const form = ref<Form | null>(null);
const rosterBatch = ref<BatchDto | null>(null);
const roster = ref<BatchStudentDto[]>([]);
const toEnroll = ref<number[]>([]);

const lookup = <T extends { id: number; name: string }>(list: T[], id: number | null) =>
  list.find((x) => x.id === id)?.name ?? (id ? `#${id}` : '');
const courseName = (id: number) => lookup(courses.value, id);
const branchName = (id: number) => lookup(branches.value, id);
const sessionName = (id: number) => lookup(sessions.value, id);
const subjectName = (id: number) => lookup(subjects.value, id);
const courseBranches = computed(() => {
  const c = courses.value.find((x) => x.id === form.value?.courseId);
  return c ? branches.value.filter((b) => c.branchIds.includes(b.id)) : branches.value;
});
const availableStudents = computed(() => {
  const enrolled = new Set(roster.value.filter((e) => e.status === 'active').map((e) => e.studentUserId));
  return students.value.filter((s) => !enrolled.has(s.id));
});

async function load() {
  loading.value = true;
  try {
    const [page, ss, cs, bs, subs, ts] = await Promise.all([
      academicsApi.batches({ ...filters }),
      academicsApi.sessions(),
      academicsApi.courses({ templates: 'false' }),
      academicsApi.branches(),
      academicsApi.subjects(),
      academicsApi.teachers(),
    ]);
    batches.value = page.items;
    sessions.value = ss;
    courses.value = cs.items;
    branches.value = bs;
    subjects.value = subs;
    teachers.value = ts;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

function openEditor(b?: BatchDto) {
  editingId.value = b?.id ?? null;
  form.value = {
    name: b?.name ?? '',
    code: b?.code ?? '',
    courseId: b?.courseId ?? filters.courseId,
    branchId: b?.branchId ?? null,
    academicSessionId: b?.academicSessionId ?? sessions.value.find((s) => s.isCurrent)?.id ?? null,
    capacity: b?.capacity ?? 30,
    startDate: b?.startDate ?? isoToday(),
    endDate: b?.endDate ?? '',
    mode: b?.mode ?? 'offline',
    status: b?.status ?? 'planned',
    teachers: (b?.teachers ?? []).map((t) => ({ teacherUserId: t.teacherUserId, subjectId: t.subjectId })),
  };
}

function onCourse() {
  const c = courses.value.find((x) => x.id === form.value?.courseId);
  if (form.value && c) {
    form.value.mode = c.mode;
    if (form.value.branchId && !c.branchIds.includes(form.value.branchId)) form.value.branchId = null;
  }
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  const { teachers: ts, ...f } = form.value;
  const teacherList = ts
    .filter((t) => t.teacherUserId)
    .map((t) => ({ teacherUserId: t.teacherUserId!, subjectId: t.subjectId }));
  try {
    const body = { ...f, capacity: Number(f.capacity), endDate: f.endDate || null };
    if (editingId.value) {
      await academicsApi.saveBatch(body, editingId.value);
      await academicsApi.setTeachers(editingId.value, teacherList);
    } else await academicsApi.saveBatch({ ...body, teachers: teacherList });
    form.value = null;
    await toast('Batch saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(b: BatchDto) {
  const alert = await alertController.create({
    header: `Delete ${b.name}?`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () => academicsApi.removeBatch(b.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

async function loadRoster() {
  if (rosterBatch.value) roster.value = await academicsApi.roster(rosterBatch.value.id);
}

async function openRoster(b: BatchDto) {
  rosterBatch.value = b;
  toEnroll.value = [];
  try {
    await loadRoster();
    if (auth.can('academics.edit') && !students.value.length) students.value = await academicsApi.students();
  } catch (e) {
    await toastError(e);
  }
}

async function enroll() {
  if (!rosterBatch.value) return;
  try {
    await academicsApi.enroll(rosterBatch.value.id, toEnroll.value);
    toEnroll.value = [];
    await loadRoster();
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function unenroll(studentUserId: number) {
  if (!rosterBatch.value) return;
  try {
    await academicsApi.unenroll(rosterBatch.value.id, studentUserId);
    await loadRoster();
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>

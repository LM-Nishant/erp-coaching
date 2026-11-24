<template>
  <AppPage title="Course access grants" :on-refresh="load">
    <p class="muted">
      Learners normally get paid content through their batch enrolment (or fee payment once the fees module is
      enabled). Use a grant for scholarships, demos or manual exceptions.
    </p>
    <form @submit.prevent="create">
      <ion-list>
        <ion-item>
          <ion-input
            v-model="search"
            label="Student (search by name or mobile)"
            label-placement="stacked"
            :debounce="300"
            @ion-input="findStudents"
          />
        </ion-item>
        <ion-item v-if="students.length">
          <ion-select v-model="form.studentUserId" label="Pick student" label-placement="stacked">
            <ion-select-option v-for="s in students" :key="s.id" :value="s.id"
              >{{ s.name }} ({{ s.mobile }})</ion-select-option
            >
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="form.courseId" label="Course" label-placement="stacked">
            <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.validUntil"
            type="date"
            label="Valid until (blank = lifetime)"
            label-placement="stacked"
          />
        </ion-item>
        <ion-item>
          <ion-input v-model="form.note" label="Note" label-placement="stacked" :maxlength="500" />
        </ion-item>
      </ion-list>
      <ion-button expand="block" type="submit" :disabled="!form.studentUserId || !form.courseId"
        >Grant access</ion-button
      >
    </form>

    <ion-list>
      <ion-list-header><ion-label>Active grants</ion-label></ion-list-header>
      <ion-item v-for="g in grants" :key="g.id">
        <ion-label>
          <h3>{{ g.studentName }} → {{ g.courseName }}</h3>
          <p>
            {{ g.validUntil ? `until ${formatDate(g.validUntil)}` : 'lifetime' }}
            <span v-if="g.note"> · {{ g.note }}</span>
          </p>
        </ion-label>
        <ion-button slot="end" fill="clear" color="danger" @click="revoke(g.id)">Revoke</ion-button>
      </ion-item>
      <ion-item v-if="!grants.length"><ion-label class="muted">No manual grants.</ion-label></ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { formatDate } from '@/core/format';
import { reactive, ref } from 'vue';
import {
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSelect,
  IonSelectOption,
  onIonViewWillEnter,
} from '@ionic/vue';
import type { CourseDto, LmsGrantDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { academicsApi, type PersonRef } from '@/modules/academics/api';
import { lmsApi } from './api';

const grants = ref<LmsGrantDto[]>([]);
const courses = ref<CourseDto[]>([]);
const students = ref<PersonRef[]>([]);
const search = ref('');
const form = reactive({
  studentUserId: null as number | null,
  courseId: null as number | null,
  validUntil: '',
  note: '',
});

async function load() {
  try {
    grants.value = (await lmsApi.grants()).items;
  } catch (e) {
    await toastError(e);
  }
}

async function findStudents() {
  if (search.value.trim().length < 2) return;
  students.value = await academicsApi.students(search.value.trim()).catch(() => []);
}

async function create() {
  try {
    await lmsApi.createGrant({
      studentUserId: form.studentUserId!,
      courseId: form.courseId!,
      validUntil: form.validUntil ? new Date(`${form.validUntil}T23:59:59`).toISOString() : null,
      note: form.note || null,
    });
    Object.assign(form, { studentUserId: null, validUntil: '', note: '' });
    await toast('Access granted');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function revoke(id: number) {
  try {
    await lmsApi.revokeGrant(id);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onIonViewWillEnter(async () => {
  courses.value = (await academicsApi.courses().catch(() => ({ items: [] as CourseDto[] }))).items;
  await load();
});
</script>

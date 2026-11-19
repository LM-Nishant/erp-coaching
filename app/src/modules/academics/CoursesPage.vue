<template>
  <AppPage title="Courses" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'academics.create'" @click="openCategories">Categories</ion-button>
      <ion-button v-can="'academics.create'" aria-label="New course" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar v-model="search" :debounce="300" @ion-input="load" />
    <ion-segment v-model="tab" @ion-change="load">
      <ion-segment-button value="false"><ion-label>Courses</ion-label></ion-segment-button>
      <ion-segment-button value="true"><ion-label>Templates</ion-label></ion-segment-button>
    </ion-segment>

    <ion-list>
      <ion-item v-for="c in courses" :key="c.id">
        <ion-label>
          <h2>
            {{ c.name }} <ion-badge color="medium">{{ c.code }}</ion-badge>
            <ion-badge color="tertiary">{{ c.mode }}</ion-badge>
            <ion-badge v-if="c.status !== 'active'" color="medium">{{ c.status }}</ion-badge>
          </h2>
          <p>
            {{ categoryName(c.categoryId) }}
            <span v-if="c.durationValue"> · {{ c.durationValue }} {{ c.durationUnit }}</span>
            · {{ c.subjectIds.length }} subject(s)
            <span v-if="c.branchIds.length"> · {{ c.branchIds.map(branchName).join(', ') }}</span>
          </p>
        </ion-label>
        <ion-button slot="end" fill="clear" :router-link="`/academics/syllabus?courseId=${c.id}`"
          >Syllabus</ion-button
        >
        <ion-button
          slot="end"
          v-can="'academics.create'"
          fill="clear"
          :aria-label="`Create a course from ${c.name}`"
          @click="openClone(c)"
          ><ion-icon slot="icon-only" :icon="copyOutline"
        /></ion-button>
        <ion-button
          slot="end"
          v-can="'academics.edit'"
          fill="clear"
          :aria-label="`Edit ${c.name}`"
          @click="openEditor(c)"
          ><ion-icon slot="icon-only" :icon="createOutline"
        /></ion-button>
        <ion-button
          slot="end"
          v-can="'academics.delete'"
          fill="clear"
          color="danger"
          :aria-label="`Delete ${c.name}`"
          @click="remove(c)"
          ><ion-icon slot="icon-only" :icon="trashOutline"
        /></ion-button>
      </ion-item>
      <ion-item v-if="!loading && !courses.length"
        ><ion-label class="muted">Nothing here yet.</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit course' : 'New course' }}</ion-title>
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
              <ion-select v-model="form.categoryId" label="Category" label-placement="stacked">
                <ion-select-option :value="null">None</ion-select-option>
                <ion-select-option v-for="c in categories" :key="c.id" :value="c.id">{{
                  c.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.mode" label="Mode" label-placement="stacked">
                <ion-select-option v-for="m in COURSE_MODES" :key="m" :value="m">{{ m }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-input
                v-model.number="form.durationValue"
                type="number"
                min="1"
                label="Duration"
                label-placement="stacked"
              />
              <ion-select
                slot="end"
                v-model="form.durationUnit"
                aria-label="Duration unit"
                interface="popover"
              >
                <ion-select-option v-for="u in DURATION_UNITS" :key="u" :value="u">{{ u }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.branchIds"
                label="Offered at branches"
                label-placement="stacked"
                multiple
              >
                <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.subjectIds" label="Subjects" label-placement="stacked" multiple>
                <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
                  s.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item><ion-toggle v-model="form.isTemplate">Course template</ion-toggle></ion-item>
            <ion-item>
              <ion-select v-model="form.status" label="Status" label-placement="stacked">
                <ion-select-option value="active">Active</ion-select-option>
                <ion-select-option value="archived">Archived</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-textarea
                v-model="form.description"
                label="Description"
                label-placement="stacked"
                auto-grow
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!clone" @did-dismiss="clone = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Create from “{{ clone?.source.name }}”</ion-title>
          <ion-buttons slot="end"><ion-button @click="clone = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="clone" @submit.prevent="saveClone">
          <ion-list>
            <ion-item
              ><ion-input v-model="clone.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input v-model="clone.code" label="Code" label-placement="stacked" required
            /></ion-item>
            <ion-item>
              <ion-select
                v-model="clone.branchIds"
                label="Offered at branches"
                label-placement="stacked"
                multiple
              >
                <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Create course</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="showCategories" @did-dismiss="showCategories = false">
      <ion-header>
        <ion-toolbar>
          <ion-title>Course categories</ion-title>
          <ion-buttons slot="end"><ion-button @click="showCategories = false">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <ion-list>
          <ion-item v-for="c in categories" :key="c.id">
            <ion-label>{{ c.name }}</ion-label>
            <ion-button
              slot="end"
              v-can="'academics.delete'"
              fill="clear"
              color="danger"
              :aria-label="`Delete category ${c.name}`"
              @click="removeCategory(c.id)"
              ><ion-icon slot="icon-only" :icon="trashOutline"
            /></ion-button>
          </ion-item>
          <ion-item>
            <ion-input v-model="newCategory" placeholder="New category" aria-label="New category" />
            <ion-button slot="end" :disabled="!newCategory.trim()" @click="addCategory">Add</ion-button>
          </ion-item>
        </ion-list>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
  IonModal,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, copyOutline, createOutline, trashOutline } from 'ionicons/icons';
import {
  COURSE_MODES,
  DURATION_UNITS,
  type CourseCategoryDto,
  type CourseDto,
  type SubjectDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { academicsApi, type BranchRef } from './api';

type Form = Omit<CourseDto, 'id' | 'templateId'>;

const courses = ref<CourseDto[]>([]);
const categories = ref<CourseCategoryDto[]>([]);
const subjects = ref<SubjectDto[]>([]);
const branches = ref<BranchRef[]>([]);
const search = ref('');
const tab = ref<'true' | 'false'>('false');
const loading = ref(true);
const saving = ref(false);
const editingId = ref<number | null>(null);
const form = ref<Form | null>(null);
const clone = ref<{ source: CourseDto; name: string; code: string; branchIds: number[] } | null>(null);
const showCategories = ref(false);
const newCategory = ref('');

const categoryName = (id: number | null) =>
  categories.value.find((c) => c.id === id)?.name ?? 'Uncategorised';
const branchName = (id: number) => branches.value.find((b) => b.id === id)?.name ?? `#${id}`;

async function load() {
  loading.value = true;
  try {
    const [page, cats, subs, brs] = await Promise.all([
      academicsApi.courses({ search: search.value, templates: tab.value }),
      academicsApi.categories(),
      academicsApi.subjects(),
      branches.value.length ? Promise.resolve(branches.value) : academicsApi.branches(),
    ]);
    courses.value = page.items;
    categories.value = cats;
    subjects.value = subs;
    branches.value = brs;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

function openEditor(c?: CourseDto) {
  editingId.value = c?.id ?? null;
  form.value = {
    name: c?.name ?? '',
    code: c?.code ?? '',
    categoryId: c?.categoryId ?? null,
    description: c?.description ?? '',
    mode: c?.mode ?? 'offline',
    durationValue: c?.durationValue ?? null,
    durationUnit: c?.durationUnit ?? 'months',
    isTemplate: c?.isTemplate ?? tab.value === 'true',
    status: c?.status ?? 'active',
    branchIds: [...(c?.branchIds ?? [])],
    subjectIds: [...(c?.subjectIds ?? [])],
  };
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  const f = form.value;
  const durationValue = f.durationValue ? Number(f.durationValue) : null;
  try {
    await academicsApi.saveCourse(
      {
        ...f,
        description: f.description || null,
        durationValue,
        durationUnit: durationValue ? f.durationUnit : null,
        branchIds: f.isTemplate ? [] : f.branchIds,
      },
      editingId.value ?? undefined,
    );
    form.value = null;
    await toast('Course saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

function openClone(c: CourseDto) {
  clone.value = { source: c, name: `${c.name} (copy)`, code: `${c.code}-2`.slice(0, 30), branchIds: [] };
}

async function saveClone() {
  if (!clone.value) return;
  saving.value = true;
  try {
    const { source, ...body } = clone.value;
    await academicsApi.cloneCourse(source.id, body);
    clone.value = null;
    tab.value = 'false';
    await toast('Course created');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(c: CourseDto) {
  const alert = await alertController.create({
    header: `Delete ${c.name}?`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () => academicsApi.removeCourse(c.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

function openCategories() {
  showCategories.value = true;
}

async function addCategory() {
  try {
    await academicsApi.saveCategory({ name: newCategory.value.trim() });
    newCategory.value = '';
    categories.value = await academicsApi.categories();
  } catch (e) {
    await toastError(e);
  }
}

async function removeCategory(id: number) {
  try {
    await academicsApi.removeCategory(id);
    categories.value = await academicsApi.categories();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>

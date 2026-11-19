<template>
  <AppPage title="Syllabus" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'academics.create'" aria-label="Add subject" @click="addSubject"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-item lines="none">
      <ion-select v-model="courseId" label="Course" interface="popover" @ion-change="load">
        <ion-select-option :value="null">All subjects</ion-select-option>
        <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
      </ion-select>
    </ion-item>

    <ion-accordion-group @ion-change="onOpen">
      <ion-accordion v-for="s in subjects" :key="s.id" :value="String(s.id)">
        <ion-item slot="header">
          <ion-label>
            <h2>
              {{ s.name }} <ion-badge v-if="s.code" color="medium">{{ s.code }}</ion-badge>
            </h2>
          </ion-label>
        </ion-item>
        <div slot="content" class="ion-padding-start">
          <ion-list>
            <template v-for="ch in chapters[s.id] ?? []" :key="ch.id">
              <ion-item>
                <ion-label
                  ><strong>{{ ch.sortOrder }}. {{ ch.name }}</strong></ion-label
                >
                <ion-button
                  slot="end"
                  v-can="'academics.create'"
                  fill="clear"
                  size="small"
                  @click="addTopic(s.id, ch.id)"
                  >+ Topic</ion-button
                >
                <ion-button
                  slot="end"
                  v-can="'academics.edit'"
                  fill="clear"
                  size="small"
                  :aria-label="`Rename ${ch.name}`"
                  @click="renameChapter(s.id, ch)"
                  ><ion-icon slot="icon-only" :icon="createOutline"
                /></ion-button>
                <ion-button
                  slot="end"
                  v-can="'academics.delete'"
                  fill="clear"
                  size="small"
                  color="danger"
                  :aria-label="`Delete ${ch.name}`"
                  @click="run(s.id, () => academicsApi.removeChapter(ch.id))"
                  ><ion-icon slot="icon-only" :icon="trashOutline"
                /></ion-button>
              </ion-item>
              <ion-item v-for="t in ch.topics" :key="t.id" class="topic">
                <ion-label>
                  {{ t.name }}
                  <p v-if="t.durationMinutes">{{ t.durationMinutes }} min</p>
                </ion-label>
                <ion-button
                  slot="end"
                  v-can="'academics.delete'"
                  fill="clear"
                  size="small"
                  color="danger"
                  :aria-label="`Delete ${t.name}`"
                  @click="run(s.id, () => academicsApi.removeTopic(t.id))"
                  ><ion-icon slot="icon-only" :icon="trashOutline"
                /></ion-button>
              </ion-item>
            </template>
            <ion-item v-if="chapters[s.id] && !chapters[s.id].length"
              ><ion-label class="muted">No chapters yet.</ion-label></ion-item
            >
            <ion-item v-can="'academics.create'" lines="none">
              <ion-button fill="outline" size="small" @click="addChapter(s.id)">Add chapter</ion-button>
            </ion-item>
          </ion-list>
        </div>
      </ion-accordion>
    </ion-accordion-group>
    <p v-if="!loading && !subjects.length" class="muted ion-padding">No subjects yet.</p>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonAccordion,
  IonAccordionGroup,
  IonBadge,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSelect,
  IonSelectOption,
  alertController,
  type AccordionGroupCustomEvent,
} from '@ionic/vue';
import { add, createOutline, trashOutline } from 'ionicons/icons';
import type { CourseDto, SubjectDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { academicsApi, type ChapterWithTopics } from './api';

const route = useRoute();
const courses = ref<CourseDto[]>([]);
const subjects = ref<SubjectDto[]>([]);
const chapters = reactive<Record<number, ChapterWithTopics[]>>({});
const courseId = ref<number | null>(route.query.courseId ? Number(route.query.courseId) : null);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    if (!courses.value.length) courses.value = (await academicsApi.courses()).items;
    subjects.value = await academicsApi.subjects(courseId.value ?? undefined);
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

async function loadChapters(subjectId: number) {
  chapters[subjectId] = await academicsApi.chapters(subjectId);
}

function onOpen(ev: AccordionGroupCustomEvent) {
  const v = ev.detail.value as string | undefined;
  if (v) loadChapters(Number(v)).catch(toastError);
}

async function run(subjectId: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    await loadChapters(subjectId);
  } catch (e) {
    await toastError(e);
  }
}

async function prompt(
  header: string,
  inputs: { name: string; placeholder: string; type?: 'text' | 'number'; value?: string }[],
) {
  const alert = await alertController.create({
    header,
    inputs,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Save', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: Record<string, string> }>();
  return role === 'confirm' ? (data?.values ?? null) : null;
}

async function addSubject() {
  const v = await prompt('New subject', [
    { name: 'name', placeholder: 'Name' },
    { name: 'code', placeholder: 'Code (optional)' },
  ]);
  if (!v?.name) return;
  try {
    await academicsApi.saveSubject({ name: v.name, code: v.code || null });
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function addChapter(subjectId: number) {
  const v = await prompt('New chapter', [{ name: 'name', placeholder: 'Chapter name' }]);
  if (!v?.name) return;
  await run(subjectId, () =>
    academicsApi.saveChapter({ subjectId, name: v.name, sortOrder: (chapters[subjectId]?.length ?? 0) + 1 }),
  );
}

async function renameChapter(subjectId: number, ch: ChapterWithTopics) {
  const v = await prompt('Rename chapter', [{ name: 'name', placeholder: 'Chapter name', value: ch.name }]);
  if (!v?.name) return;
  await run(subjectId, () => academicsApi.saveChapter({ name: v.name }, ch.id));
}

async function addTopic(subjectId: number, chapterId: number) {
  const v = await prompt('New topic', [
    { name: 'name', placeholder: 'Topic name' },
    { name: 'durationMinutes', placeholder: 'Planned minutes (optional)', type: 'number' },
  ]);
  if (!v?.name) return;
  await run(subjectId, () =>
    academicsApi.saveTopic({
      chapterId,
      name: v.name,
      durationMinutes: v.durationMinutes ? Number(v.durationMinutes) : null,
    }),
  );
}

onMounted(load);
</script>

<style scoped>
.topic {
  --padding-start: 32px;
}
</style>

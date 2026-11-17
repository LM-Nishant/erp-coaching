<template>
  <AppPage
    :title="id ? 'Edit homework' : 'New homework'"
    :back-href="id ? `/lms/homework/${id}` : '/lms/homework'"
  >
    <form @submit.prevent="save">
      <ion-list>
        <ion-item>
          <ion-select v-model="form.batchId" label="Batch" label-placement="stacked" :disabled="locked">
            <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="form.subjectId" label="Subject" label-placement="stacked">
            <ion-select-option :value="null">—</ion-select-option>
            <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
              s.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input v-model="form.title" label="Title" label-placement="stacked" :maxlength="200" required />
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="form.instructions"
            label="Instructions"
            label-placement="stacked"
            :auto-grow="true"
            :rows="5"
            :maxlength="10000"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.dueAt"
            type="datetime-local"
            label="Due"
            label-placement="stacked"
            required
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="form.maxMarks"
            type="number"
            label="Maximum marks (optional)"
            label-placement="stacked"
            :min="0"
          />
        </ion-item>
        <ion-item>
          <ion-toggle v-model="form.allowLate">Accept late submissions</ion-toggle>
        </ion-item>
        <ion-item>
          <ion-label>
            <p>Attachments</p>
            <p v-for="f in files" :key="f.id">
              {{ f.originalName }}
              <ion-button
                size="small"
                fill="clear"
                color="danger"
                @click="files = files.filter((x) => x.id !== f.id)"
                >Remove</ion-button
              >
            </p>
            <input type="file" multiple :disabled="uploading" @change="pick" />
          </ion-label>
        </ion-item>
      </ion-list>
      <ion-button expand="block" type="submit" :disabled="saving || uploading || !form.batchId"
        >Save draft</ion-button
      >
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonToggle,
  onIonViewWillEnter,
} from '@ionic/vue';
import type { BatchDto, LmsFileRef, SubjectDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { academicsApi } from '@/modules/academics/api';
import { lmsApi } from './api';

const route = useRoute();
const router = useRouter();
const id = computed(() => (route.params.id ? Number(route.params.id) : undefined));
const batches = ref<BatchDto[]>([]);
const subjects = ref<SubjectDto[]>([]);
const files = ref<LmsFileRef[]>([]);
const saving = ref(false);
const uploading = ref(false);
const locked = ref(false);

const tomorrow = () => {
  const d = new Date(Date.now() + 86400_000);
  d.setHours(18, 0, 0, 0);
  return toLocal(d.toISOString());
};
function toLocal(iso: string) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const form = reactive({
  batchId: null as number | null,
  subjectId: null as number | null,
  title: '',
  instructions: '',
  dueAt: tomorrow(),
  maxMarks: null as number | null,
  allowLate: false,
});

watch(
  () => form.batchId,
  async (batchId) => {
    const courseId = batches.value.find((b) => b.id === batchId)?.courseId;
    subjects.value = courseId ? await academicsApi.subjects(courseId).catch(() => []) : [];
  },
);

async function pick(ev: Event) {
  const input = ev.target as HTMLInputElement;
  uploading.value = true;
  try {
    for (const f of Array.from(input.files ?? [])) files.value.push(await lmsApi.uploadFile(f));
  } catch (e) {
    await toastError(e);
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

async function save() {
  saving.value = true;
  try {
    const saved = await lmsApi.saveAssignment(
      {
        ...form,
        batchId: form.batchId!,
        instructions: form.instructions || null,
        maxMarks: form.maxMarks || null,
        dueAt: new Date(form.dueAt).toISOString(),
        fileIds: files.value.map((f) => f.id),
      },
      id.value,
    );
    await toast('Saved');
    await router.replace(`/lms/homework/${saved.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onIonViewWillEnter(async () => {
  batches.value = (await academicsApi.batches().catch(() => ({ items: [] as BatchDto[] }))).items;
  if (!id.value) return;
  try {
    const a = await lmsApi.assignment(id.value);
    locked.value = a.status !== 'draft';
    Object.assign(form, {
      batchId: a.batchId,
      title: a.title,
      instructions: a.instructions ?? '',
      dueAt: toLocal(a.dueAt),
      maxMarks: a.maxMarks,
      allowLate: a.allowLate,
    });
    await new Promise((r) => setTimeout(r, 0));
    form.subjectId = a.subjectId;
    files.value = a.files;
  } catch (e) {
    await toastError(e);
  }
});
</script>

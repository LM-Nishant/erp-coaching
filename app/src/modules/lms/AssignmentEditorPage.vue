<template>
  <AppPage
    :title="id ? t('lms.homeworkForm.editTitle') : t('lms.homeworkForm.newTitle')"
    :back-href="id ? `/lms/homework/${id}` : '/lms/homework'"
  >
    <form @submit.prevent="save(!locked && !id)">
      <p class="field-label">{{ t('lms.homeworkForm.batch') }}</p>
      <div class="chips" role="radiogroup" :aria-label="t('lms.homeworkForm.batch')">
        <button
          v-for="b in batches"
          :key="b.id"
          type="button"
          role="radio"
          :aria-checked="form.batchId === b.id"
          :class="['chip', { on: form.batchId === b.id }]"
          :disabled="locked"
          @click="form.batchId = b.id"
        >
          {{ b.name }}
        </button>
      </div>

      <ion-list lines="full">
        <ion-item>
          <ion-input
            v-model="form.title"
            :label="t('lms.homeworkForm.title')"
            label-placement="stacked"
            :placeholder="t('lms.homeworkForm.titlePlaceholder')"
            :maxlength="200"
            required
          />
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="form.instructions"
            :label="t('lms.homeworkForm.instructions')"
            label-placement="stacked"
            :placeholder="t('lms.homeworkForm.instructionsPlaceholder')"
            :auto-grow="true"
            :rows="3"
            :maxlength="10000"
          />
        </ion-item>
      </ion-list>

      <div class="files">
        <div v-for="f in files" :key="f.id" class="file">
          <ion-icon :icon="documentAttachOutline" aria-hidden="true" />
          <span>{{ f.originalName }}</span>
          <ion-button
            fill="clear"
            color="danger"
            :aria-label="t('lms.homeworkForm.remove', { name: f.originalName })"
            @click="files = files.filter((x) => x.id !== f.id)"
            ><ion-icon slot="icon-only" :icon="closeCircle"
          /></ion-button>
        </div>
        <label class="attach">
          <ion-icon :icon="cameraOutline" aria-hidden="true" />
          {{ uploading ? t('lms.homeworkForm.uploading') : t('lms.homeworkForm.attach') }}
          <input
            type="file"
            multiple
            accept="image/*,application/pdf,.doc,.docx"
            :disabled="uploading"
            @change="pick"
          />
        </label>
      </div>

      <p class="field-label">{{ t('lms.homeworkForm.due') }}</p>
      <div class="chips" role="radiogroup" :aria-label="t('lms.homeworkForm.due')">
        <button
          v-for="c in DUE_CHOICES"
          :key="c"
          type="button"
          role="radio"
          :aria-checked="dueChoice === c"
          :class="['chip', { on: dueChoice === c }]"
          @click="form.dueAt = dueAt(c)"
        >
          {{ t(`lms.homeworkForm.dueChoices.${c}`) }}
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="dueChoice === null"
          :class="['chip', { on: dueChoice === null }]"
          @click="pickDate = true"
        >
          {{ dueChoice === null ? formatDateTime(form.dueAt) : t('lms.homeworkForm.dueChoices.pick') }}
        </button>
      </div>
      <ion-item v-if="pickDate || dueChoice === null" lines="none">
        <ion-input
          v-model="form.dueAt"
          type="datetime-local"
          :label="t('lms.homeworkForm.dueExact')"
          label-placement="stacked"
          required
        />
      </ion-item>

      <FormSection v-model:open="moreOpen" advanced>
        <ion-item>
          <ion-select
            v-model="form.subjectId"
            :label="t('lms.homeworkForm.subject')"
            label-placement="stacked"
          >
            <ion-select-option :value="null">—</ion-select-option>
            <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
              s.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="form.maxMarks"
            type="number"
            :label="t('lms.homeworkForm.maxMarks')"
            label-placement="stacked"
            :min="0"
          />
        </ion-item>
        <ion-item>
          <ion-toggle v-model="form.allowLate">{{ t('lms.homeworkForm.allowLate') }}</ion-toggle>
        </ion-item>
      </FormSection>

      <p v-if="!locked && !id" class="hint">{{ t('lms.homeworkForm.publishHint') }}</p>
      <div class="actions">
        <ion-button
          v-if="!locked && !id"
          fill="outline"
          size="large"
          :disabled="!ready"
          @click="save(false)"
          >{{ t('lms.homeworkForm.saveDraft') }}</ion-button
        >
        <ion-button type="submit" size="large" :disabled="!ready">{{
          locked || id ? t('lms.homeworkForm.saveChanges') : t('lms.homeworkForm.publish')
        }}</ion-button>
      </div>
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonList,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonToggle,
  onIonViewWillEnter,
} from '@ionic/vue';
import { cameraOutline, closeCircle, documentAttachOutline } from 'ionicons/icons';
import type { BatchDto, LmsFileRef, SubjectDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import FormSection from '@/components/FormSection.vue';
import { formatDateTime } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { academicsApi } from '@/modules/academics/api';
import { lmsApi } from './api';
import { dueAt, dueChoiceOf, toLocalInput, type DueChoice } from './homework';

const DUE_CHOICES: DueChoice[] = ['tomorrow', 'twoDays', 'nextWeek'];

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const id = computed(() => (route.params.id ? Number(route.params.id) : undefined));
const batches = ref<BatchDto[]>([]);
const subjects = ref<SubjectDto[]>([]);
const files = ref<LmsFileRef[]>([]);
const saving = ref(false);
const uploading = ref(false);
const locked = ref(false);
const pickDate = ref(false);
const moreOpen = ref(false);

const form = reactive({
  batchId: null as number | null,
  subjectId: null as number | null,
  title: '',
  instructions: '',
  dueAt: dueAt('tomorrow'),
  maxMarks: null as number | null,
  allowLate: true,
});
const dueChoice = computed(() => (pickDate.value ? null : dueChoiceOf(form.dueAt)));
const ready = computed(
  () => !saving.value && !uploading.value && !!form.batchId && !!form.title.trim() && !!form.dueAt,
);

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

/** Saves; a new homework is published straight away unless `publish` is false (draft). */
async function save(publish: boolean) {
  if (!ready.value) return;
  saving.value = true;
  try {
    let saved = await lmsApi.saveAssignment(
      {
        ...form,
        title: form.title.trim(),
        batchId: form.batchId!,
        instructions: form.instructions || null,
        maxMarks: form.maxMarks || null,
        dueAt: new Date(form.dueAt).toISOString(),
        fileIds: files.value.map((f) => f.id),
      },
      id.value,
    );
    if (publish) saved = await lmsApi.publishAssignment(saved.id);
    await toast(publish ? t('lms.homeworkForm.published') : t('lms.homeworkForm.saved'));
    await router.replace(`/lms/homework/${saved.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onIonViewWillEnter(async () => {
  batches.value = (
    await academicsApi.batches({ status: 'active' }).catch(() => ({ items: [] as BatchDto[] }))
  ).items;
  if (!id.value) {
    if (batches.value.length === 1 && !form.batchId) form.batchId = batches.value[0].id;
    return;
  }
  try {
    const a = await lmsApi.assignment(id.value);
    locked.value = a.status !== 'draft';
    if (!batches.value.some((b) => b.id === a.batchId))
      batches.value.push({ id: a.batchId, name: a.batchName ?? `#${a.batchId}` } as BatchDto);
    Object.assign(form, {
      batchId: a.batchId,
      title: a.title,
      instructions: a.instructions ?? '',
      dueAt: toLocalInput(new Date(a.dueAt)),
      maxMarks: a.maxMarks,
      allowLate: a.allowLate,
    });
    moreOpen.value = !!a.maxMarks || !!a.subjectId;
    await new Promise((r) => setTimeout(r, 0));
    form.subjectId = a.subjectId;
    files.value = a.files;
  } catch (e) {
    await toastError(e);
  }
});
</script>

<style scoped>
.field-label {
  margin: 16px 16px 8px;
  color: var(--ion-color-medium-shade);
  font-size: 14px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 16px 8px;
}
.chip {
  min-height: var(--app-tap-target);
  padding: 0 16px;
  border: 1px solid var(--ion-color-medium-tint);
  border-radius: 24px;
  background: none;
  color: var(--ion-text-color);
  font: inherit;
  cursor: pointer;
}
.chip.on {
  border-color: var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary-shade);
  font-weight: 600;
}
.chip:disabled {
  opacity: 0.5;
  cursor: default;
}
.files {
  padding: 12px 16px 0;
}
.file {
  display: flex;
  align-items: center;
  gap: 8px;
}
.file span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attach {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 56px;
  border: 2px dashed var(--ion-color-medium-tint);
  border-radius: 12px;
  color: var(--ion-color-primary-shade);
  font-weight: 600;
  cursor: pointer;
}
.attach ion-icon {
  font-size: 22px;
}
.attach input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.hint {
  margin: 16px 16px 0;
  color: var(--ion-color-medium-shade);
  font-size: 14px;
}
.actions {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
}
.actions ion-button {
  flex: 1;
  text-transform: none;
}
</style>

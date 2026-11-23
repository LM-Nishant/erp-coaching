<template>
  <AppPage
    :title="id ? t('lms.contentForm.editTitle') : t('lms.contentForm.newTitle')"
    back-href="/lms/content"
  >
    <form @submit.prevent="submit">
      <p class="field-label">{{ t('lms.contentForm.type') }}</p>
      <div class="chips" role="radiogroup" :aria-label="t('lms.contentForm.type')">
        <button
          v-for="ty in LMS_RESOURCE_TYPES"
          :key="ty"
          type="button"
          role="radio"
          :aria-checked="form.type === ty"
          :class="['chip', { on: form.type === ty }]"
          @click="setType(ty)"
        >
          {{ t(`lms.contentForm.types.${ty}`) }}
        </button>
      </div>

      <ion-list lines="full">
        <ion-item v-if="form.type === 'link'">
          <ion-input
            v-model="form.externalUrl"
            :label="t('lms.contentForm.url')"
            label-placement="stacked"
            type="url"
            required
          />
        </ion-item>
      </ion-list>
      <div v-if="form.type !== 'link'" class="upload">
        <label :class="['drop', { done: currentFile && !uploading }]">
          <ion-icon
            :icon="currentFile && !uploading ? checkmarkCircle : cloudUploadOutline"
            aria-hidden="true"
          />
          <span v-if="uploading">{{
            t('lms.contentForm.uploading', { pct: Math.round(uploadPct * 100) })
          }}</span>
          <span v-else-if="currentFile">
            <strong>{{ currentFile.originalName }}</strong> · {{ formatBytes(currentFile.sizeBytes) }}
            <small>{{ t('lms.contentForm.replace') }}</small>
          </span>
          <span v-else>
            <strong>{{
              t(form.type === 'video' ? 'lms.contentForm.pickVideo' : 'lms.contentForm.pickFile')
            }}</strong>
            <small v-if="form.type === 'video'">{{ t('lms.contentForm.videoHint') }}</small>
          </span>
          <input type="file" :accept="accept" :disabled="uploading" @change="pickFile" />
        </label>
        <template v-if="uploading">
          <ion-progress-bar :value="uploadPct" />
          <ion-button fill="clear" color="danger" @click="cancelUpload">{{
            t('lms.contentForm.cancel')
          }}</ion-button>
        </template>
      </div>

      <ion-list lines="full">
        <ion-item>
          <ion-input
            v-model="form.title"
            :label="t('lms.contentForm.title')"
            label-placement="stacked"
            :placeholder="t('lms.contentForm.titlePlaceholder')"
            :maxlength="200"
            required
          />
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.courseId"
            :label="t('lms.contentForm.course')"
            label-placement="stacked"
            interface="popover"
            required
          >
            <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-if="subjects.length">
          <ion-select
            v-model="form.subjectId"
            :label="t('lms.contentForm.subject')"
            label-placement="stacked"
          >
            <ion-select-option :value="null">—</ion-select-option>
            <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
              s.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-if="form.subjectId && chapters.length">
          <ion-select
            v-model="form.chapterId"
            :label="t('lms.contentForm.chapter')"
            label-placement="stacked"
          >
            <ion-select-option :value="null">—</ion-select-option>
            <ion-select-option v-for="c in chapters" :key="c.id" :value="c.id">{{
              c.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-if="form.chapterId && topics.length">
          <ion-select v-model="form.topicId" :label="t('lms.contentForm.topic')" label-placement="stacked">
            <ion-select-option :value="null">—</ion-select-option>
            <ion-select-option v-for="tp in topics" :key="tp.id" :value="tp.id">{{
              tp.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
      </ion-list>

      <FormSection v-model:open="moreOpen" advanced>
        <ion-item>
          <ion-select
            v-model="form.batchIds"
            :label="t('lms.contentForm.batches')"
            label-placement="stacked"
            :multiple="true"
          >
            <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="form.description"
            :label="t('lms.contentForm.description')"
            label-placement="stacked"
            :auto-grow="true"
            :maxlength="5000"
          />
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.access"
            :label="t('lms.contentForm.access')"
            label-placement="stacked"
            interface="popover"
          >
            <ion-select-option value="free">{{ t('lms.contentForm.accessFree') }}</ion-select-option>
            <ion-select-option value="paid">{{ t('lms.contentForm.accessPaid') }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="form.accessDays"
            type="number"
            :label="t('lms.contentForm.accessDays')"
            label-placement="stacked"
            :min="1"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.availableFrom"
            type="datetime-local"
            :label="t('lms.contentForm.availableFrom')"
            label-placement="stacked"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.availableUntil"
            type="datetime-local"
            :label="t('lms.contentForm.availableUntil')"
            label-placement="stacked"
          />
        </ion-item>
        <ion-item v-if="form.type === 'video'">
          <ion-input
            v-model.number="form.durationSeconds"
            type="number"
            :label="t('lms.contentForm.durationSeconds')"
            label-placement="stacked"
            :min="0"
          />
        </ion-item>
        <ion-item v-if="form.type !== 'video' && form.type !== 'link'">
          <ion-toggle v-model="form.downloadable">{{ t('lms.contentForm.downloadable') }}</ion-toggle>
        </ion-item>
        <template v-if="form.type === 'video'">
          <ion-item>
            <ion-toggle v-model="form.offlineAllowed">{{ t('lms.contentForm.offline') }}</ion-toggle>
          </ion-item>
          <ion-item v-if="form.offlineAllowed">
            <ion-input
              v-model.number="form.offlineExpiryHours"
              type="number"
              :label="t('lms.contentForm.offlineHours')"
              label-placement="stacked"
              :min="1"
            />
          </ion-item>
        </template>
        <ion-item>
          <ion-input
            v-model.number="form.sortOrder"
            type="number"
            :label="t('lms.contentForm.sortOrder')"
            label-placement="stacked"
          />
        </ion-item>
      </FormSection>

      <div class="actions">
        <ion-button
          v-if="!id && canPublish"
          fill="outline"
          size="large"
          :disabled="saving || uploading"
          @click="save(false)"
          >{{ t('lms.contentForm.saveDraft') }}</ion-button
        >
        <ion-button type="submit" size="large" :disabled="saving || uploading">{{
          id
            ? t('lms.contentForm.save')
            : canPublish
              ? t('lms.contentForm.publish')
              : t('lms.contentForm.saveDraft')
        }}</ion-button>
      </div>
    </form>

    <template v-if="resource">
      <ion-list>
        <ion-list-header
          ><ion-label>Status: {{ resource.status }}</ion-label></ion-list-header
        >
        <ion-item v-if="resource.type === 'video'">
          <ion-label>
            <p>Streaming: {{ transcodeLabel[resource.transcodeStatus] }}</p>
          </ion-label>
          <ion-button
            slot="end"
            fill="outline"
            :disabled="!resource.file || ['pending', 'processing'].includes(resource.transcodeStatus)"
            @click="act(() => lmsApi.transcode(id!))"
            >Convert to HLS</ion-button
          >
        </ion-item>
      </ion-list>
      <div class="ion-padding-vertical">
        <ion-button
          v-if="resource.status !== 'published'"
          v-can="'lms.publish'"
          @click="act(() => lmsApi.setStatus(id!, 'publish'))"
          >Publish</ion-button
        >
        <ion-button
          v-if="resource.status === 'published'"
          v-can="'lms.publish'"
          fill="outline"
          @click="act(() => lmsApi.setStatus(id!, 'unpublish'))"
          >Unpublish</ion-button
        >
        <ion-button
          v-if="resource.status !== 'archived'"
          v-can="'lms.publish'"
          fill="outline"
          color="medium"
          @click="act(() => lmsApi.setStatus(id!, 'archive'))"
          >Archive</ion-button
        >
        <ion-button :router-link="`/lms/resources/${id}`" fill="outline">Preview</ion-button>
        <ion-button v-can="'lms.delete'" color="danger" fill="clear" @click="remove">Delete</ion-button>
      </div>

      <ion-list v-if="analytics.length">
        <ion-list-header><ion-label>Learner progress</ion-label></ion-list-header>
        <ion-item v-for="a in analytics" :key="a.student.id">
          <ion-label>
            <h3>{{ a.student.name }}</h3>
            <p>
              {{ a.percent }}% · watched {{ formatDuration(a.watchedSeconds) || '0:00' }} · last
              {{ fmtDateTime(a.lastViewedAt) }}
            </p>
          </ion-label>
          <ion-badge v-if="a.completed" slot="end" color="success">completed</ion-badge>
        </ion-item>
      </ion-list>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonProgressBar,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonToggle,
  alertController,
  onIonViewWillEnter,
} from '@ionic/vue';
import {
  LMS_RESOURCE_TYPES,
  type BatchDto,
  type CourseDto,
  type LmsFileRef,
  type LmsResourceAnalyticsRow,
  type LmsResourceDto,
  type LmsResourceInput,
  type SubjectDto,
} from '@erp/shared';
import { checkmarkCircle, cloudUploadOutline } from 'ionicons/icons';
import AppPage from '@/components/AppPage.vue';
import FormSection from '@/components/FormSection.vue';
import { useAuthStore } from '@/stores/auth';
import { toast, toastError } from '@/core/toast';
import { academicsApi, type ChapterWithTopics } from '@/modules/academics/api';
import { fmtDateTime, formatBytes, formatDuration, lmsApi } from './api';
import { chunkedUpload, type UploadHandle } from './chunked-upload';

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const id = computed(() => (route.params.id ? Number(route.params.id) : undefined));

const transcodeLabel: Record<string, string> = {
  none: 'progressive MP4',
  pending: 'HLS conversion queued',
  processing: 'converting to HLS…',
  ready: 'HLS (adaptive)',
  failed: 'HLS conversion failed — streaming MP4',
  unavailable: 'ffmpeg not installed — streaming MP4',
};

const blank = () => ({
  title: '',
  type: 'video' as LmsResourceInput['type'],
  courseId: null as number | null,
  subjectId: null as number | null,
  chapterId: null as number | null,
  topicId: null as number | null,
  batchIds: [] as number[],
  description: '',
  externalUrl: '',
  fileId: null as number | null,
  durationSeconds: null as number | null,
  access: 'paid' as LmsResourceInput['access'],
  accessDays: null as number | null,
  availableFrom: '',
  availableUntil: '',
  downloadable: false,
  offlineAllowed: false,
  offlineExpiryHours: 72,
  sortOrder: 0,
});
const form = reactive(blank());
const moreOpen = ref(false);
const canPublish = computed(() => auth.can('lms.publish'));
const typeFromQuery = () =>
  (LMS_RESOURCE_TYPES as readonly string[]).includes(String(route.query.type))
    ? (route.query.type as LmsResourceInput['type'])
    : 'video';
const setType = (ty: LmsResourceInput['type']) => (form.type = ty);
const resource = ref<LmsResourceDto | null>(null);
const currentFile = ref<LmsFileRef | null>(null);
const analytics = ref<LmsResourceAnalyticsRow[]>([]);
const courses = ref<CourseDto[]>([]);
const subjects = ref<SubjectDto[]>([]);
const chapterTree = ref<ChapterWithTopics[]>([]);
const batches = ref<BatchDto[]>([]);
const saving = ref(false);
const uploading = ref(false);
const uploadPct = ref(0);
let handle: UploadHandle | null = null;
let hydrating = false;

const chapters = computed(() => chapterTree.value);
const topics = computed(() => chapterTree.value.find((c) => c.id === form.chapterId)?.topics ?? []);
const accept = computed(() =>
  form.type === 'video'
    ? 'video/*'
    : form.type === 'ppt'
      ? '.ppt,.pptx,.pdf,.key,.odp'
      : '.pdf,.doc,.docx,.txt,.xls,.xlsx,.png,.jpg,.jpeg,.odt',
);

const toLocal = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

watch(
  () => form.courseId,
  async (courseId) => {
    if (!hydrating) Object.assign(form, { subjectId: null, chapterId: null, topicId: null, batchIds: [] });
    subjects.value = courseId ? await academicsApi.subjects(courseId).catch(() => []) : [];
    batches.value = courseId
      ? (await academicsApi.batches({ courseId }).catch(() => ({ items: [] }))).items
      : [];
  },
);
watch(
  () => form.subjectId,
  async (subjectId) => {
    if (!hydrating) Object.assign(form, { chapterId: null, topicId: null });
    chapterTree.value = subjectId ? await academicsApi.chapters(subjectId).catch(() => []) : [];
  },
);
watch(
  () => form.chapterId,
  () => {
    if (!hydrating) form.topicId = null;
  },
);

async function load() {
  courses.value = (await academicsApi.courses().catch(() => ({ items: [] as CourseDto[] }))).items;
  if (!id.value) {
    Object.assign(form, blank(), { type: typeFromQuery() });
    currentFile.value = null;
    resource.value = null;
    if (courses.value.length === 1) form.courseId = courses.value[0].id;
    return;
  }
  try {
    const r = await lmsApi.resource(id.value);
    resource.value = r;
    currentFile.value = r.file;
    hydrating = true;
    Object.assign(form, {
      ...r,
      description: r.description ?? '',
      externalUrl: r.externalUrl ?? '',
      fileId: r.file?.id ?? null,
      availableFrom: toLocal(r.availableFrom),
      availableUntil: toLocal(r.availableUntil),
    });
    // let the cascading watchers load lists without clearing the saved selections
    await new Promise((res) => setTimeout(res, 0));
    subjects.value = await academicsApi.subjects(r.courseId).catch(() => []);
    batches.value = (await academicsApi.batches({ courseId: r.courseId }).catch(() => ({ items: [] }))).items;
    chapterTree.value = r.subjectId ? await academicsApi.chapters(r.subjectId).catch(() => []) : [];
    Object.assign(form, {
      subjectId: r.subjectId,
      chapterId: r.chapterId,
      topicId: r.topicId,
      batchIds: r.batchIds,
    });
    await new Promise((res) => setTimeout(res, 0));
    hydrating = false;
    moreOpen.value = r.batchIds.length > 0 || !!r.description || !!r.availableFrom || !!r.availableUntil;
    analytics.value = await lmsApi.analytics(id.value).catch(() => []);
  } catch (e) {
    hydrating = false;
    await toastError(e);
  }
}

function readVideoDuration(file: File) {
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.onloadedmetadata = () => {
    if (Number.isFinite(v.duration)) form.durationSeconds = Math.round(v.duration);
    URL.revokeObjectURL(v.src);
  };
  v.src = URL.createObjectURL(file);
}

async function pickFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (form.type === 'video') readVideoDuration(file);
  uploading.value = true;
  uploadPct.value = 0;
  try {
    handle = chunkedUpload(file, (sent, total) => (uploadPct.value = total ? sent / total : 1));
    const ref = await handle.promise;
    currentFile.value = ref;
    form.fileId = ref.id;
    if (!form.title) form.title = file.name.replace(/\.[^.]+$/, '');
  } catch (e) {
    if ((e as Error).name !== 'AbortError') await toastError(e);
  } finally {
    uploading.value = false;
    handle = null;
    input.value = '';
  }
}

function cancelUpload() {
  handle?.abort();
}

const submit = () => save(!id.value && canPublish.value);

/** Saves; a new resource is published straight away when `publish` (needs `lms.publish`). */
async function save(publish: boolean) {
  if (!form.courseId) return toast(t('lms.contentForm.needCourse'), 'warning');
  if (form.type !== 'link' && !form.fileId) return toast(t('lms.contentForm.needFile'), 'warning');
  saving.value = true;
  try {
    const body: Partial<LmsResourceInput> = {
      ...form,
      courseId: form.courseId,
      description: form.description || null,
      externalUrl: form.type === 'link' ? form.externalUrl : null,
      fileId: form.type === 'link' ? null : form.fileId,
      accessDays: form.accessDays || null,
      durationSeconds: form.durationSeconds || null,
      availableFrom: fromLocal(form.availableFrom),
      availableUntil: fromLocal(form.availableUntil),
    };
    const saved = await lmsApi.saveResource(body, id.value);
    if (publish) await lmsApi.setStatus(saved.id, 'publish');
    await toast(publish ? t('lms.contentForm.published') : t('lms.contentForm.saved'));
    if (!id.value) await router.replace(`/lms/content/${saved.id}`);
    else await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function act(fn: () => Promise<LmsResourceDto>) {
  try {
    resource.value = await fn();
    await toast('Updated');
  } catch (e) {
    await toastError(e);
  }
}

async function remove() {
  const a = await alertController.create({
    header: 'Delete resource?',
    message: 'Learner progress for this resource is deleted too.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Delete', role: 'destructive' },
    ],
  });
  await a.present();
  if ((await a.onDidDismiss()).role !== 'destructive') return;
  try {
    await lmsApi.removeResource(id.value!);
    await router.replace('/lms/content');
  } catch (e) {
    await toastError(e);
  }
}

onIonViewWillEnter(load);
onBeforeUnmount(() => handle?.abort());
</script>

<style scoped>
.field-label {
  margin: 8px 16px;
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
.upload {
  padding: 8px 16px;
}
.drop {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 120px;
  padding: 16px;
  border: 2px dashed var(--ion-color-medium-tint);
  border-radius: 14px;
  color: var(--ion-color-primary-shade);
  text-align: center;
  cursor: pointer;
}
.drop.done {
  border-style: solid;
  border-color: var(--ion-color-success);
  color: var(--ion-text-color);
}
.drop ion-icon {
  font-size: 36px;
}
.drop.done ion-icon {
  color: var(--ion-color-success);
}
.drop small {
  display: block;
  color: var(--ion-color-medium-shade);
}
.drop input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
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

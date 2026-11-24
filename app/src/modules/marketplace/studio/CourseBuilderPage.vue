<template>
  <AppPage :title="course?.title ?? 'Course'" :back-href="`/market/studio/${scope}`" :on-refresh="load">
    <template v-if="course">
      <div class="status">
        <ion-badge :color="STATUS_COLORS[course.status]">{{
          MKT_COURSE_STATUS_LABELS[course.status]
        }}</ion-badge>
        <span v-if="course.status === 'in_review'" class="muted"
          >Our team is reviewing this course. Editing is locked; withdraw it from review to make
          changes.</span
        >
        <span v-else-if="course.status === 'published'" class="muted">
          Live on the marketplace.
          <router-link :to="`/market/course/${course.slug}`">View course page</router-link>
        </span>
      </div>
      <ion-note v-if="course.status === 'rejected' && course.reviewNote" color="danger" class="note">
        Changes requested: {{ course.reviewNote }}
      </ion-note>

      <ion-segment v-model="tab" class="tabs">
        <ion-segment-button value="details"><ion-label>Details</ion-label></ion-segment-button>
        <ion-segment-button value="curriculum" data-testid="tab-curriculum"
          ><ion-label>Curriculum</ion-label></ion-segment-button
        >
        <ion-segment-button value="publish" data-testid="tab-publish"
          ><ion-label>Price & publish</ion-label></ion-segment-button
        >
      </ion-segment>

      <!-- Details -->
      <form v-if="tab === 'details'" @submit.prevent="saveDetails">
        <ion-list>
          <ion-item>
            <ion-input
              v-model="details.title"
              label="Title"
              label-placement="stacked"
              :maxlength="160"
              required
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="details.subtitle"
              label="Subtitle"
              label-placement="stacked"
              :maxlength="200"
              data-testid="course-subtitle"
            />
          </ion-item>
          <ion-item>
            <ion-textarea
              v-model="details.description"
              label="Description (at least 50 characters)"
              label-placement="stacked"
              auto-grow
              :rows="5"
              data-testid="course-description"
            />
          </ion-item>
          <ion-item>
            <ion-select
              v-model="details.categoryId"
              label="Category"
              label-placement="stacked"
              interface="popover"
              data-testid="course-category"
              @ion-change="details.subcategoryId = null"
            >
              <ion-select-option v-for="c in categories" :key="c.id" :value="c.id">{{
                c.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item v-if="subcategories.length">
            <ion-select
              v-model="details.subcategoryId"
              label="Subcategory"
              label-placement="stacked"
              interface="popover"
            >
              <ion-select-option :value="null">None</ion-select-option>
              <ion-select-option v-for="c in subcategories" :key="c.id" :value="c.id">{{
                c.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select v-model="details.level" label="Level" label-placement="stacked" interface="popover">
              <ion-select-option v-for="(label, key) in MKT_COURSE_LEVEL_LABELS" :key="key" :value="key">{{
                label
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select
              v-model="details.language"
              label="Language"
              label-placement="stacked"
              interface="popover"
            >
              <ion-select-option v-for="(label, key) in MKT_LANGUAGES" :key="key" :value="key">{{
                label
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-textarea
              v-model="details.outcomes"
              label="What learners will learn (one per line, at least 2)"
              label-placement="stacked"
              auto-grow
              :rows="3"
              data-testid="course-outcomes"
            />
          </ion-item>
          <ion-item>
            <ion-textarea
              v-model="details.requirements"
              label="Requirements (one per line)"
              label-placement="stacked"
              auto-grow
            />
          </ion-item>
          <ion-item>
            <ion-textarea
              v-model="details.audience"
              label="Who this course is for (one per line)"
              label-placement="stacked"
              auto-grow
            />
          </ion-item>
          <ion-item lines="none">
            <div class="field">
              <ion-label>Course image</ion-label>
              <MediaUpload
                :scope="scope"
                kind="image"
                :media="course.thumbnail"
                label="Upload image"
                testid="course-thumbnail"
                @uploaded="(m) => patch({ thumbnailMediaId: m.id })"
              />
            </div>
          </ion-item>
          <ion-item lines="none">
            <div class="field">
              <ion-label>Promo video (optional)</ion-label>
              <MediaUpload
                :scope="scope"
                kind="video"
                :media="course.promo"
                label="Upload promo video"
                @uploaded="(m) => patch({ promoMediaId: m.id })"
              />
            </div>
          </ion-item>
        </ion-list>
        <ion-button type="submit" expand="block" :disabled="busy || locked" data-testid="save-details"
          >Save details</ion-button
        >
      </form>

      <!-- Curriculum -->
      <div v-else-if="tab === 'curriculum'">
        <ion-card v-for="(s, si) in course.sections" :key="s.id" class="section">
          <ion-card-header>
            <div class="section-head">
              <ion-card-subtitle>Section {{ si + 1 }}</ion-card-subtitle>
              <div>
                <ion-button
                  fill="clear"
                  size="small"
                  :disabled="locked || si === 0"
                  aria-label="Move section up"
                  @click="moveSection(si, -1)"
                >
                  <ion-icon slot="icon-only" :icon="arrowUpOutline" />
                </ion-button>
                <ion-button
                  fill="clear"
                  size="small"
                  :disabled="locked || si === course.sections.length - 1"
                  aria-label="Move section down"
                  @click="moveSection(si, 1)"
                >
                  <ion-icon slot="icon-only" :icon="arrowDownOutline" />
                </ion-button>
                <ion-button
                  fill="clear"
                  size="small"
                  :disabled="locked"
                  aria-label="Rename section"
                  @click="renameSection(s.id, s.title)"
                >
                  <ion-icon slot="icon-only" :icon="createOutline" />
                </ion-button>
                <ion-button
                  fill="clear"
                  size="small"
                  color="danger"
                  :disabled="locked"
                  aria-label="Delete section"
                  @click="removeSection(s.id)"
                >
                  <ion-icon slot="icon-only" :icon="trashOutline" />
                </ion-button>
              </div>
            </div>
            <ion-card-title>{{ s.title }}</ion-card-title>
          </ion-card-header>
          <ion-list lines="full">
            <ion-item v-for="(l, li) in s.lectures" :key="l.id">
              <ion-icon slot="start" :icon="lectureIcon(l.type)" />
              <ion-label>
                <h3>{{ l.title }}</h3>
                <p>
                  {{ l.type }}<template v-if="l.durationSeconds"> · {{ clock(l.durationSeconds) }}</template>
                  <template v-if="l.preview"> · <ion-text color="primary">Free preview</ion-text></template>
                  <template v-if="l.media && l.media.status !== 'ready'"> · {{ l.media.status }}</template>
                  <template v-if="l.type !== 'article' && l.type !== 'quiz' && !l.media">
                    · <ion-text color="danger">no file</ion-text></template
                  >
                </p>
              </ion-label>
              <ion-buttons slot="end">
                <ion-button
                  :disabled="locked || li === 0"
                  aria-label="Move lecture up"
                  @click="moveLecture(si, li, -1)"
                >
                  <ion-icon slot="icon-only" :icon="arrowUpOutline" />
                </ion-button>
                <ion-button
                  :disabled="locked || li === s.lectures.length - 1"
                  aria-label="Move lecture down"
                  @click="moveLecture(si, li, 1)"
                >
                  <ion-icon slot="icon-only" :icon="arrowDownOutline" />
                </ion-button>
                <ion-button
                  v-if="l.type === 'quiz'"
                  :disabled="locked"
                  aria-label="Edit questions"
                  :data-testid="`quiz-questions-${l.id}`"
                  @click="quizFor = l"
                >
                  <ion-icon slot="icon-only" :icon="listOutline" />
                </ion-button>
                <ion-button :disabled="locked" aria-label="Edit lecture" @click="editLecture(s.id, l)">
                  <ion-icon slot="icon-only" :icon="createOutline" />
                </ion-button>
                <ion-button
                  color="danger"
                  :disabled="locked"
                  aria-label="Delete lecture"
                  @click="removeLecture(l.id)"
                >
                  <ion-icon slot="icon-only" :icon="trashOutline" />
                </ion-button>
              </ion-buttons>
            </ion-item>
          </ion-list>
          <ion-button
            fill="clear"
            :disabled="locked"
            :data-testid="`add-lecture-${si}`"
            @click="editLecture(s.id, null)"
          >
            <ion-icon slot="start" :icon="addOutline" /> Add lecture
          </ion-button>
        </ion-card>
        <ion-button
          expand="block"
          fill="outline"
          :disabled="locked"
          data-testid="add-section"
          @click="addSection"
        >
          <ion-icon slot="start" :icon="addOutline" /> Add section
        </ion-button>
      </div>

      <!-- Price & publish -->
      <div v-else>
        <ion-list>
          <ion-item>
            <ion-toggle v-model="pricing.free" :disabled="locked">Free course</ion-toggle>
          </ion-item>
          <ion-item v-if="!pricing.free">
            <ion-input
              v-model.number="pricing.rupees"
              type="number"
              min="1"
              label="Price (₹)"
              label-placement="stacked"
              :disabled="locked"
              data-testid="course-price-input"
            />
          </ion-item>
        </ion-list>
        <ion-button
          expand="block"
          fill="outline"
          :disabled="busy || locked"
          data-testid="save-price"
          @click="savePrice"
          >Save price</ion-button
        >

        <h3>Ready for review?</h3>
        <ul v-if="readiness && !readiness.ready" class="issues" data-testid="readiness-issues">
          <li v-for="(i, k) in readiness.issues" :key="k">{{ i }}</li>
        </ul>
        <p v-else-if="readiness?.ready" class="ok">Everything needed is in place.</p>
        <ion-button
          v-if="['draft', 'rejected', 'unpublished'].includes(course.status)"
          expand="block"
          :disabled="busy || !readiness?.ready"
          data-testid="submit-review"
          @click="submit"
          >Submit for review</ion-button
        >
        <ion-button
          v-if="course.status === 'published' && canPublish"
          expand="block"
          color="medium"
          :disabled="busy"
          @click="unpublish"
          >Unpublish</ion-button
        >
        <ion-button
          v-if="course.status === 'in_review' && canPublish"
          expand="block"
          color="medium"
          fill="outline"
          :disabled="busy"
          data-testid="withdraw-review"
          @click="withdraw"
          >Withdraw from review</ion-button
        >
        <p class="muted">
          Courses are checked by our team before they go live, usually within two working days. Published
          courses keep their learners even if you unpublish later.
        </p>
        <ion-button
          v-if="course.status === 'draft' && canDelete"
          fill="clear"
          color="danger"
          @click="removeCourse"
          >Delete course</ion-button
        >
      </div>
    </template>

    <ion-modal :is-open="!!editing" @did-dismiss="editing = null">
      <LectureEditor
        v-if="editing"
        :scope="scope"
        :lecture="editing.lecture"
        :busy="busy"
        @close="editing = null"
        @save="saveLecture"
      />
    </ion-modal>
    <ion-modal :is-open="!!quizFor" @did-dismiss="quizFor = null">
      <QuizEditor
        v-if="quizFor"
        :scope="scope"
        :course-id="id"
        :lecture-id="quizFor.id"
        :title="quizFor.title"
        @close="quizFor = null"
        @saved="refreshReadiness"
      />
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  alertController,
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonText,
  IonTextarea,
  IonToggle,
} from '@ionic/vue';
import {
  addOutline,
  arrowDownOutline,
  arrowUpOutline,
  createOutline,
  listOutline,
  trashOutline,
} from 'ionicons/icons';
import {
  MKT_COURSE_LEVEL_LABELS,
  MKT_COURSE_STATUS_LABELS,
  MKT_LANGUAGES,
  type MktCategoryDto,
  type MktCourseInput,
  type MktCourseLevel,
  type MktLectureDto,
  type MktLectureInput,
  type MktReadinessDto,
  type MktStudioCourseDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import LectureEditor from './LectureEditor.vue';
import MediaUpload from './MediaUpload.vue';
import QuizEditor from './QuizEditor.vue';
import { STATUS_COLORS } from './status';
import { clock, marketApi, studioApi, type StudioScope } from '../api';
import { lectureIcon } from '../lecture-icons';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const scope = route.params.scope as StudioScope;
const id = Number(route.params.id);
const studio = studioApi(scope);
const allowed = (action: 'publish' | 'delete') => scope === 'instructor' || auth.can(`marketplace.${action}`);
const canPublish = allowed('publish');
const canDelete = allowed('delete');

const course = ref<MktStudioCourseDto | null>(null);
const categories = ref<MktCategoryDto[]>([]);
const readiness = ref<MktReadinessDto | null>(null);
const tab = ref<'details' | 'curriculum' | 'publish'>((route.query.tab as 'curriculum') || 'details');
const busy = ref(false);
const editing = ref<{ sectionId: number; lecture: MktLectureDto | null } | null>(null);
const quizFor = ref<MktLectureDto | null>(null);
const locked = computed(() => course.value?.status === 'in_review');

const lines = (v: string) =>
  v
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
const details = reactive({
  title: '',
  subtitle: '',
  description: '',
  categoryId: null as number | null,
  subcategoryId: null as number | null,
  level: 'all' as MktCourseLevel,
  language: 'en',
  outcomes: '',
  requirements: '',
  audience: '',
});
const pricing = reactive({ free: true, rupees: 0 });
const subcategories = computed(
  () => categories.value.find((c) => c.id === details.categoryId)?.children ?? [],
);

function fill(c: MktStudioCourseDto) {
  course.value = c;
  Object.assign(details, {
    title: c.title,
    subtitle: c.subtitle ?? '',
    description: c.description ?? '',
    categoryId: c.categoryId,
    subcategoryId: c.subcategoryId,
    level: c.level,
    language: c.language,
    outcomes: c.outcomes.join('\n'),
    requirements: c.requirements.join('\n'),
    audience: c.audience.join('\n'),
  });
  pricing.free = c.pricePaise === 0;
  pricing.rupees = c.pricePaise / 100;
}

async function load() {
  try {
    fill(await studio.course(id));
    void refreshReadiness();
  } catch (e) {
    void toastError(e);
  }
}

async function refreshReadiness() {
  readiness.value = await studio.readiness(id).catch(() => null);
}

/** Runs a change that returns the updated course. */
async function run(fn: () => Promise<MktStudioCourseDto>, done?: string) {
  busy.value = true;
  try {
    fill(await fn());
    void refreshReadiness();
    if (done) await toast(done);
    return true;
  } catch (e) {
    void toastError(e);
    return false;
  } finally {
    busy.value = false;
  }
}

const patch = (input: Partial<MktCourseInput>) => run(() => studio.updateCourse(id, input), 'Saved');

const saveDetails = () =>
  patch({
    title: details.title.trim(),
    subtitle: details.subtitle.trim() || null,
    description: details.description.trim() || null,
    categoryId: details.categoryId,
    subcategoryId: details.subcategoryId,
    level: details.level,
    language: details.language,
    outcomes: lines(details.outcomes),
    requirements: lines(details.requirements),
    audience: lines(details.audience),
  });

const savePrice = () =>
  patch({ pricePaise: pricing.free ? 0 : Math.round(Math.max(0, Number(pricing.rupees) || 0) * 100) });

async function ask(header: string, value = '') {
  const alert = await alertController.create({
    header,
    inputs: [{ name: 'title', value, attributes: { maxlength: 200 } }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Save', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { title: string } }>();
  return role === 'confirm' ? data?.values.title?.trim() || null : null;
}

async function confirm(header: string, message: string) {
  const alert = await alertController.create({
    header,
    message,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Delete', role: 'destructive' },
    ],
  });
  await alert.present();
  return (await alert.onDidDismiss()).role === 'destructive';
}

async function addSection() {
  const title = await ask('New section');
  if (title) await run(() => studio.addSection(id, title));
}
async function renameSection(sectionId: number, current: string) {
  const title = await ask('Rename section', current);
  if (title) await run(() => studio.renameSection(id, sectionId, title));
}
async function removeSection(sectionId: number) {
  if (await confirm('Delete section?', 'Its lectures are deleted too.'))
    await run(() => studio.deleteSection(id, sectionId));
}
async function removeLecture(lectureId: number) {
  if (await confirm('Delete lecture?', 'This cannot be undone.'))
    await run(() => studio.deleteLecture(id, lectureId));
}

const editLecture = (sectionId: number, lecture: MktLectureDto | null) =>
  (editing.value = { sectionId, lecture });

async function saveLecture(input: MktLectureInput) {
  const e = editing.value;
  if (!e) return;
  const ok = await run(() =>
    e.lecture ? studio.updateLecture(id, e.lecture.id, input) : studio.addLecture(id, e.sectionId, input),
  );
  if (!ok) return;
  editing.value = null;
  // A new quiz opens straight into its question editor.
  if (!e.lecture && input.type === 'quiz')
    quizFor.value =
      course.value?.sections
        .find((s) => s.id === e.sectionId)
        ?.lectures.filter((l) => l.type === 'quiz')
        .at(-1) ?? null;
}

function order() {
  return (course.value?.sections ?? []).map((s) => ({ id: s.id, lectureIds: s.lectures.map((l) => l.id) }));
}
function moveSection(i: number, by: number) {
  const o = order();
  [o[i], o[i + by]] = [o[i + by]!, o[i]!];
  void run(() => studio.reorder(id, o));
}
function moveLecture(si: number, li: number, by: number) {
  const o = order();
  const l = o[si]!.lectureIds;
  [l[li], l[li + by]] = [l[li + by]!, l[li]!];
  void run(() => studio.reorder(id, o));
}

const submit = () => run(() => studio.submit(id), 'Submitted for review');
const unpublish = () => run(() => studio.unpublish(id), 'Unpublished');
async function withdraw() {
  if (!(await confirm('Withdraw from review?', 'You can edit the course and submit it again.'))) return;
  await run(() => studio.unpublish(id), 'Withdrawn from review');
}

async function removeCourse() {
  if (!(await confirm('Delete course?', 'The draft and its lectures are removed.'))) return;
  try {
    await studio.deleteCourse(id);
    await router.replace(`/market/studio/${scope}`);
  } catch (e) {
    void toastError(e);
  }
}

watch(tab, (t) => t === 'publish' && void refreshReadiness());
onMounted(async () => {
  await load();
  categories.value = await marketApi.categories().catch(() => []);
});
</script>

<style scoped>
.status {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.note {
  display: block;
  margin: 8px 0;
}
.tabs {
  margin: 12px 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
  width: 100%;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.issues {
  color: var(--ion-color-danger);
}
.ok {
  color: var(--ion-color-success-shade);
}
.muted {
  color: var(--ion-color-medium);
  font-size: 13px;
}
</style>

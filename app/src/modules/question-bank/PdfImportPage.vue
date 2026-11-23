<template>
  <AppPage title="Import question paper (PDF)" :back-href="`/question-bank/banks/${bankId}`">
    <!-- Upload -->
    <template v-if="!imp">
      <ion-note color="tertiary" class="block">
        Upload an existing question paper. Its questions, options and answers are copied into drafts for you
        to check. Scanned or photographed pages, diagrams and equations are read with an image-capable AI
        model. Nothing is saved until you review the drafts and tap <strong>Save selected</strong>.
      </ion-note>
      <ion-list>
        <ion-item button :detail="false" data-testid="pick-paper" @click="paperInput?.click()">
          <ion-icon slot="start" :icon="documentTextOutline" />
          <ion-label>
            <h3>Question paper (PDF)</h3>
            <p>{{ paper ? `${paper.name} · ${sizeLabel(paper.size)}` : 'Choose a PDF file' }}</p>
          </ion-label>
        </ion-item>
        <ion-item button :detail="false" data-testid="pick-key" @click="keyInput?.click()">
          <ion-icon slot="start" :icon="keyOutline" />
          <ion-label>
            <h3>Answer key (optional)</h3>
            <p>
              {{
                answerKey
                  ? `${answerKey.name} · ${sizeLabel(answerKey.size)}`
                  : 'Only if the answers are in a separate PDF'
              }}
            </p>
          </ion-label>
          <ion-button v-if="answerKey" slot="end" fill="clear" @click.stop="answerKey = null"
            >Remove</ion-button
          >
        </ion-item>
      </ion-list>
      <p class="muted small">
        Up to {{ LIMITS.maxMb }} MB and {{ LIMITS.maxPages }} pages. Answers are taken only from the paper or
        its answer key; questions without a printed answer are flagged for you to fill in.
      </p>
      <input
        ref="paperInput"
        data-testid="paper-input"
        type="file"
        accept="application/pdf,.pdf"
        hidden
        @change="pick($event, 'paper')"
      />
      <input
        ref="keyInput"
        data-testid="key-input"
        type="file"
        accept="application/pdf,.pdf"
        hidden
        @change="pick($event, 'key')"
      />
      <ion-button expand="block" :disabled="!paper || uploading" data-testid="start-import" @click="start">
        <ion-spinner v-if="uploading" slot="start" name="dots" />
        <ion-icon v-else slot="start" :icon="cloudUploadOutline" />
        {{ uploading ? 'Uploading…' : 'Read questions from PDF' }}
      </ion-button>

      <template v-if="open.length">
        <ion-list-header><ion-label>Earlier uploads not yet saved</ion-label></ion-list-header>
        <ion-list>
          <ion-item v-for="o in open" :key="o.id" button @click="openImport(o.id)">
            <ion-label>
              <h3>{{ o.fileName }}</h3>
              <p>{{ statusLabel(o) }} · {{ new Date(o.createdAt).toLocaleString() }}</p>
            </ion-label>
          </ion-item>
        </ion-list>
      </template>
    </template>

    <!-- Reading -->
    <template v-else-if="isWorking(imp)">
      <ion-card>
        <ion-card-header>
          <ion-card-subtitle>{{ imp.fileName }}</ion-card-subtitle>
          <ion-card-title>Reading the paper…</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <ion-progress-bar
            :value="progressOf(imp)"
            :type="imp.pagesDone ? 'determinate' : 'indeterminate'"
          />
          <p class="progress-text" data-testid="import-progress">
            {{ imp.pagesDone }} of {{ imp.pageCount }} page(s) read
          </p>
          <p class="muted small">
            You can leave this screen; the upload keeps being read and waits for you here.
          </p>
        </ion-card-content>
      </ion-card>
    </template>

    <!-- Failed -->
    <template v-else-if="imp.status === 'failed'">
      <ion-card color="light">
        <ion-card-header>
          <ion-card-subtitle>{{ imp.fileName }}</ion-card-subtitle>
          <ion-card-title>The paper could not be read</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <p>{{ imp.error }}</p>
          <ul v-if="imp.warnings.length">
            <li v-for="(w, i) in imp.warnings" :key="i">{{ w }}</li>
          </ul>
          <ion-button @click="discard">Try another file</ion-button>
        </ion-card-content>
      </ion-card>
    </template>

    <!-- Review -->
    <template v-else-if="imp.status === 'ready'">
      <ion-note color="tertiary" class="block">
        {{ drafts.length }} question(s) found in <strong>{{ imp.fileName }}</strong>
        <template v-if="imp.answerKeyFileName"> with answer key {{ imp.answerKeyFileName }}</template
        >. Check each one against the paper, fix anything wrong and save the ones you want.
        <a v-if="imp.fileUrl" :href="imp.fileUrl" target="_blank" rel="noopener">Open the PDF</a>
      </ion-note>
      <ion-card v-if="imp.warnings.length" color="warning" class="warnings">
        <ion-card-content>
          <strong>Some pages need a look:</strong>
          <ul>
            <li v-for="(w, i) in imp.warnings" :key="i">{{ w }}</li>
          </ul>
        </ion-card-content>
      </ion-card>

      <ion-accordion-group :value="'defaults'">
        <ion-accordion value="defaults">
          <ion-item slot="header"><ion-label>Save into: subject, difficulty and marks</ion-label></ion-item>
          <ion-list slot="content">
            <ion-item v-if="subjects.length">
              <ion-select
                v-model="defaults.subjectId"
                label="Subject"
                label-placement="stacked"
                interface="popover"
                @ion-change="onSubjectChange"
              >
                <ion-select-option :value="null">None</ion-select-option>
                <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
                  s.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="chapters.length">
              <ion-select
                v-model="defaults.chapterId"
                label="Chapter"
                label-placement="stacked"
                interface="popover"
                @ion-change="defaults.topicId = null"
              >
                <ion-select-option :value="null">None</ion-select-option>
                <ion-select-option v-for="c in chapters" :key="c.id" :value="c.id">{{
                  c.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="topicsOf(defaults.chapterId).length">
              <ion-select
                v-model="defaults.topicId"
                label="Topic"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option :value="null">None</ion-select-option>
                <ion-select-option v-for="t in topicsOf(defaults.chapterId)" :key="t.id" :value="t.id">{{
                  t.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                v-model="defaults.difficulty"
                label="Difficulty"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option v-for="d in QUESTION_DIFFICULTIES" :key="d" :value="d">{{
                  d
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-input
                v-model.number="defaults.defaultMarks"
                type="number"
                min="0"
                label="Marks per question"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model.number="defaults.defaultNegativeMarks"
                type="number"
                min="0"
                label="Negative marks"
                label-placement="stacked"
              />
            </ion-item>
          </ion-list>
        </ion-accordion>
      </ion-accordion-group>

      <div class="toolbar">
        <ion-segment v-model="view" class="view-switch">
          <ion-segment-button value="all"
            ><ion-label>All ({{ drafts.length }})</ion-label></ion-segment-button
          >
          <ion-segment-button value="attention" data-testid="filter-attention">
            <ion-label>Needs attention ({{ attentionCount }})</ion-label>
          </ion-segment-button>
        </ion-segment>
        <div class="select-buttons">
          <ion-button size="small" fill="outline" @click="selectAll(true)">Select all</ion-button>
          <ion-button size="small" fill="outline" @click="selectAll(false)">Select none</ion-button>
        </div>
      </div>

      <p v-if="!visible.length" class="muted">Nothing to show here.</p>
      <ion-card
        v-for="d in visible"
        :key="d.id"
        :class="{ deselected: !d.selected }"
        :data-testid="`draft-${d.id}`"
      >
        <ion-card-header>
          <ion-item lines="none" class="draft-head">
            <ion-checkbox
              slot="start"
              v-model="d.selected"
              :aria-label="`Select question ${d.number ?? d.id}`"
              :data-testid="`select-${d.id}`"
            />
            <ion-label class="ion-text-wrap">
              <strong>Q{{ d.number ?? '?' }}</strong> <span class="muted">· page {{ d.page }}</span>
              <div class="badges">
                <ion-badge v-for="f in d.flags" :key="f" :color="FLAG_COLORS[f]">{{
                  QUESTION_IMPORT_FLAG_LABELS[f]
                }}</ion-badge>
              </div>
            </ion-label>
          </ion-item>
        </ion-card-header>
        <ion-card-content>
          <ion-select
            :value="d.type"
            label="Type"
            label-placement="stacked"
            interface="popover"
            fill="outline"
            @ion-change="changeType(d, $event.detail.value)"
          >
            <ion-select-option v-for="t in QUESTION_TYPES" :key="t" :value="t">{{
              QUESTION_TYPE_LABELS[t]
            }}</ion-select-option>
          </ion-select>
          <ion-textarea
            v-model="d.text"
            class="field"
            label="Question"
            label-placement="stacked"
            :auto-grow="true"
            fill="outline"
            :data-testid="`text-${d.id}`"
          />
          <div v-if="d.diagrams.length" class="diagrams">
            <figure v-for="g in d.diagrams" :key="g.fileId" :class="{ dropped: !g.keep }">
              <img :src="g.url" alt="Diagram from the paper" />
              <figcaption>
                <ion-checkbox v-model="g.keep" label-placement="end">Attach this diagram</ion-checkbox>
              </figcaption>
            </figure>
          </div>

          <template v-if="hasOptions(d.type)">
            <p class="hint">Tick the correct option{{ d.type === 'multiple' ? '(s)' : '' }}.</p>
            <div v-for="o in d.options" :key="o.key" class="option-row">
              <ion-checkbox
                :checked="d.correct.includes(o.key)"
                :aria-label="`Option ${o.key} is correct`"
                :data-testid="`correct-${d.id}-${o.key}`"
                @ion-change="toggleCorrect(d, o.key)"
              />
              <strong class="opt-key">{{ o.key }}</strong>
              <ion-input v-model="o.text" fill="outline" :aria-label="`Option ${o.key}`" class="opt-input" />
              <ion-button
                fill="clear"
                color="medium"
                :aria-label="`Remove option ${o.key}`"
                @click="removeOption(d, o.key)"
              >
                <ion-icon slot="icon-only" :icon="closeOutline" />
              </ion-button>
            </div>
            <ion-button size="small" fill="clear" @click="addOption(d)">
              <ion-icon slot="start" :icon="addOutline" />Add option
            </ion-button>
          </template>
          <ion-segment v-else-if="d.type === 'true_false'" v-model="d.trueFalse" class="field">
            <ion-segment-button value="true" :data-testid="`tf-${d.id}-true`"
              ><ion-label>True</ion-label></ion-segment-button
            >
            <ion-segment-button value="false" :data-testid="`tf-${d.id}-false`"
              ><ion-label>False</ion-label></ion-segment-button
            >
          </ion-segment>
          <div v-else-if="d.type === 'numerical'" class="num-row field">
            <ion-input
              v-model="d.numValue"
              inputmode="decimal"
              label="Answer"
              label-placement="stacked"
              fill="outline"
              :data-testid="`num-${d.id}`"
            />
            <ion-input
              v-model="d.numTolerance"
              inputmode="decimal"
              label="± tolerance"
              label-placement="stacked"
              fill="outline"
            />
          </div>
          <ion-textarea
            v-else
            v-model="d.modelAnswer"
            class="field"
            label="Model answer (optional)"
            label-placement="stacked"
            :auto-grow="true"
            fill="outline"
          />
          <ion-textarea
            v-model="d.explanation"
            class="field"
            label="Explanation (optional)"
            label-placement="stacked"
            :auto-grow="true"
            fill="outline"
          />
          <p v-if="reviewProblem(d)" class="problem" :data-testid="`problem-${d.id}`">
            {{ reviewProblem(d) }}
          </p>
        </ion-card-content>
      </ion-card>

      <div class="footer">
        <ion-button
          expand="block"
          :disabled="saving || !selectedCount"
          data-testid="save-selected"
          @click="save"
        >
          <ion-spinner v-if="saving" slot="start" name="dots" />
          Save {{ selectedCount }} selected question(s)
        </ion-button>
        <ion-button expand="block" fill="clear" color="danger" :disabled="saving" @click="discard">
          Discard this upload
        </ion-button>
      </div>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonAccordion,
  IonAccordionGroup,
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonCheckbox,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonProgressBar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  alertController,
  onIonViewDidLeave,
  onIonViewWillEnter,
  useIonRouter,
} from '@ionic/vue';
import {
  addOutline,
  closeOutline,
  cloudUploadOutline,
  documentTextOutline,
  keyOutline,
} from 'ionicons/icons';
import {
  QUESTION_DIFFICULTIES,
  QUESTION_IMPORT_FLAG_LABELS,
  QUESTION_PDF_IMPORT_LIMITS as LIMITS,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  type QuestionImportDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { questionBankApi } from './api';
import { hasOptions, useAcademicPickers } from './helpers';
import {
  FLAG_COLORS,
  addOption,
  buildSaveItems,
  changeType,
  isWorking,
  needsAttention,
  progressOf,
  removeOption,
  reviewProblem,
  toReviewDraft,
  toggleCorrect,
  type ImportDefaults,
  type ReviewDraft,
} from './pdf-import.helpers';

const POLL_MS = 2000;

const route = useRoute();
const router = useRouter();
const ionRouter = useIonRouter();
const bankId = computed(() => Number(route.params.bankId));
const { subjects, chapters, loadSubjects, loadChapters, topicsOf } = useAcademicPickers();

const paperInput = ref<HTMLInputElement>();
const keyInput = ref<HTMLInputElement>();
const paper = ref<File | null>(null);
const answerKey = ref<File | null>(null);
const uploading = ref(false);
const saving = ref(false);
const imp = ref<QuestionImportDto | null>(null);
const open = ref<QuestionImportDto[]>([]);
const drafts = ref<ReviewDraft[]>([]);
const view = ref<'all' | 'attention'>('all');
const defaults = reactive<ImportDefaults>({
  subjectId: null,
  chapterId: null,
  topicId: null,
  difficulty: 'medium',
  defaultMarks: 1,
  defaultNegativeMarks: 0,
});
let timer: ReturnType<typeof setTimeout> | null = null;

const visible = computed(() => (view.value === 'all' ? drafts.value : drafts.value.filter(needsAttention)));
const attentionCount = computed(() => drafts.value.filter(needsAttention).length);
const selectedCount = computed(() => drafts.value.filter((d) => d.selected).length);

const sizeLabel = (b: number) =>
  b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;
const statusLabel = (o: QuestionImportDto) =>
  isWorking(o)
    ? `Reading (${o.pagesDone}/${o.pageCount} pages)`
    : o.status === 'failed'
      ? 'Failed'
      : 'Ready to review';

function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function show(next: QuestionImportDto) {
  const wasReady = imp.value?.status === 'ready' && imp.value.id === next.id;
  imp.value = next;
  if (next.status === 'ready' && !wasReady) drafts.value = next.drafts.map(toReviewDraft);
  stopPolling();
  if (isWorking(next)) timer = setTimeout(() => void poll(next.id), POLL_MS);
}

async function poll(id: number) {
  try {
    show(await questionBankApi.pdfImport(id));
  } catch (e) {
    await toastError(e);
  }
}

async function init() {
  imp.value = null;
  drafts.value = [];
  paper.value = null;
  answerKey.value = null;
  await loadSubjects();
  try {
    const bank = await questionBankApi.bank(bankId.value);
    if (bank.subjectId && !defaults.subjectId) {
      defaults.subjectId = bank.subjectId;
      await loadChapters(bank.subjectId);
    }
    const id = Number(route.query.import);
    if (id) await poll(id);
    else open.value = await questionBankApi.pdfImports(bankId.value);
  } catch (e) {
    await toastError(e);
  }
}

function pick(ev: Event, which: 'paper' | 'key') {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = '';
  if (!file) return;
  if (file.size > LIMITS.maxMb * 1048576) {
    void toast(`The PDF is larger than ${LIMITS.maxMb} MB`, 'warning');
    return;
  }
  if (which === 'paper') paper.value = file;
  else answerKey.value = file;
}

async function openImport(id: number) {
  await router.replace({ query: { import: String(id) } });
  await poll(id);
}

async function start() {
  if (!paper.value) return;
  uploading.value = true;
  try {
    const created = await questionBankApi.startPdfImport(bankId.value, paper.value, answerKey.value);
    await router.replace({ query: { import: String(created.id) } });
    show(created);
  } catch (e) {
    await toastError(e);
  } finally {
    uploading.value = false;
  }
}

async function onSubjectChange() {
  defaults.chapterId = null;
  defaults.topicId = null;
  await loadChapters(defaults.subjectId);
}

function selectAll(on: boolean) {
  for (const d of visible.value) d.selected = on;
}

async function save() {
  if (!imp.value) return;
  const invalid = drafts.value.filter((d) => d.selected && reviewProblem(d));
  if (invalid.length) {
    view.value = 'attention';
    await toast(
      `Fix ${invalid.map((d) => `Q${d.number ?? d.id}`).join(', ')} or untick them before saving`,
      'warning',
    );
    return;
  }
  saving.value = true;
  try {
    const res = await questionBankApi.savePdfImport(imp.value.id, buildSaveItems(drafts.value, defaults));
    await toast(`${res.created} question(s) added to the bank`);
    stopPolling();
    imp.value = null;
    drafts.value = [];
    ionRouter.navigate(`/question-bank/banks/${bankId.value}`, 'back', 'replace');
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function discard() {
  if (!imp.value) return;
  const id = imp.value.id;
  if (imp.value.status === 'ready') {
    const alert = await alertController.create({
      header: 'Discard this upload?',
      message: 'The extracted questions will be deleted. Nothing has been saved to the bank.',
      buttons: [
        { text: 'Keep', role: 'cancel' },
        { text: 'Discard', role: 'destructive' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'destructive') return;
  }
  try {
    await questionBankApi.discardPdfImport(id);
    await router.replace({ query: {} });
    await init();
  } catch (e) {
    await toastError(e);
  }
}

onIonViewWillEnter(init);
onIonViewDidLeave(stopPolling);
onBeforeUnmount(stopPolling);
</script>

<style scoped>
.block {
  display: block;
  margin-bottom: 12px;
}
.small {
  font-size: 0.85em;
}
.progress-text {
  margin-top: 8px;
  font-weight: 600;
}
.warnings ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin: 12px 0 4px;
}
.view-switch {
  max-width: 420px;
}
.draft-head {
  --padding-start: 0;
}
.badges ion-badge {
  margin: 4px 4px 0 0;
}
.deselected {
  opacity: 0.55;
}
.field {
  margin-top: 10px;
}
.diagrams {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
}
.diagrams figure {
  margin: 0;
  max-width: 100%;
}
.diagrams img {
  max-width: min(320px, 100%);
  max-height: 240px;
  border: 1px solid var(--ion-color-light-shade);
  border-radius: 4px;
  background: #fff;
}
.diagrams figure.dropped img {
  opacity: 0.35;
}
.hint {
  margin: 10px 0 4px;
}
.option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.opt-key {
  width: 1.2em;
}
.opt-input {
  flex: 1;
  min-width: 0;
}
.num-row {
  display: flex;
  gap: 8px;
}
.problem {
  color: var(--ion-color-danger);
  font-weight: 600;
  margin-top: 8px;
}
.footer {
  position: sticky;
  bottom: 0;
  background: var(--ion-background-color, #fff);
  padding: 8px 0;
  z-index: 2;
}
</style>

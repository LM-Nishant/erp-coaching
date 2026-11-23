<template>
  <AppPage :title="bank?.name ?? 'Question bank'" back-href="/question-bank" :on-refresh="reload">
    <template #actions>
      <ion-button
        v-can="'question-bank.create'"
        :router-link="`/question-bank/banks/${bankId}/questions/new`"
        aria-label="New question"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
      <ion-button aria-label="More actions" @click="menuOpen = true"
        ><ion-icon slot="icon-only" :icon="ellipsisVertical"
      /></ion-button>
    </template>

    <ion-card v-if="bank">
      <ion-card-header>
        <ion-card-subtitle>
          {{ bank.visibility === 'shared' ? 'Shared' : 'Private' }}
          <template v-if="bank.subjectName"> · {{ bank.subjectName }}</template>
          <template v-if="bank.ownerName"> · {{ bank.ownerName }}</template>
        </ion-card-subtitle>
        <ion-card-title>{{ bank.name }}</ion-card-title>
      </ion-card-header>
      <ion-card-content>
        <p v-if="bank.description">{{ bank.description }}</p>
        <p>{{ total }} question(s) match the current filters.</p>
        <div v-can="'question-bank.create'" class="actions">
          <ion-button size="small" :router-link="`/question-bank/banks/${bankId}/questions/new`">
            <ion-icon slot="start" :icon="add" />New question
          </ion-button>
          <ion-button size="small" color="tertiary" :router-link="`/question-bank/banks/${bankId}/generate`">
            <ion-icon slot="start" :icon="sparklesOutline" />Generate with AI
          </ion-button>
          <ion-button
            size="small"
            color="secondary"
            data-testid="import-pdf"
            :router-link="`/question-bank/banks/${bankId}/import-pdf`"
          >
            <ion-icon slot="start" :icon="documentTextOutline" />Import PDF paper
          </ion-button>
        </div>
      </ion-card-content>
    </ion-card>

    <ion-searchbar v-model="filters.q" :debounce="300" placeholder="Search question text" />
    <ion-grid>
      <ion-row>
        <ion-col size="6" size-md="3">
          <ion-select v-model="filters.type" label="Type" label-placement="stacked" interface="popover">
            <ion-select-option value="">Any</ion-select-option>
            <ion-select-option v-for="t in QUESTION_TYPES" :key="t" :value="t">{{
              QUESTION_TYPE_LABELS[t]
            }}</ion-select-option>
          </ion-select>
        </ion-col>
        <ion-col size="6" size-md="3">
          <ion-select
            v-model="filters.difficulty"
            label="Difficulty"
            label-placement="stacked"
            interface="popover"
          >
            <ion-select-option value="">Any</ion-select-option>
            <ion-select-option v-for="d in QUESTION_DIFFICULTIES" :key="d" :value="d">{{
              d
            }}</ion-select-option>
          </ion-select>
        </ion-col>
        <ion-col size="6" size-md="3">
          <ion-select v-model="filters.status" label="Status" label-placement="stacked" interface="popover">
            <ion-select-option value="">Any</ion-select-option>
            <ion-select-option v-for="s in QUESTION_STATUSES" :key="s" :value="s">{{ s }}</ion-select-option>
          </ion-select>
        </ion-col>
        <ion-col size="6" size-md="3">
          <ion-input v-model="filters.tag" label="Tag" label-placement="stacked" :debounce="300" />
        </ion-col>
        <ion-col v-if="chapters.length" size="6" size-md="3">
          <ion-select
            v-model="filters.chapterId"
            label="Chapter"
            label-placement="stacked"
            interface="popover"
            @ion-change="filters.topicId = null"
          >
            <ion-select-option :value="null">Any</ion-select-option>
            <ion-select-option v-for="c in chapters" :key="c.id" :value="c.id">{{
              c.name
            }}</ion-select-option>
          </ion-select>
        </ion-col>
        <ion-col v-if="topicsOf(filters.chapterId).length" size="6" size-md="3">
          <ion-select v-model="filters.topicId" label="Topic" label-placement="stacked" interface="popover">
            <ion-select-option :value="null">Any</ion-select-option>
            <ion-select-option v-for="t in topicsOf(filters.chapterId)" :key="t.id" :value="t.id">{{
              t.name
            }}</ion-select-option>
          </ion-select>
        </ion-col>
      </ion-row>
    </ion-grid>

    <SecureView screen="question-bank">
      <ion-list>
        <QuestionItem v-for="q in questions" :key="q.id" :question="q" />
        <ion-item v-if="!loading && !questions.length">
          <ion-label class="muted">No questions found.</ion-label>
        </ion-item>
      </ion-list>
    </SecureView>
    <ion-infinite-scroll :disabled="questions.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>

    <input ref="fileInput" type="file" accept=".csv,.xlsx" hidden @change="importPicked" />

    <ion-action-sheet
      :is-open="menuOpen"
      header="Bank actions"
      :buttons="menuButtons"
      @did-dismiss="menuOpen = false"
    />

    <ion-modal :is-open="!!importResult" @did-dismiss="importResult = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Import result</ion-title>
          <ion-buttons slot="end"><ion-button @click="importResult = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="importResult" class="ion-padding">
        <p>
          <strong>{{ importResult.created }}</strong> question(s) imported,
          <strong>{{ importResult.failed.length }}</strong> row(s) failed.
        </p>
        <ion-list v-if="importResult.failed.length">
          <ion-item v-for="f in importResult.failed" :key="f.row">
            <ion-label class="ion-text-wrap">
              <h3>Row {{ f.row }}</h3>
              <p>{{ f.message }}</p>
            </ion-label>
          </ion-item>
        </ion-list>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonActionSheet,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonCol,
  IonContent,
  IonGrid,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonRow,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
  type ActionSheetButton,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add, documentTextOutline, ellipsisVertical, sparklesOutline } from 'ionicons/icons';
import {
  QUESTION_DIFFICULTIES,
  QUESTION_STATUSES,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  type QuestionBankDto,
  type QuestionDto,
  type QuestionImportResult,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import SecureView from '@/components/SecureView.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { questionBankApi } from './api';
import { useAcademicPickers } from './helpers';
import QuestionItem from './QuestionItem.vue';

const route = useRoute();
const auth = useAuthStore();
const bankId = computed(() => Number(route.params.id));
const bank = ref<QuestionBankDto | null>(null);
const questions = ref<QuestionDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);
const menuOpen = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const importResult = ref<QuestionImportResult | null>(null);
const filters = reactive({
  q: '',
  type: '',
  difficulty: '',
  status: '',
  tag: '',
  chapterId: null as number | null,
  topicId: null as number | null,
});
const { chapters, loadChapters, topicsOf } = useAcademicPickers();

const menuButtons = computed(() => {
  const buttons: ActionSheetButton[] = [];
  if (auth.can('question-bank.create')) {
    buttons.push(
      { text: 'Import CSV / Excel', handler: () => fileInput.value?.click() },
      { text: 'Download import template', handler: () => void questionBankApi.template().catch(toastError) },
    );
  }
  if (auth.can('question-bank.export'))
    buttons.push({
      text: 'Export CSV',
      handler: () => void questionBankApi.exportCsv(bankId.value).catch(toastError),
    });
  buttons.push({ text: 'Cancel', role: 'cancel' });
  return buttons;
});

async function loadBank() {
  try {
    bank.value = await questionBankApi.bank(bankId.value);
    await loadChapters(bank.value.subjectId);
  } catch (e) {
    await toastError(e);
  }
}

async function load(reset = true) {
  loading.value = true;
  if (reset) page.value = 1;
  try {
    const res = await questionBankApi.questions({
      bankId: bankId.value,
      page: page.value,
      pageSize: 25,
      q: filters.q || undefined,
      type: filters.type || undefined,
      difficulty: filters.difficulty || undefined,
      status: filters.status || undefined,
      tag: filters.tag.trim() || undefined,
      chapterId: filters.chapterId ?? undefined,
      topicId: filters.topicId ?? undefined,
    });
    questions.value = reset ? res.items : [...questions.value, ...res.items];
    total.value = res.total;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

const reload = () => Promise.all([loadBank(), load(true)]);

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  await load(false);
  await ev.target.complete();
}

async function importPicked(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    importResult.value = await questionBankApi.importFile(bankId.value, file);
    if (importResult.value.created) await toast(`${importResult.value.created} question(s) imported`);
    await load(true);
  } catch (e) {
    await toastError(e);
  }
}

watch(filters, () => load(true));
onIonViewWillEnter(reload);
</script>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
</style>

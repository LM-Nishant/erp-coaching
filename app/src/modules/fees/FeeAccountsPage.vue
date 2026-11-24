<template>
  <AppPage :title="t('fees.accounts.title')" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'fees.create'" :aria-label="t('fees.accounts.assign')" @click="openCreate"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <ion-button v-can="'fees.create'" expand="block" class="collect" @click="collecting = true">
      <ion-icon slot="start" :icon="walletOutline" />{{ t('fees.collect.title') }}
    </ion-button>
    <ion-searchbar
      v-model="search"
      :debounce="400"
      :placeholder="t('fees.accounts.search')"
      @ion-input="load"
    />
    <ion-item lines="none"
      ><ion-checkbox v-model="duesOnly" @ion-change="load">{{
        t('fees.accounts.duesOnly')
      }}</ion-checkbox></ion-item
    >
    <p v-if="total" class="muted count">{{ t('fees.accounts.count', { n: total }, total) }}</p>
    <ion-list v-if="accounts.length">
      <ion-item v-for="a in accounts" :key="a.id" button :router-link="`/fees/accounts/${a.id}`">
        <ion-label>
          <h3>
            {{ a.studentName }} <small class="muted">{{ a.admissionNumber }}</small>
          </h3>
          <p>{{ a.title }}</p>
          <p class="muted">
            {{ t('fees.accounts.netPaid', { net: formatMoney(a.net), paid: formatMoney(a.paid) }) }}
          </p>
        </ion-label>
        <StatusChip
          slot="end"
          :tone="a.balance > 0 ? 'warning' : a.status === 'active' ? 'success' : 'medium'"
          :label="
            a.balance > 0 ? t('fees.collect.due', { amount: formatMoney(a.balance) }) : statusLabel(a.status)
          "
        />
      </ion-item>
    </ion-list>
    <EmptyState
      v-else-if="!loading"
      :icon="walletOutline"
      :title="t('fees.accounts.emptyTitle')"
      :message="t('fees.accounts.emptyMessage')"
    />
    <ion-infinite-scroll :disabled="!hasMore" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>

    <CollectFeeSheet :is-open="collecting" @close="collecting = false" @recorded="load" />

    <ion-modal :is-open="!!create" @did-dismiss="create = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Assign fees</ion-title>
          <ion-buttons slot="end"><ion-button @click="create = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="create" class="ion-padding">
        <ion-segment v-model="create.target">
          <ion-segment-button value="student">One student</ion-segment-button>
          <ion-segment-button value="batch">Whole batch</ion-segment-button>
        </ion-segment>
        <ion-list>
          <template v-if="create.target === 'student'">
            <ion-searchbar
              v-model="create.query"
              :debounce="400"
              placeholder="Find student"
              @ion-input="findStudents"
            />
            <ion-item v-for="s in studentHits" :key="s.id" button @click="create.studentId = s.id">
              <ion-label
                >{{ s.name }} <small class="muted">{{ s.admissionNumber }}</small></ion-label
              >
              <ion-note v-if="create.studentId === s.id" slot="end">✓</ion-note>
            </ion-item>
          </template>
          <ion-item v-else>
            <ion-select v-model="create.batchId" label="Batch" label-placement="stacked">
              <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{
                b.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select v-model="create.structureId" label="Fee structure" label-placement="stacked">
              <ion-select-option v-if="create.target === 'batch'" :value="null"
                >Auto (batch/course match)</ion-select-option
              >
              <ion-select-option v-for="s in structures" :key="s.id" :value="s.id"
                >{{ s.name }} v{{ s.version }} · {{ rupees(s.total) }}</ion-select-option
              >
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-input
              v-model="create.firstDueDate"
              type="date"
              label="First due date"
              label-placement="stacked"
            />
          </ion-item>
        </ion-list>
        <ion-button expand="block" :disabled="saving" @click="saveCreate">Create</ion-button>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add, walletOutline } from 'ionicons/icons';
import type { BatchDto, FeeAccountDto, FeeStructureDto, StudentDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatMoney } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { academicsApi } from '../academics/api';
import { rupees } from '../hr/api';
import { studentsApi } from '../students/api';
import { feesApi } from './api';
import CollectFeeSheet from './CollectFeeSheet.vue';

const PAGE_SIZE = 30;
const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();
const accounts = ref<FeeAccountDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);
const collecting = ref(false);
let ready = false;
// `dues` is filtered after paging on the server, so pages can be short: stop on the page count, not items.
const hasMore = computed(() => page.value * PAGE_SIZE < total.value);
const search = ref('');
const duesOnly = ref(false);
const structures = ref<FeeStructureDto[]>([]);
const batches = ref<BatchDto[]>([]);
const studentHits = ref<StudentDto[]>([]);
const saving = ref(false);
const create = ref<{
  target: 'student' | 'batch';
  query: string;
  studentId: number | null;
  batchId: number | null;
  structureId: number | null;
  firstDueDate: string;
} | null>(null);

const statusLabel = (s: string) => (te(`fees.accounts.status.${s}`) ? t(`fees.accounts.status.${s}`) : s);

const fetchPage = (n: number) =>
  feesApi.accounts({
    search: search.value || undefined,
    dues: duesOnly.value ? 'true' : undefined,
    page: n,
    pageSize: PAGE_SIZE,
  });

async function load() {
  loading.value = true;
  try {
    const r = await fetchPage(1);
    page.value = 1;
    accounts.value = r.items;
    total.value = r.total;
  } catch (e) {
    void toastError(e);
  } finally {
    loading.value = false;
  }
}

async function more(ev: InfiniteScrollCustomEvent) {
  try {
    const r = await fetchPage(page.value + 1);
    page.value++;
    accounts.value.push(...r.items.filter((x) => !accounts.value.some((y) => y.id === x.id)));
    total.value = r.total;
  } catch (e) {
    void toastError(e);
  } finally {
    await ev.target.complete();
  }
}

// Links from the staff home: `?dues=1` lists who owes, `?collect=1` opens the collect sheet.
watch(
  () => route.query,
  (q) => {
    if (route.path !== '/fees/accounts') return;
    if (q.dues === '1' && !duesOnly.value) {
      duesOnly.value = true;
      if (ready) void load();
    }
    if (q.collect === '1') collecting.value = true;
    if (q.dues || q.collect) void router.replace({ query: {} });
  },
  { immediate: true },
);

async function openCreate() {
  create.value = {
    target: 'student',
    query: '',
    studentId: null,
    batchId: null,
    structureId: null,
    firstDueDate: '',
  };
  try {
    const [s, b] = await Promise.all([feesApi.structures({ status: 'active' }), academicsApi.batches()]);
    structures.value = s.items;
    batches.value = b.items;
  } catch (e) {
    void toastError(e);
  }
}

async function findStudents() {
  if (!create.value?.query) return;
  try {
    studentHits.value = (await studentsApi.list({ search: create.value.query, pageSize: 10 })).items;
  } catch (e) {
    void toastError(e);
  }
}

async function saveCreate() {
  const c = create.value;
  if (!c) return;
  saving.value = true;
  try {
    const firstDueDate = c.firstDueDate || undefined;
    if (c.target === 'student') {
      if (!c.studentId || !c.structureId) throw new Error('Pick a student and a fee structure');
      await feesApi.createAccount({ studentId: c.studentId, structureId: c.structureId, firstDueDate });
      await toast('Fee account created');
    } else {
      if (!c.batchId) throw new Error('Pick a batch');
      const r = await feesApi.generateBatch({
        batchId: c.batchId,
        structureId: c.structureId ?? undefined,
        firstDueDate,
      });
      await toast(`${r.created} account(s) created, ${r.skipped} already had one`);
    }
    create.value = null;
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  ready = true;
  void load();
});
</script>

<style scoped>
.collect {
  min-height: var(--app-tap-target);
  margin: 0 12px 4px;
}
.count {
  margin: 0 16px;
  font-size: 13px;
}
.muted {
  color: var(--ion-color-medium);
}
</style>

<template>
  <AppPage :title="t('grievances.queue.title')" :on-refresh="reload">
    <template #actions>
      <ion-button
        v-can="'grievances.create'"
        router-link="/grievances/new"
        :aria-label="t('grievances.newComplaint')"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar
      v-model="filters.search"
      :debounce="400"
      :placeholder="t('grievances.queue.searchPlaceholder')"
    />
    <ion-segment v-model="statusTab" scrollable>
      <ion-segment-button value="active"
        ><ion-label>{{ t('common.status.active') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="escalated"
        ><ion-label>{{ t('grievances.status.escalated') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="resolved"
        ><ion-label>{{ t('common.status.resolved') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="closed"
        ><ion-label>{{ t('common.status.closed') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="all"
        ><ion-label>{{ t('common.labels.all') }}</ion-label></ion-segment-button
      >
    </ion-segment>
    <ion-list>
      <ion-item>
        <ion-select v-model="filters.assignee" :label="t('grievances.fields.assignee')" interface="popover">
          <ion-select-option value="">{{ t('grievances.queue.anyone') }}</ion-select-option>
          <ion-select-option value="me">{{ t('grievances.queue.me') }}</ion-select-option>
          <ion-select-option value="unassigned">{{ t('grievances.unassigned') }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-select v-model="filters.priority" :label="t('grievances.fields.priority')" interface="popover">
          <ion-select-option value="">{{ t('grievances.queue.any') }}</ion-select-option>
          <ion-select-option v-for="p in GRIEVANCE_PRIORITIES" :key="p" :value="p">{{
            t(priorityKey(p))
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-select v-model="filters.categoryId" :label="t('grievances.fields.category')" interface="popover">
          <ion-select-option :value="null">{{ t('grievances.queue.any') }}</ion-select-option>
          <ion-select-option v-for="c in categories" :key="c.id" :value="c.id">{{
            c.name
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-checkbox v-model="filters.overdue">{{ t('grievances.queue.onlyOverdue') }}</ion-checkbox>
      </ion-item>
    </ion-list>

    <ion-list>
      <TicketItem v-for="item in tickets" :key="item.id" :ticket="item" show-requester />
    </ion-list>
    <EmptyState
      v-if="!loading && !tickets.length"
      :icon="fileTrayOutline"
      :title="t('grievances.queue.empty')"
    />
    <ion-infinite-scroll :disabled="tickets.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  IonButton,
  IonCheckbox,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  onIonViewWillEnter,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add, fileTrayOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { GRIEVANCE_PRIORITIES, type GrievanceCategoryDto, type GrievanceTicketDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import { toastError } from '@/core/toast';
import { grievancesApi, priorityKey, type TicketFilters } from './api';
import TicketItem from './TicketItem.vue';

const { t } = useI18n();

const STATUS_TABS: Record<string, string | undefined> = {
  active: 'open,in_progress,escalated',
  escalated: 'escalated',
  resolved: 'resolved',
  closed: 'closed',
  all: undefined,
};

const statusTab = ref('active');
const filters = reactive<TicketFilters>({
  search: '',
  assignee: '',
  priority: '',
  categoryId: null,
  overdue: false,
});
const tickets = ref<GrievanceTicketDto[]>([]);
const categories = ref<GrievanceCategoryDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);

const query = computed(() => ({
  ...filters,
  overdue: filters.overdue || undefined,
  status: STATUS_TABS[statusTab.value],
  pageSize: 25,
}));

async function load(reset = true) {
  loading.value = true;
  if (reset) page.value = 1;
  try {
    const res = await grievancesApi.queue({ ...query.value, page: page.value });
    tickets.value = reset ? res.items : [...tickets.value, ...res.items];
    total.value = res.total;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

const reload = () => load(true);

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  await load(false);
  await ev.target.complete();
}

onMounted(async () => {
  grievancesApi
    .categories()
    .then((c) => (categories.value = c))
    .catch(() => undefined);
});
onIonViewWillEnter(reload);
watch([statusTab, filters], reload, { deep: true });
</script>

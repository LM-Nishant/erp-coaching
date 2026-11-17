<template>
  <AppPage title="Complaint queue" :on-refresh="reload">
    <template #actions>
      <ion-button v-can="'grievances.create'" router-link="/grievances/new"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar v-model="filters.search" :debounce="400" placeholder="Search ticket no. or subject" />
    <ion-segment v-model="statusTab" scrollable>
      <ion-segment-button value="active"><ion-label>Active</ion-label></ion-segment-button>
      <ion-segment-button value="escalated"><ion-label>Escalated</ion-label></ion-segment-button>
      <ion-segment-button value="resolved"><ion-label>Resolved</ion-label></ion-segment-button>
      <ion-segment-button value="closed"><ion-label>Closed</ion-label></ion-segment-button>
      <ion-segment-button value="all"><ion-label>All</ion-label></ion-segment-button>
    </ion-segment>
    <ion-list>
      <ion-item>
        <ion-select v-model="filters.assignee" label="Assignee" interface="popover">
          <ion-select-option value="">Anyone</ion-select-option>
          <ion-select-option value="me">Me</ion-select-option>
          <ion-select-option value="unassigned">Unassigned</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-select v-model="filters.priority" label="Priority" interface="popover">
          <ion-select-option value="">Any</ion-select-option>
          <ion-select-option v-for="p in GRIEVANCE_PRIORITIES" :key="p" :value="p">{{ p }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-select v-model="filters.categoryId" label="Category" interface="popover">
          <ion-select-option :value="null">Any</ion-select-option>
          <ion-select-option v-for="c in categories" :key="c.id" :value="c.id">{{
            c.name
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-checkbox v-model="filters.overdue">Only overdue</ion-checkbox>
      </ion-item>
    </ion-list>

    <ion-list>
      <TicketItem v-for="t in tickets" :key="t.id" :ticket="t" show-requester />
      <ion-item v-if="!loading && !tickets.length"
        ><ion-label class="muted">No complaints.</ion-label></ion-item
      >
    </ion-list>
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
import { add } from 'ionicons/icons';
import { GRIEVANCE_PRIORITIES, type GrievanceCategoryDto, type GrievanceTicketDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { grievancesApi, type TicketFilters } from './api';
import TicketItem from './TicketItem.vue';

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

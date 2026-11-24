<template>
  <MarketShell title="Search courses" back-href="/market" :search="false" wide>
    <template #toolbar>
      <ion-toolbar>
        <ion-searchbar
          v-model="filters.q"
          placeholder="Search for a course"
          :debounce="400"
          data-testid="search-input"
          @ion-input="apply"
        />
      </ion-toolbar>
    </template>

    <div class="filters">
      <ion-select
        v-model="filters.category"
        label="Category"
        interface="popover"
        fill="outline"
        @ion-change="apply"
      >
        <ion-select-option value="">All</ion-select-option>
        <template v-for="c in categories" :key="c.id">
          <ion-select-option :value="c.slug">{{ c.name }}</ion-select-option>
          <ion-select-option v-for="s in c.children" :key="s.id" :value="s.slug"
            >— {{ s.name }}</ion-select-option
          >
        </template>
      </ion-select>
      <ion-select
        v-model="filters.level"
        label="Level"
        interface="popover"
        fill="outline"
        @ion-change="apply"
      >
        <ion-select-option value="">Any</ion-select-option>
        <ion-select-option v-for="(label, key) in MKT_COURSE_LEVEL_LABELS" :key="key" :value="key">{{
          label
        }}</ion-select-option>
      </ion-select>
      <ion-select
        v-model="filters.language"
        label="Language"
        interface="popover"
        fill="outline"
        @ion-change="apply"
      >
        <ion-select-option value="">Any</ion-select-option>
        <ion-select-option v-for="(label, key) in MKT_LANGUAGES" :key="key" :value="key">{{
          label
        }}</ion-select-option>
      </ion-select>
      <ion-select
        v-model="filters.price"
        label="Price"
        interface="popover"
        fill="outline"
        @ion-change="apply"
      >
        <ion-select-option value="">Any</ion-select-option>
        <ion-select-option value="free">Free</ion-select-option>
        <ion-select-option value="paid">Paid</ion-select-option>
      </ion-select>
      <ion-select
        v-model="filters.rating"
        label="Rating"
        interface="popover"
        fill="outline"
        @ion-change="apply"
      >
        <ion-select-option :value="0">Any</ion-select-option>
        <ion-select-option :value="4.5">4.5 & up</ion-select-option>
        <ion-select-option :value="4">4.0 & up</ion-select-option>
        <ion-select-option :value="3.5">3.5 & up</ion-select-option>
      </ion-select>
      <ion-select v-model="filters.sort" label="Sort" interface="popover" fill="outline" @ion-change="apply">
        <ion-select-option v-for="(label, key) in MKT_SORT_LABELS" :key="key" :value="key">{{
          label
        }}</ion-select-option>
      </ion-select>
    </div>

    <p class="muted" data-testid="result-count">
      {{ loading && !items.length ? 'Searching…' : `${total} ${total === 1 ? 'course' : 'courses'}` }}
    </p>
    <CourseGrid :courses="items" />
    <p v-if="!loading && !items.length" class="muted empty">
      No courses match. Try other words or fewer filters.
    </p>
    <ion-infinite-scroll :disabled="items.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </MarketShell>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonToolbar,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import {
  MKT_COURSE_LEVEL_LABELS,
  MKT_LANGUAGES,
  MKT_SORT_LABELS,
  type MktCatalogQuery,
  type MktCategoryDto,
  type MktCourseCardDto,
  type MktCourseLevel,
  type MktSort,
} from '@erp/shared';
import { toastError } from '@/core/toast';
import MarketShell from './components/MarketShell.vue';
import CourseGrid from './components/CourseGrid.vue';
import { marketApi } from './api';

const route = useRoute();
const router = useRouter();
const str = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '');

const filters = reactive({
  q: str('q'),
  category: str('category'),
  level: str('level'),
  language: str('language'),
  price: str('price'),
  rating: Number(str('rating')) || 0,
  sort: (str('sort') || 'relevance') as MktSort,
});
const categories = ref<MktCategoryDto[]>([]);
const items = ref<MktCourseCardDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
let seq = 0;

function query(): MktCatalogQuery {
  return {
    q: filters.q.trim() || undefined,
    category: filters.category || undefined,
    level: (filters.level || undefined) as MktCourseLevel | undefined,
    language: filters.language || undefined,
    price: (filters.price || undefined) as 'free' | 'paid' | undefined,
    rating: filters.rating || undefined,
    sort: filters.sort,
  };
}

async function load(reset: boolean) {
  const mine = ++seq;
  loading.value = true;
  try {
    const res = await marketApi.search({ ...query(), page: reset ? 1 : page.value + 1, pageSize: 24 });
    if (mine !== seq) return;
    page.value = res.page;
    total.value = res.total;
    items.value = reset ? res.items : [...items.value, ...res.items];
  } catch (e) {
    void toastError(e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

function apply() {
  const q = Object.fromEntries(
    Object.entries(query()).filter(([k, v]) => v !== undefined && !(k === 'sort' && v === 'relevance')),
  ) as Record<string, string>;
  void router.replace({ query: q });
  void load(true);
}

async function more(ev: InfiniteScrollCustomEvent) {
  await load(false);
  await ev.target.complete();
}

onMounted(async () => {
  void load(true);
  categories.value = await marketApi.categories().catch(() => []);
});
</script>

<style scoped>
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}
.muted {
  color: var(--ion-color-medium);
}
.empty {
  text-align: center;
  padding: 32px 0;
}
</style>

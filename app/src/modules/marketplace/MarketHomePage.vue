<template>
  <MarketShell title="Courses" :search="false" wide :on-refresh="load">
    <section class="hero">
      <h1>Learn anything, from teachers you trust</h1>
      <p>Courses by coaching institutes and independent instructors. Watch on the web or in the app.</p>
      <form class="hero-search" @submit.prevent="go">
        <ion-searchbar
          v-model="q"
          placeholder="Search for a course"
          :debounce="0"
          data-testid="market-search"
          @keyup.enter="go"
        />
      </form>
    </section>

    <div v-if="home" class="cats">
      <ion-chip v-for="c in home.categories" :key="c.id" :router-link="`/market/search?category=${c.slug}`">
        {{ c.name }}
      </ion-chip>
    </div>

    <template v-if="home">
      <section v-for="row in rows" :key="row.key" class="row">
        <div class="row-head">
          <h2>{{ row.title }}</h2>
          <router-link :to="row.more">See all</router-link>
        </div>
        <CourseGrid v-if="row.courses.length" :courses="row.courses" scroll />
        <p v-else class="muted">No courses yet.</p>
      </section>
    </template>
    <div v-else-if="!error" class="center"><ion-spinner /></div>
    <p v-if="error" class="muted">{{ error }}</p>

    <section class="teach">
      <h2>Teach on the marketplace</h2>
      <p>Share what you know. Create a course, we review it, and learners from everywhere can buy it.</p>
      <ion-button router-link="/market/teach">Become an instructor</ion-button>
    </section>
  </MarketShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IonButton, IonChip, IonSearchbar, IonSpinner } from '@ionic/vue';
import type { MktHomeDto } from '@erp/shared';
import { errorMessage } from '@/core/api';
import MarketShell from './components/MarketShell.vue';
import CourseGrid from './components/CourseGrid.vue';
import { marketApi } from './api';

const router = useRouter();
const home = ref<MktHomeDto | null>(null);
const error = ref('');
const q = ref('');

const rows = computed(() =>
  home.value
    ? [
        {
          key: 'featured',
          title: 'Most popular',
          courses: home.value.featured,
          more: '/market/search?sort=popular',
        },
        {
          key: 'newest',
          title: 'New and noteworthy',
          courses: home.value.newest,
          more: '/market/search?sort=newest',
        },
        { key: 'free', title: 'Free courses', courses: home.value.free, more: '/market/search?price=free' },
      ]
    : [],
);

async function load() {
  error.value = '';
  try {
    home.value = await marketApi.home();
  } catch (e) {
    error.value = errorMessage(e);
  }
}

function go() {
  void router.push({ path: '/market/search', query: q.value.trim() ? { q: q.value.trim() } : {} });
}

onMounted(load);
</script>

<style scoped>
.hero {
  padding: 24px 16px;
  border-radius: 16px;
  background: linear-gradient(
    135deg,
    rgba(var(--ion-color-primary-rgb), 0.14),
    rgba(var(--ion-color-tertiary-rgb), 0.14)
  );
  margin-bottom: 16px;
}
.hero h1 {
  margin: 0 0 6px;
  font-size: clamp(22px, 4vw, 34px);
}
.hero p {
  margin: 0 0 12px;
  color: var(--ion-color-medium-shade);
}
.hero-search ion-searchbar {
  padding: 0;
  max-width: 560px;
}
.cats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.row {
  margin: 20px 0;
}
.row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.row-head h2 {
  font-size: 20px;
  margin: 0 0 10px;
}
.teach {
  margin: 32px 0 16px;
  padding: 20px;
  border-radius: 16px;
  background: var(--ion-color-light);
}
.teach h2 {
  margin-top: 0;
}
.center {
  text-align: center;
  padding: 40px;
}
.muted {
  color: var(--ion-color-medium);
}
</style>

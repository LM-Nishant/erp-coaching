<template>
  <MarketShell :title="seller?.displayName ?? 'Instructor'" back-href="/market" wide>
    <template v-if="seller">
      <header class="head">
        <img v-if="seller.avatarUrl" :src="seller.avatarUrl" alt="" />
        <div v-else class="avatar">{{ seller.displayName.charAt(0) }}</div>
        <div>
          <p class="kind">{{ seller.type === 'institute' ? 'Coaching institute' : 'Instructor' }}</p>
          <h1>{{ seller.displayName }}</h1>
          <p v-if="seller.headline" class="headline">{{ seller.headline }}</p>
          <div class="stats">
            <div>
              <strong>{{ seller.studentCount }}</strong> learners
            </div>
            <div>
              <strong>{{ seller.courseCount }}</strong> courses
            </div>
            <div v-if="seller.ratingCount">
              <strong>★ {{ seller.ratingAvg.toFixed(1) }}</strong> rating
            </div>
          </div>
          <a
            v-if="seller.website"
            :href="seller.website"
            target="_blank"
            rel="noopener noreferrer nofollow"
            >{{ seller.website }}</a
          >
        </div>
      </header>
      <section v-if="seller.bio">
        <h2>About</h2>
        <p class="prose">{{ seller.bio }}</p>
      </section>
      <section>
        <h2>Courses</h2>
        <CourseGrid :courses="seller.courses" />
      </section>
    </template>
    <div v-else-if="!error" class="center"><ion-spinner /></div>
    <p v-if="error" class="center">{{ error }}</p>
  </MarketShell>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { IonSpinner } from '@ionic/vue';
import type { MktSellerPublicDto } from '@erp/shared';
import { errorMessage } from '@/core/api';
import MarketShell from './components/MarketShell.vue';
import CourseGrid from './components/CourseGrid.vue';
import { marketApi } from './api';

const route = useRoute();
const seller = ref<MktSellerPublicDto | null>(null);
const error = ref('');

watch(
  () => route.params.slug,
  async (slug) => {
    if (!slug) return;
    error.value = '';
    try {
      seller.value = await marketApi.instructor(String(slug));
    } catch (e) {
      error.value = errorMessage(e);
    }
  },
  { immediate: true },
);
</script>

<style scoped>
.head {
  display: flex;
  gap: 20px;
  align-items: center;
  flex-wrap: wrap;
}
.head img,
.avatar {
  width: 112px;
  height: 112px;
  border-radius: 50%;
  object-fit: cover;
}
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ion-color-primary);
  color: #fff;
  font-size: 44px;
  font-weight: 700;
}
.kind {
  text-transform: uppercase;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: var(--ion-color-medium);
  margin: 0;
}
h1 {
  margin: 2px 0;
}
.headline {
  margin: 0 0 8px;
}
.stats {
  display: flex;
  gap: 20px;
  margin-bottom: 6px;
}
.prose {
  white-space: pre-wrap;
  line-height: 1.55;
}
.center {
  text-align: center;
  padding: 40px;
}
</style>

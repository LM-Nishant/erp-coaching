<template>
  <MarketShell title="My learning" :on-refresh="load" wide>
    <div v-if="items.length" class="grid">
      <router-link
        v-for="e in items"
        :key="e.course.id"
        :to="`/market/learn/${e.course.id}`"
        class="card"
        :data-testid="`learning-${e.course.slug}`"
      >
        <img v-if="e.course.thumbnailUrl" :src="e.course.thumbnailUrl" alt="" />
        <div class="body">
          <h3>{{ e.course.title }}</h3>
          <p class="muted">{{ e.course.seller.displayName }}</p>
          <ion-progress-bar :value="e.progressPercent / 100" />
          <p class="muted">
            {{
              e.completedAt
                ? 'Completed'
                : e.progressPercent
                  ? `${e.progressPercent}% complete`
                  : 'Start course'
            }}
          </p>
        </div>
      </router-link>
    </div>
    <section v-if="certificates.length" class="certificates" data-testid="my-certificates">
      <h2>Certificates</h2>
      <ion-list lines="full">
        <ion-item v-for="c in certificates" :key="c.code" :data-testid="`certificate-${c.code}`">
          <ion-icon slot="start" :icon="ribbonOutline" color="success" />
          <ion-label class="ion-text-wrap">
            <h3>{{ c.courseTitle }}</h3>
            <p>{{ c.sellerName }} · {{ new Date(c.issuedAt).toLocaleDateString('en-IN') }} · {{ c.code }}</p>
          </ion-label>
          <ion-buttons slot="end">
            <ion-button aria-label="Download certificate" @click="openFileLink(certificatePdfUrl(c.code))">
              <ion-icon slot="icon-only" :icon="downloadOutline" />
            </ion-button>
            <ion-button aria-label="View certificate" :router-link="c.verifyPath">
              <ion-icon slot="icon-only" :icon="openOutline" />
            </ion-button>
          </ion-buttons>
        </ion-item>
      </ion-list>
    </section>
    <div v-if="loaded && !items.length" class="empty">
      <p>You haven't joined any course yet.</p>
      <ion-button router-link="/market">Browse courses</ion-button>
    </div>
  </MarketShell>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonButton, IonButtons, IonIcon, IonItem, IonLabel, IonList, IonProgressBar } from '@ionic/vue';
import { downloadOutline, openOutline, ribbonOutline } from 'ionicons/icons';
import type { MktCertificateDto, MktEnrolmentDto } from '@erp/shared';
import { openFileLink } from '@/core/downloads';
import { toastError } from '@/core/toast';
import { certificatePdfUrl, quizApi } from './quiz-api';
import MarketShell from './components/MarketShell.vue';
import { marketApi } from './api';

const items = ref<MktEnrolmentDto[]>([]);
const loaded = ref(false);
const certificates = ref<MktCertificateDto[]>([]);

async function load() {
  try {
    [items.value, certificates.value] = await Promise.all([marketApi.myLearning(), quizApi.certificates()]);
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}
onMounted(load);
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.card {
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  color: inherit;
  text-decoration: none;
}
.card img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
}
.body {
  padding: 10px 12px;
}
h3 {
  font-size: 15px;
  margin: 0 0 4px;
}
.muted {
  color: var(--ion-color-medium);
  font-size: 12px;
  margin: 6px 0 0;
}
.certificates {
  margin-top: 24px;
}
.certificates h2 {
  font-size: 18px;
}
.empty {
  text-align: center;
  padding: 40px;
}
</style>

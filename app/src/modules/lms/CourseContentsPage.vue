<template>
  <AppPage :title="data?.course.name ?? 'Course'" back-href="/lms" :on-refresh="load">
    <template v-if="data">
      <p class="muted">
        {{ data.stats.completed }} of {{ data.stats.total }} completed ({{ data.stats.percent }}%)
        <span v-if="!data.entitled"> · paid lectures are locked until you are enrolled</span>
      </p>
      <ion-progress-bar :value="data.stats.percent / 100" />

      <ResourceList :items="data.resources" />
      <ion-accordion-group :multiple="true">
        <ion-accordion v-for="s in data.subjects" :key="s.id" :value="`s${s.id}`">
          <ion-item slot="header"
            ><ion-label>{{ s.name }}</ion-label></ion-item
          >
          <div slot="content">
            <ResourceList :items="s.resources" />
            <div v-for="c in s.chapters" :key="c.id" class="chapter">
              <h3>{{ c.name }}</h3>
              <ResourceList :items="c.resources" />
              <div v-for="t in c.topics" :key="t.id" class="topic">
                <h4>{{ t.name }}</h4>
                <ResourceList :items="t.resources" />
              </div>
            </div>
          </div>
        </ion-accordion>
      </ion-accordion-group>
      <p v-if="!data.stats.total" class="muted">No content has been published for this course yet.</p>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonAccordion,
  IonAccordionGroup,
  IonItem,
  IonLabel,
  IonProgressBar,
  onIonViewWillEnter,
} from '@ionic/vue';
import type { LmsCourseContentsDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { lmsApi } from './api';
import ResourceList from './ResourceList.vue';

const route = useRoute();
const data = ref<LmsCourseContentsDto | null>(null);

async function load() {
  try {
    data.value = await lmsApi.contents(Number(route.params.id));
  } catch (e) {
    await toastError(e);
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.chapter {
  padding-left: 12px;
}
.chapter h3,
.topic h4 {
  margin: 12px 16px 4px;
  font-size: 0.95rem;
}
.topic {
  padding-left: 12px;
}
</style>

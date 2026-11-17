<template>
  <AppPage title="Guardians" :on-refresh="load">
    <ion-searchbar v-model="search" :debounce="300" placeholder="Name, mobile or email" @ion-input="load" />
    <ion-segment v-model="status" @ion-change="load">
      <ion-segment-button value="all"><ion-label>All</ion-label></ion-segment-button>
      <ion-segment-button value="active"><ion-label>Active</ion-label></ion-segment-button>
      <ion-segment-button value="pending"><ion-label>Pending</ion-label></ion-segment-button>
    </ion-segment>
    <ion-list>
      <ion-item v-for="g in guardians" :key="g.id">
        <ion-label class="ion-text-wrap">
          <h2>{{ g.name }}</h2>
          <p>
            {{ g.mobile }}<span v-if="g.email"> · {{ g.email }}</span
            ><span v-if="g.occupation"> · {{ g.occupation }}</span>
          </p>
          <p>
            <span v-for="c in g.children" :key="c.linkId" class="child">
              <router-link :to="`/students/${c.studentId}`">{{ c.name }}</router-link>
              ({{ humanize(c.relation) }}<span v-if="c.status !== 'active'">, {{ c.status }}</span
              >)
            </span>
          </p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!loading && !guardians.length"
        ><ion-label class="muted"
          >No guardians found. Link guardians from a student's profile.</ion-label
        ></ion-item
      >
    </ion-list>
    <ion-infinite-scroll :disabled="guardians.length >= total" @ion-infinite="more"
      ><ion-infinite-scroll-content
    /></ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import type { GuardianDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { humanize } from '@/modules/students/api';
import { guardiansApi } from './api';

const guardians = ref<GuardianDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);
const search = ref('');
const status = ref<'all' | 'active' | 'pending'>('all');

async function fetchPage() {
  const res = await guardiansApi.list({
    page: page.value,
    search: search.value || undefined,
    status: status.value === 'all' ? undefined : status.value,
  });
  total.value = res.total;
  return res.items;
}

async function load() {
  loading.value = true;
  page.value = 1;
  try {
    guardians.value = await fetchPage();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  try {
    guardians.value.push(...(await fetchPage()));
  } catch (e) {
    await toastError(e);
  } finally {
    await ev.target.complete();
  }
}

onMounted(load);
</script>

<style scoped>
.child + .child::before {
  content: ' · ';
}
</style>

<template>
  <AppPage title="My children" :on-refresh="load">
    <ion-list>
      <ion-item
        v-for="c in children"
        :key="c.studentId"
        button
        detail
        :router-link="`/my-children/${c.studentId}`"
      >
        <ion-label>
          <h2>
            {{ c.name }} <ion-badge :color="STATUS_COLORS[c.status]">{{ c.status }}</ion-badge>
          </h2>
          <p>
            {{ c.admissionNumber }}<span v-if="c.rollNumber"> · Roll {{ c.rollNumber }}</span>
            <span v-if="c.branchName"> · {{ c.branchName }}</span>
          </p>
          <p>You are linked as {{ humanize(c.relation) }}<span v-if="c.isPrimary"> (primary)</span></p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!loading && !children.length">
        <ion-label class="muted ion-text-wrap"
          >No children are linked to your account yet. Please contact the institute.</ion-label
        >
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonBadge, IonItem, IonLabel, IonList } from '@ionic/vue';
import type { ChildSummaryDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { STATUS_COLORS, humanize } from '@/modules/students/api';
import { guardianPortalApi } from './api';

const children = ref<ChildSummaryDto[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    children.value = await guardianPortalApi.children();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

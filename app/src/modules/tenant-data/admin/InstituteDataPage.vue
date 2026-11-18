<template>
  <AppPage
    :title="institute ? `${institute.name}: data` : 'Institute data'"
    back-href="/admin/institutes"
    :on-refresh="refresh"
  >
    <div v-if="institute" class="chip-row head">
      <ion-badge color="light">{{ institute.slug }}</ion-badge>
      <ion-badge :color="institute.status === 'active' ? 'success' : 'medium'">{{
        institute.status
      }}</ion-badge>
      <ion-button size="small" fill="clear" :router-link="`/admin/billing/institutes/${id}`"
        >Billing & subscription</ion-button
      >
    </div>
    <template v-if="id && institute">
      <ExportsCard :key="`exports-${id}`" ref="exportsCard" :scope="scope" can-export />
      <DeletionCard
        :key="`deletion-${id}`"
        ref="deletionCard"
        :scope="scope"
        :slug="institute.slug"
        can-request
        admin
        @changed="loadInstitute"
      />
    </template>
    <p v-else-if="missing" class="muted">This institute no longer exists.</p>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { IonBadge, IonButton } from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import { ApiError } from '@/core/api';
import { toastError } from '@/core/toast';
import { adminApi, type InstituteDetail } from '@/modules/admin/api';
import { instituteScope } from '../api';
import DeletionCard from '../components/DeletionCard.vue';
import ExportsCard from '../components/ExportsCard.vue';

const route = useRoute();
const id = ref(0);
const institute = ref<InstituteDetail | null>(null);
const missing = ref(false);
const scope = computed(() => instituteScope(id.value));

const exportsCard = ref<InstanceType<typeof ExportsCard> | null>(null);
const deletionCard = ref<InstanceType<typeof DeletionCard> | null>(null);

async function loadInstitute() {
  try {
    institute.value = await adminApi.institute(id.value);
    missing.value = false;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      institute.value = null;
      missing.value = true;
    } else await toastError(e);
  }
}

async function refresh() {
  await Promise.all([loadInstitute(), exportsCard.value?.load(), deletionCard.value?.load()]);
}

watch(
  () => (route.name === 'admin-data-institute' ? Number(route.params.id) : 0),
  (next) => {
    if (!Number.isInteger(next) || next <= 0 || next === id.value) return;
    id.value = next;
    institute.value = null;
    missing.value = false;
    void loadInstitute();
  },
  { immediate: true },
);
</script>

<style scoped>
.head {
  align-items: center;
  margin: 8px 4px;
}
</style>

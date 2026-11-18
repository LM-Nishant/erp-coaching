<template>
  <AppPage title="Data export & deletion" :on-refresh="refresh">
    <p v-if="!instituteWide" class="muted notice">
      Only administrators with access to every branch can export or delete the institute's data.
    </p>
    <template v-else-if="institute">
      <ExportsCard ref="exportsCard" :scope="ownInstitute" :can-export="auth.can('tenant-data.export')" />
      <DeletionCard
        ref="deletionCard"
        :scope="ownInstitute"
        :slug="institute.slug"
        :can-request="auth.can('tenant-data.delete')"
      />
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AppPage from '@/components/AppPage.vue';
import { useAuthStore } from '@/stores/auth';
import { ownInstitute } from './api';
import DeletionCard from './components/DeletionCard.vue';
import ExportsCard from './components/ExportsCard.vue';

const auth = useAuthStore();
const institute = computed(() => auth.me?.institute ?? null);
/** Branch-limited administrators can't act on institute-wide data. */
const instituteWide = computed(() => auth.me?.allowedBranchIds === null);

const exportsCard = ref<InstanceType<typeof ExportsCard> | null>(null);
const deletionCard = ref<InstanceType<typeof DeletionCard> | null>(null);

async function refresh() {
  await Promise.all([exportsCard.value?.load(), deletionCard.value?.load()]);
}
</script>

<style scoped>
.notice {
  margin: 16px 4px;
}
</style>

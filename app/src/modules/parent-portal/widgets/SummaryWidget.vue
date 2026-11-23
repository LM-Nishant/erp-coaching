<template>
  <p v-if="loaded && !sections.length" class="muted">{{ $t('parentPortal.summary.empty') }}</p>
  <ParentSection v-for="s in sections" :key="s.key" :section="s" />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ParentChildDto, ParentPortalSectionDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import ParentSection from '../components/ParentSection.vue';
import { parentPortalApi } from '../api';

const props = defineProps<{ child: ParentChildDto }>();
const sections = ref<ParentPortalSectionDto[]>([]);
const loaded = ref(false);

watch(
  () => props.child.studentId,
  async (id) => {
    loaded.value = false;
    try {
      sections.value = await parentPortalApi.summary(id);
    } catch (e) {
      sections.value = [];
      await toastError(e);
    } finally {
      loaded.value = true;
    }
  },
  { immediate: true },
);
</script>

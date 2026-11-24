<template>
  <AppPage :title="t('guardians.children.title')" :on-refresh="load">
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
            {{ c.name }}
            <ion-badge :color="STATUS_COLORS[c.status]">{{
              t(`students.profile.status.${c.status}`)
            }}</ion-badge>
          </h2>
          <p>
            {{ c.admissionNumber
            }}<span v-if="c.rollNumber"> · {{ t('guardians.children.roll', { roll: c.rollNumber }) }}</span>
            <span v-if="c.branchName"> · {{ c.branchName }}</span>
          </p>
          <p>
            {{ t('guardians.children.linkedAs', { relation: t(`students.profile.relation.${c.relation}`) })
            }}<span v-if="c.isPrimary"> {{ t('guardians.children.primary') }}</span>
          </p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!loading && !children.length">
        <ion-label class="muted ion-text-wrap">{{ t('guardians.children.none') }}</ion-label>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonBadge, IonItem, IonLabel, IonList } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import type { ChildSummaryDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { STATUS_COLORS } from '@/modules/students/api';
import { guardianPortalApi } from './api';

const { t } = useI18n();
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

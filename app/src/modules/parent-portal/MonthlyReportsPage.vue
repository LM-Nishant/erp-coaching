<template>
  <AppPage :title="t('parentPortal.monthly.title')" :on-refresh="load">
    <ion-segment v-if="children.length > 1" v-model="studentId" scrollable @ion-change="loadReports">
      <ion-segment-button v-for="c in children" :key="c.studentId" :value="c.studentId">
        <ion-label>{{ c.name }}</ion-label>
      </ion-segment-button>
    </ion-segment>
    <ion-accordion-group>
      <ion-accordion v-for="r in reports" :key="r.id" :value="String(r.id)">
        <ion-item slot="header">
          <ion-label>
            <h2>{{ monthName(r.period) }}</h2>
            <p>{{ t('parentPortal.monthly.generated', { date: formatDate(r.generatedAt) }) }}</p>
          </ion-label>
        </ion-item>
        <div slot="content" class="ion-padding">
          <p v-if="!r.sections.length" class="muted">{{ t('parentPortal.monthly.noActivity') }}</p>
          <ParentSection v-for="s in r.sections" :key="s.key" :section="s" />
        </div>
      </ion-accordion>
    </ion-accordion-group>
    <ion-list v-if="!loading && !reports.length">
      <ion-item>
        <ion-label class="muted ion-text-wrap">
          {{ t('parentPortal.monthly.none') }}
        </ion-label>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonAccordion,
  IonAccordionGroup,
  IonItem,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import type { ParentChildDto, ParentMonthlyReportDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { formatDate } from '@/core/format';
import { toastError } from '@/core/toast';
import { intlLocale } from '@/i18n';
import ParentSection from './components/ParentSection.vue';
import { parentPortalApi } from './api';

const { t } = useI18n();
const children = ref<ParentChildDto[]>([]);
const studentId = ref<number | undefined>();
const reports = ref<ParentMonthlyReportDto[]>([]);
const loading = ref(true);

const monthName = (period: string) =>
  new Intl.DateTimeFormat(intlLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${period}-01T12:00:00Z`),
  );

async function loadReports() {
  if (!studentId.value) return;
  try {
    reports.value = await parentPortalApi.monthlyReports(studentId.value);
  } catch (e) {
    reports.value = [];
    await toastError(e);
  }
}

async function load() {
  loading.value = true;
  try {
    children.value = await parentPortalApi.children();
    if (!children.value.some((c) => c.studentId === studentId.value)) {
      studentId.value = children.value[0]?.studentId;
    }
    await loadReports();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

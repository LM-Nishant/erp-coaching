<template>
  <AppPage :title="t('appointments.reports.title')" :on-refresh="load">
    <template #actions>
      <ion-button :disabled="downloading" :aria-label="t('appointments.downloadCsv')" @click="download">
        <ion-icon slot="icon-only" :icon="downloadOutline" />
      </ion-button>
    </template>
    <ion-list>
      <ion-item>
        <ion-input
          v-model="filters.from"
          type="date"
          :label="t('common.labels.from')"
          label-placement="stacked"
          @ion-change="load"
        />
        <ion-input
          v-model="filters.to"
          type="date"
          :label="t('common.labels.to')"
          label-placement="stacked"
          @ion-change="load"
        />
      </ion-item>
      <ion-item v-if="branches.length > 1">
        <ion-select
          v-model="filters.branchId"
          :label="t('appointments.fields.branch')"
          interface="popover"
          @ion-change="load"
        >
          <ion-select-option :value="null">{{ t('appointments.reports.allBranches') }}</ion-select-option>
          <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
        </ion-select>
      </ion-item>
    </ion-list>

    <template v-if="summary">
      <div class="stats">
        <StatCard :label="t('appointments.reports.meetings')" :value="formatNumber(summary.total)" />
        <StatCard :label="t('appointments.reports.held')" :value="formatNumber(summary.byStatus.completed)" />
        <StatCard :label="t('common.status.pending')" :value="formatNumber(summary.byStatus.requested)" />
        <StatCard
          :label="t('appointments.reports.avgResponse')"
          :value="formatDuration(summary.avgResponseHours === null ? null : summary.avgResponseHours * 3600)"
        />
        <StatCard
          :label="t('appointments.mode.online')"
          :value="formatNumber(summary.byMode.online)"
          :hint="t('appointments.reports.inPerson', { n: formatNumber(summary.byMode.offline) })"
        />
        <StatCard
          :label="t('appointments.reports.noShows')"
          :value="formatNumber(summary.byStatus.no_show)"
        />
      </div>

      <ion-list>
        <ion-list-header
          ><ion-label>{{ t('appointments.reports.byBranch') }}</ion-label></ion-list-header
        >
        <ion-item v-for="b in summary.byBranch" :key="b.branchId">
          <ion-label>{{
            b.branchName ?? t('appointments.reports.branchNumber', { id: b.branchId })
          }}</ion-label>
          <ion-note slot="end">{{
            t('appointments.reports.heldOf', {
              held: formatNumber(b.completed),
              total: formatNumber(b.total),
            })
          }}</ion-note>
        </ion-item>
      </ion-list>

      <ion-list>
        <ion-list-header
          ><ion-label>{{ t('appointments.reports.byTeacher') }}</ion-label></ion-list-header
        >
        <ion-item v-for="row in summary.byTeacher" :key="row.teacherUserId">
          <ion-label class="ion-text-wrap">
            <h2>{{ row.teacherName ?? `#${row.teacherUserId}` }}</h2>
            <p>
              {{
                t('appointments.reports.teacherLine', {
                  total: formatNumber(row.total),
                  confirmed: formatNumber(row.confirmed),
                  held: formatNumber(row.completed),
                  rejected: formatNumber(row.rejected),
                  cancelled: formatNumber(row.cancelled),
                })
              }}
            </p>
          </ion-label>
        </ion-item>
        <ion-item v-if="!summary.byTeacher.length">
          <ion-label class="muted">{{ t('appointments.reports.empty') }}</ion-label>
        </ion-item>
      </ion-list>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSelect,
  IonSelectOption,
} from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { AppointmentReportSummary } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { saveFile } from '@/core/downloads';
import { formatDuration, formatNumber } from '@/core/format';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { addDaysIso, appointmentsApi, todayIso, type ReportFilters } from './api';

const { t } = useI18n();
const auth = useAuthStore();
const branches = computed(() => auth.me?.branches ?? []);
const filters = reactive<ReportFilters>({
  from: addDaysIso(todayIso(), -30),
  to: todayIso(),
  branchId: null,
});
const summary = ref<AppointmentReportSummary | null>(null);
const downloading = ref(false);

const query = () => ({
  from: filters.from || undefined,
  to: filters.to || undefined,
  branchId: filters.branchId,
});

async function load() {
  try {
    summary.value = await appointmentsApi.summary(query());
  } catch (e) {
    await toastError(e);
  }
}

async function download() {
  downloading.value = true;
  try {
    const csv = await appointmentsApi.exportCsv(query());
    await saveFile(csv, `parent-meetings-${todayIso()}.csv`, 'text/csv');
  } catch (e) {
    await toastError(e);
  } finally {
    downloading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
  padding: 12px 16px;
}
</style>

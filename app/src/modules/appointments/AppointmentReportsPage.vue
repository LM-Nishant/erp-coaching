<template>
  <AppPage title="Meeting reports" :on-refresh="load">
    <template #actions>
      <ion-button :disabled="downloading" aria-label="Download CSV" @click="download">
        <ion-icon slot="icon-only" :icon="downloadOutline" />
      </ion-button>
    </template>
    <ion-list>
      <ion-item>
        <ion-input
          v-model="filters.from"
          type="date"
          label="From"
          label-placement="stacked"
          @ion-change="load"
        />
        <ion-input v-model="filters.to" type="date" label="To" label-placement="stacked" @ion-change="load" />
      </ion-item>
      <ion-item v-if="branches.length > 1">
        <ion-select v-model="filters.branchId" label="Branch" interface="popover" @ion-change="load">
          <ion-select-option :value="null">All branches</ion-select-option>
          <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
        </ion-select>
      </ion-item>
    </ion-list>

    <template v-if="summary">
      <div class="stats">
        <StatCard label="Meetings" :value="summary.total" />
        <StatCard label="Held" :value="summary.byStatus.completed" />
        <StatCard label="Pending" :value="summary.byStatus.requested" />
        <StatCard
          label="Avg. response"
          :value="summary.avgResponseHours === null ? '—' : `${summary.avgResponseHours.toFixed(1)} h`"
        />
        <StatCard
          label="Online"
          :value="summary.byMode.online"
          :hint="`${summary.byMode.offline} in person`"
        />
        <StatCard label="No-shows" :value="summary.byStatus.no_show" />
      </div>

      <ion-list>
        <ion-list-header><ion-label>By branch</ion-label></ion-list-header>
        <ion-item v-for="b in summary.byBranch" :key="b.branchId">
          <ion-label>{{ b.branchName ?? `Branch #${b.branchId}` }}</ion-label>
          <ion-note slot="end">{{ b.completed }} held / {{ b.total }}</ion-note>
        </ion-item>
      </ion-list>

      <ion-list>
        <ion-list-header><ion-label>By teacher</ion-label></ion-list-header>
        <ion-item v-for="t in summary.byTeacher" :key="t.teacherUserId">
          <ion-label class="ion-text-wrap">
            <h2>{{ t.teacherName ?? `#${t.teacherUserId}` }}</h2>
            <p>
              {{ t.total }} requests · {{ t.confirmed }} upcoming · {{ t.completed }} held ·
              {{ t.rejected }} rejected · {{ t.cancelled }} cancelled
            </p>
          </ion-label>
        </ion-item>
        <ion-item v-if="!summary.byTeacher.length">
          <ion-label class="muted">No meetings in this period.</ion-label>
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
import type { AppointmentReportSummary } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { addDaysIso, appointmentsApi, todayIso, type ReportFilters } from './api';

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
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `parent-meetings-${todayIso()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

<template>
  <AppPage title="Data deletion requests" :on-refresh="reload">
    <ion-searchbar v-model="search" :debounce="400" placeholder="Search institute name or code" />
    <div class="filters">
      <ion-select v-model="status" label="Status" label-placement="stacked" interface="popover">
        <ion-select-option value="">All</ion-select-option>
        <ion-select-option v-for="s in DELETION_STATUSES" :key="s" :value="s">{{
          DELETION_STATUS_LABELS[s]
        }}</ion-select-option>
      </ion-select>
    </div>

    <ion-list lines="full">
      <ion-item v-for="r in rows" :key="r.id">
        <ion-label class="ion-text-wrap">
          <h2>
            {{ r.instituteName }} <span class="muted">({{ r.instituteSlug }})</span>
          </h2>
          <p>Requested {{ formatWhen(r.createdAt) }} by {{ r.requestedByName ?? 'unknown' }}</p>
          <p v-if="r.reason">Reason: {{ r.reason }}</p>
          <p v-if="r.status === 'approved' || r.status === 'purging'">
            Permanent deletion {{ r.status === 'purging' ? 'started' : 'on' }}
            {{ formatWhen(r.scheduledFor) }}
          </p>
          <p v-if="r.decidedAt">
            Decided {{ formatWhen(r.decidedAt)
            }}<template v-if="r.decisionNote">: {{ r.decisionNote }}</template>
          </p>
          <p v-if="r.error" class="error">{{ r.error }}</p>
          <template v-if="r.status === 'completed'">
            <p>Deleted {{ formatWhen(r.completedAt) }} · {{ deletionTotals(r) }}</p>
            <p v-if="r.summary?.retainedTables.length" class="muted">
              Kept for the operator's records: {{ r.summary.retainedTables.join(', ') }}
            </p>
          </template>
          <div class="actions">
            <ion-button
              v-if="r.instituteId && r.status !== 'completed'"
              size="small"
              fill="clear"
              :router-link="`/admin/data/institutes/${r.instituteId}`"
              >Institute data</ion-button
            >
            <ion-button
              v-if="r.status === 'pending'"
              size="small"
              fill="outline"
              @click="decide(r, rejectDeletion)"
              >Reject</ion-button
            >
            <ion-button
              v-if="r.status === 'pending' || r.status === 'approved'"
              size="small"
              fill="outline"
              @click="decide(r, cancelDeletion)"
              >{{ r.status === 'approved' ? 'Cancel and reactivate' : 'Cancel' }}</ion-button
            >
            <ion-button
              v-if="r.status === 'pending'"
              size="small"
              color="danger"
              @click="decide(r, approveDeletion)"
              >Approve</ion-button
            >
            <ion-button
              v-if="r.status === 'failed'"
              size="small"
              color="danger"
              @click="decide(r, retryDeletion)"
              >Retry</ion-button
            >
          </div>
        </ion-label>
        <ion-badge slot="end" :color="DELETION_STATUS_COLORS[r.status]">{{
          DELETION_STATUS_LABELS[r.status]
        }}</ion-badge>
      </ion-item>
    </ion-list>
    <p v-if="!loading && !rows.length" class="muted">No deletion requests.</p>
    <p v-else class="muted">{{ total }} request(s)</p>
    <ion-button v-if="rows.length < total" fill="clear" expand="block" :disabled="loading" @click="more"
      >Load more</ion-button
    >
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
} from '@ionic/vue';
import type { DeletionRequestDto, DeletionRequestStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import {
  DELETION_STATUSES,
  DELETION_STATUS_COLORS,
  DELETION_STATUS_LABELS,
  deletionAdminApi,
  deletionTotals,
  formatWhen,
} from '../api';
import { approveDeletion, cancelDeletion, rejectDeletion, retryDeletion } from '../decisions';

const PAGE_SIZE = 25;

const rows = ref<DeletionRequestDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const search = ref('');
const status = ref<DeletionRequestStatus | ''>('');

async function fetchPage(p: number) {
  loading.value = true;
  try {
    const res = await deletionAdminApi.list({
      status: status.value || undefined,
      search: String(search.value ?? '').trim() || undefined,
      page: p,
      pageSize: PAGE_SIZE,
    });
    rows.value = p === 1 ? res.items : [...rows.value, ...res.items];
    total.value = res.total;
    page.value = p;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

const reload = () => fetchPage(1);
const more = () => fetchPage(page.value + 1);

async function decide(
  r: DeletionRequestDto,
  action: (r: DeletionRequestDto) => Promise<DeletionRequestDto | null>,
) {
  const updated = await action(r);
  if (!updated) return;
  // The row may leave the current status filter; reload keeps the list and the total consistent.
  if (status.value && updated.status !== status.value) await reload();
  else rows.value = rows.value.map((x) => (x.id === updated.id ? updated : x));
}

watch([search, status], () => void reload());
onMounted(reload);
</script>

<style scoped>
.filters {
  display: flex;
  gap: 12px;
  padding: 0 8px;
  max-width: 320px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.error {
  color: var(--ion-color-danger) !important;
}
</style>

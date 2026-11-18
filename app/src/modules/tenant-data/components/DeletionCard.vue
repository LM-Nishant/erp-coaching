<template>
  <ion-card>
    <ion-card-header>
      <ion-card-title>Delete institute</ion-card-title>
      <ion-card-subtitle
        >Permanently removes all of the institute's data and files, after approval and a grace
        period.</ion-card-subtitle
      >
    </ion-card-header>
    <ion-card-content>
      <div v-if="latest" class="status">
        <div class="status-head">
          <ion-badge :color="DELETION_STATUS_COLORS[latest.status]">{{
            DELETION_STATUS_LABELS[latest.status]
          }}</ion-badge>
          <span class="muted"
            >Requested {{ formatWhen(latest.createdAt) }} by {{ latest.requestedByName ?? 'unknown' }}</span
          >
        </div>
        <p>{{ statusText }}</p>
        <p v-if="latest.reason"><strong>Reason:</strong> {{ latest.reason }}</p>
        <p v-if="latest.decisionNote"><strong>Note:</strong> {{ latest.decisionNote }}</p>
        <p v-if="latest.error" class="error">{{ latest.error }}</p>
        <p v-if="latest.status === 'completed'">{{ deletionTotals(latest) }}</p>
        <div class="actions">
          <template v-if="admin">
            <ion-button
              v-if="latest.status === 'pending'"
              fill="outline"
              :disabled="busy"
              @click="decide(rejectDeletion)"
              >Reject</ion-button
            >
            <ion-button
              v-if="latest.status === 'pending' || latest.status === 'approved'"
              fill="outline"
              :disabled="busy"
              @click="decide(cancelDeletion)"
              >{{ latest.status === 'approved' ? 'Cancel and reactivate' : 'Cancel request' }}</ion-button
            >
            <ion-button
              v-if="latest.status === 'pending'"
              color="danger"
              :disabled="busy"
              @click="decide(approveDeletion)"
              >Approve</ion-button
            >
            <ion-button
              v-if="latest.status === 'failed'"
              color="danger"
              :disabled="busy"
              @click="decide(retryDeletion)"
              >Retry</ion-button
            >
          </template>
          <ion-button
            v-else-if="canRequest && latest.status === 'pending'"
            fill="outline"
            :disabled="busy"
            @click="withdraw"
            >Withdraw request</ion-button
          >
        </div>
      </div>

      <template v-if="loaded && canRequest && canRequestDeletion(latest)">
        <ion-button v-if="!formOpen" color="danger" fill="outline" @click="formOpen = true"
          >Request deletion…</ion-button
        >
        <div v-else class="form">
          <p class="warning">
            <template v-if="admin">
              Raise the request on the institute's behalf, for example after a written request. It still needs
              approval.
            </template>
            Once approved, the institute is deactivated at once (nobody can sign in) and, when the grace
            period ends, every record (students, staff, fees, attendance, exams, courses…) and every uploaded
            file is permanently deleted. Download a data export first: this can't be undone.
          </p>
          <ion-textarea
            v-model="reason"
            fill="outline"
            label="Reason (optional)"
            label-placement="stacked"
            :maxlength="1000"
            auto-grow
          />
          <ion-input
            v-model="confirmText"
            fill="outline"
            :label="`Type the institute code ${slug} to confirm`"
            label-placement="stacked"
            autocomplete="off"
            autocapitalize="off"
          />
          <div class="actions">
            <ion-button fill="clear" :disabled="busy" @click="formOpen = false">Cancel</ion-button>
            <ion-button color="danger" :disabled="busy || !confirmed" @click="submit"
              >Request deletion</ion-button
            >
          </div>
        </div>
      </template>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonInput,
  IonTextarea,
  alertController,
} from '@ionic/vue';
import type { DeletionRequestDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import {
  DELETION_STATUS_COLORS,
  DELETION_STATUS_LABELS,
  canRequestDeletion,
  deletionTotals,
  formatWhen,
  withdrawOwnDeletion,
  type TenantDataScope,
} from '../api';
import { approveDeletion, cancelDeletion, rejectDeletion, retryDeletion } from '../decisions';

const props = defineProps<{
  scope: TenantDataScope;
  slug: string;
  canRequest: boolean;
  /** Super admin view: review actions instead of withdrawing. */
  admin?: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();

const latest = ref<DeletionRequestDto | null>(null);
const loaded = ref(false);
const busy = ref(false);
const formOpen = ref(false);
const reason = ref('');
const confirmText = ref('');

const confirmed = computed(
  () =>
    String(confirmText.value ?? '')
      .trim()
      .toLowerCase() === props.slug.toLowerCase(),
);

const statusText = computed(() => {
  const r = latest.value;
  if (!r) return '';
  switch (r.status) {
    case 'pending':
      return props.admin
        ? 'Approving deactivates the institute at once and schedules the permanent deletion after a grace period.'
        : 'The platform team will review the request. You can withdraw it until then.';
    case 'approved':
      return (
        `The institute is deactivated, and everything is permanently deleted on ${formatWhen(r.scheduledFor)}.` +
        (props.admin ? '' : ' Contact the platform team before then to cancel.')
      );
    case 'purging':
      return 'The permanent deletion is in progress.';
    case 'failed':
      return props.admin
        ? 'The deletion stopped with an error. Retrying continues where it stopped.'
        : 'The deletion stopped with an error; the platform team will retry it.';
    case 'completed':
      return `Permanently deleted on ${formatWhen(r.completedAt)}.`;
    case 'rejected':
      return `Rejected on ${formatWhen(r.decidedAt)}.`;
    case 'cancelled':
      return `Cancelled on ${formatWhen(r.decidedAt)}.`;
  }
  return '';
});

async function load() {
  try {
    latest.value = await props.scope.deletionRequest();
    loaded.value = true;
  } catch (e) {
    await toastError(e);
  }
}

async function submit() {
  busy.value = true;
  try {
    latest.value = await props.scope.requestDeletion({
      confirm: String(confirmText.value ?? '').trim(),
      reason: String(reason.value ?? '').trim() || null,
    });
    formOpen.value = false;
    reason.value = '';
    confirmText.value = '';
    await toast('Deletion requested');
    emit('changed');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function withdraw() {
  const alert = await alertController.create({
    header: 'Withdraw the deletion request?',
    message: 'Nothing is deleted. You can raise a new request later.',
    buttons: [
      { text: 'Back', role: 'cancel' },
      { text: 'Withdraw', role: 'confirm' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'confirm') return;
  busy.value = true;
  try {
    latest.value = await withdrawOwnDeletion();
    await toast('Request withdrawn');
    emit('changed');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function decide(action: (r: DeletionRequestDto) => Promise<DeletionRequestDto | null>) {
  if (!latest.value) return;
  busy.value = true;
  try {
    const updated = await action(latest.value);
    if (updated) {
      latest.value = updated;
      emit('changed');
    }
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
defineExpose({ load });
</script>

<style scoped>
.status-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.status p {
  margin: 4px 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0;
}
.form {
  display: grid;
  gap: 12px;
}
.warning {
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(var(--ion-color-danger-rgb), 0.1);
  color: var(--ion-color-danger-shade);
}
.error {
  color: var(--ion-color-danger);
}
</style>

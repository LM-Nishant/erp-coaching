<template>
  <ion-item button detail :router-link="`/appointments/${appointment.id}`">
    <ion-icon slot="start" :icon="appointment.mode === 'online' ? videocamOutline : peopleOutline" />
    <ion-label class="ion-text-wrap">
      <h2>
        {{ meetingWhen(appointment) }}
        <StatusChip
          :label="t(STATUS_LABEL_KEYS[appointment.status])"
          :tone="STATUS_TONES[appointment.status]"
        />
      </h2>
      <p>
        <span v-if="appointment.studentName">{{ appointment.studentName }}</span>
        <span v-if="appointment.teacher">
          · {{ t('appointments.item.with', { name: appointment.teacher.name }) }}</span
        >
        <span v-if="appointment.requestedBy && !hideRequester">
          · {{ t('appointments.item.by', { name: appointment.requestedBy.name }) }}</span
        >
      </p>
      <p v-if="appointment.agenda" class="muted">{{ appointment.agenda }}</p>
    </ion-label>
  </ion-item>
</template>

<script setup lang="ts">
import { IonIcon, IonItem, IonLabel } from '@ionic/vue';
import { peopleOutline, videocamOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { AppointmentDto } from '@erp/shared';
import StatusChip from '@/components/StatusChip.vue';
import { STATUS_LABEL_KEYS, STATUS_TONES, meetingWhen } from '../api';

defineProps<{ appointment: AppointmentDto; hideRequester?: boolean }>();
const { t } = useI18n();
</script>

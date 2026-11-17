<template>
  <ion-item button detail :router-link="`/appointments/${appointment.id}`">
    <ion-icon slot="start" :icon="appointment.mode === 'online' ? videocamOutline : peopleOutline" />
    <ion-label class="ion-text-wrap">
      <h2>
        {{ appointment.date }} · {{ appointment.startTime }}–{{ appointment.endTime }}
        <ion-badge :color="STATUS_COLORS[appointment.status]">{{ humanize(appointment.status) }}</ion-badge>
      </h2>
      <p>
        <span v-if="appointment.studentName">{{ appointment.studentName }}</span>
        <span v-if="appointment.teacher"> · with {{ appointment.teacher.name }}</span>
        <span v-if="appointment.requestedBy && !hideRequester"> · by {{ appointment.requestedBy.name }}</span>
      </p>
      <p v-if="appointment.agenda" class="muted">{{ appointment.agenda }}</p>
    </ion-label>
  </ion-item>
</template>

<script setup lang="ts">
import { IonBadge, IonIcon, IonItem, IonLabel } from '@ionic/vue';
import { peopleOutline, videocamOutline } from 'ionicons/icons';
import type { AppointmentDto } from '@erp/shared';
import { STATUS_COLORS, humanize } from '../api';

defineProps<{ appointment: AppointmentDto; hideRequester?: boolean }>();
</script>

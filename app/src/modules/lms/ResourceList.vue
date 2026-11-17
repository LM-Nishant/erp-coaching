<template>
  <ion-list v-if="items.length" lines="inset">
    <ion-item
      v-for="r in items"
      :key="r.id"
      :router-link="r.locked ? undefined : `/lms/resources/${r.id}`"
      :detail="!r.locked"
      :disabled="r.locked"
    >
      <ion-icon slot="start" :icon="r.locked ? lockClosedOutline : iconFor(r.type)" />
      <ion-label>
        <h3>{{ r.title }}</h3>
        <p>
          {{ RESOURCE_TYPE_LABEL[r.type] }}
          <span v-if="r.durationSeconds"> · {{ formatDuration(r.durationSeconds) }}</span>
          <span v-if="r.locked"> · {{ lockText[r.lockReason ?? 'not-entitled'] }}</span>
          <span v-else-if="r.accessUntil"> · until {{ new Date(r.accessUntil).toLocaleDateString() }}</span>
        </p>
        <ion-progress-bar v-if="r.progress && !r.progress.completed" :value="r.progress.percent / 100" />
      </ion-label>
      <ion-badge v-if="r.access === 'free'" slot="end" color="success">free</ion-badge>
      <ion-icon v-if="r.progress?.completed" slot="end" color="success" :icon="checkmarkCircle" />
    </ion-item>
  </ion-list>
</template>

<script setup lang="ts">
import { IonBadge, IonIcon, IonItem, IonLabel, IonList, IonProgressBar } from '@ionic/vue';
import {
  checkmarkCircle,
  documentOutline,
  easelOutline,
  linkOutline,
  lockClosedOutline,
  playCircleOutline,
  readerOutline,
} from 'ionicons/icons';
import type { LmsLearnerResourceDto, LmsResourceType } from '@erp/shared';
import { RESOURCE_TYPE_LABEL, formatDuration } from './api';

defineProps<{ items: LmsLearnerResourceDto[] }>();

const lockText: Record<string, string> = {
  'not-entitled': 'enrol to unlock',
  expired: 'access expired',
  'not-yet-available': 'not available yet',
};
const icons: Record<LmsResourceType, string> = {
  video: playCircleOutline,
  notes: readerOutline,
  ppt: easelOutline,
  document: documentOutline,
  link: linkOutline,
};
const iconFor = (t: LmsResourceType) => icons[t];
</script>

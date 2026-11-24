<template>
  <ion-item button :router-link="`/doubts/${doubt.id}`" :detail="false" class="doubt-item">
    <ion-label class="ion-text-wrap">
      <div class="top">
        <span class="context">{{ context }}</span>
        <StatusChip :label="t(`doubts.status.${doubt.status}`)" :tone="STATUS_TONE[doubt.status]" />
      </div>
      <p class="question">{{ doubt.question }}</p>
      <p class="meta">
        <span v-if="showStudent">{{ doubt.student?.name }} · </span>
        <ion-icon v-if="doubt.hasPhoto" :icon="imageOutline" aria-hidden="true" />
        <span v-if="doubt.replyCount" class="replies">
          <ion-icon :icon="chatbubbleOutline" aria-hidden="true" /> {{ formatNumber(doubt.replyCount) }}
        </span>
        {{ formatRelative(doubt.lastActivityAt) }}
      </p>
    </ion-label>
  </ion-item>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonIcon, IonItem, IonLabel } from '@ionic/vue';
import { chatbubbleOutline, imageOutline } from 'ionicons/icons';
import type { DoubtDto } from '@erp/shared';
import StatusChip from '@/components/StatusChip.vue';
import { formatNumber, formatRelative } from '@/core/format';
import { STATUS_TONE, clock } from './api';

const props = defineProps<{ doubt: DoubtDto; showStudent?: boolean }>();
const { t } = useI18n();

const context = computed(() => {
  const d = props.doubt;
  const parts = [d.subject?.name, d.lecture?.title ?? d.liveClass?.title].filter(Boolean);
  if (d.lecture?.positionSeconds != null) parts.push(clock(d.lecture.positionSeconds));
  return parts.join(' · ') || d.batch?.name || '';
});
</script>

<style scoped>
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.context {
  font-size: 13px;
  color: var(--ion-color-medium-shade);
  overflow: hidden;
  text-overflow: ellipsis;
}
.question {
  color: var(--ion-text-color) !important;
  font-size: 15px !important;
  margin: 4px 0 !important;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px !important;
}
.replies {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
</style>

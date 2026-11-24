<template>
  <ion-item button :router-link="`/grievances/${ticket.id}`" detail>
    <ion-label>
      <h2>
        <span class="muted">{{ ticket.ticketNumber }}</span> · {{ ticket.subject }}
      </h2>
      <p class="chips">
        <StatusChip :label="t(statusKey(ticket.status))" :tone="STATUS_TONES[ticket.status]" />
        <StatusChip :label="t(priorityKey(ticket.priority))" :tone="PRIORITY_TONES[ticket.priority]" />
        <StatusChip
          v-if="ticket.slaBreached || isOverdue(ticket)"
          :label="t('grievances.slaBreached')"
          tone="danger"
        />
        {{ ticket.categoryName }}
      </p>
      <p>
        <template v-if="showRequester">
          <template v-if="ticket.onBehalfOf">{{
            t('grievances.item.requesterFor', {
              requester: ticket.requester?.name ?? '',
              name: ticket.onBehalfOf.name,
            })
          }}</template>
          <template v-else>{{ ticket.requester?.name }}</template>
          ·
        </template>
        <template v-else-if="ticket.onBehalfOf"
          >{{ t('grievances.item.forName', { name: ticket.onBehalfOf.name }) }} ·
        </template>
        {{
          ticket.assignee
            ? t('grievances.item.assignedTo', { name: ticket.assignee.name })
            : t('grievances.unassigned')
        }}
        · {{ t('grievances.item.due', { date: formatDateTime(ticket.dueAt) }) }}
      </p>
    </ion-label>
  </ion-item>
</template>

<script setup lang="ts">
import { IonItem, IonLabel } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import type { GrievanceTicketDto } from '@erp/shared';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime } from '@/core/format';
import { PRIORITY_TONES, STATUS_TONES, isOverdue, priorityKey, statusKey } from './api';

defineProps<{ ticket: GrievanceTicketDto; showRequester?: boolean }>();
const { t } = useI18n();
</script>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
</style>

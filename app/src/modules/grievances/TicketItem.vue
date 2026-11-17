<template>
  <ion-item button :router-link="`/grievances/${ticket.id}`" detail>
    <ion-label>
      <h2>
        <span class="muted">{{ ticket.ticketNumber }}</span> · {{ ticket.subject }}
      </h2>
      <p>
        <ion-badge :color="STATUS_COLORS[ticket.status]">{{ statusLabel(ticket.status) }}</ion-badge>
        <ion-badge :color="PRIORITY_COLORS[ticket.priority]">{{ ticket.priority }}</ion-badge>
        <ion-badge v-if="ticket.slaBreached || isOverdue(ticket)" color="danger">SLA breached</ion-badge>
        {{ ticket.categoryName }}
      </p>
      <p>
        <template v-if="showRequester">
          {{ ticket.requester?.name
          }}<template v-if="ticket.onBehalfOf"> for {{ ticket.onBehalfOf.name }}</template>
          ·
        </template>
        <template v-else-if="ticket.onBehalfOf">For {{ ticket.onBehalfOf.name }} · </template>
        {{ ticket.assignee ? `Assigned to ${ticket.assignee.name}` : 'Unassigned' }} · Due
        {{ formatDate(ticket.dueAt) }}
      </p>
    </ion-label>
  </ion-item>
</template>

<script setup lang="ts">
import { IonBadge, IonItem, IonLabel } from '@ionic/vue';
import type { GrievanceTicketDto } from '@erp/shared';
import { PRIORITY_COLORS, STATUS_COLORS, formatDate, isOverdue, statusLabel } from './api';

defineProps<{ ticket: GrievanceTicketDto; showRequester?: boolean }>();
</script>

<style scoped>
ion-badge {
  margin-right: 4px;
  text-transform: capitalize;
}
</style>

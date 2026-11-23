<template>
  <ion-list lines="none">
    <AppointmentItem v-for="a in items" :key="a.id" :appointment="a" hide-requester />
    <ion-item v-if="loaded && !items.length">
      <ion-label class="muted ion-text-wrap">{{
        t('appointments.widget.empty', { name: child.name })
      }}</ion-label>
    </ion-item>
  </ion-list>
  <ion-button
    v-if="auth.can('appointments.create')"
    fill="clear"
    size="small"
    :router-link="`/appointments/request?studentId=${child.studentId}`"
    >{{ t('appointments.request.title') }}</ion-button
  >
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { IonButton, IonItem, IonLabel, IonList } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import type { AppointmentDto, ParentChildDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import AppointmentItem from './AppointmentItem.vue';
import { appointmentsApi, todayIso } from '../api';

const props = defineProps<{ child: ParentChildDto }>();
const { t } = useI18n();
const auth = useAuthStore();
const items = ref<AppointmentDto[]>([]);
const loaded = ref(false);

watch(
  () => props.child.studentId,
  async (studentId) => {
    loaded.value = false;
    try {
      const res = await appointmentsApi.mine({ studentId, upcoming: true, from: todayIso(), pageSize: 5 });
      items.value = res.items.filter((a) => a.status === 'requested' || a.status === 'confirmed');
    } catch (e) {
      await toastError(e);
    } finally {
      loaded.value = true;
    }
  },
  { immediate: true },
);
</script>

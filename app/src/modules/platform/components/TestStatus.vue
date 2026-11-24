<template>
  <div v-if="shown" class="test-result" :class="shown.ok ? 'ok' : 'fail'">
    <ion-icon :icon="shown.ok ? checkmarkCircle : alertCircle" />
    <span
      >{{
        t('platform.test.result', {
          outcome: shown.ok ? t('platform.test.passed') : t('platform.test.failed'),
          message: shown.message,
        })
      }}
      <span class="muted">({{ formatDateTime(shown.at) }})</span></span
    >
  </div>
  <p v-else class="muted small">{{ t('platform.test.notTested') }}</p>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonIcon } from '@ionic/vue';
import { alertCircle, checkmarkCircle } from 'ionicons/icons';
import type { IntegrationTestResultDto, IntegrationTestStatus } from '@erp/shared';
import { formatDateTime } from '@/core/format';
import { lastTest } from '../api';

const { t } = useI18n();
const props = defineProps<{ status: IntegrationTestStatus; result: IntegrationTestResultDto | null }>();
const shown = computed(() => lastTest(props.status, props.result));
</script>

<style scoped>
.test-result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin: 8px 0;
  border-radius: 6px;
  font-size: 14px;
}
.test-result.ok {
  background: rgba(var(--ion-color-success-rgb), 0.12);
  color: var(--ion-color-success-shade);
}
.test-result.fail {
  background: rgba(var(--ion-color-danger-rgb), 0.1);
  color: var(--ion-color-danger);
}
.small {
  font-size: 13px;
}
</style>

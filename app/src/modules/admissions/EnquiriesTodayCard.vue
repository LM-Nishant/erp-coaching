<template>
  <div v-if="loaded" class="today">
    <ion-list lines="full" class="rows">
      <ion-item router-link="/admissions/enquiries" detail button>
        <ion-label>{{ t('admissions.today.new') }}</ion-label>
        <ion-badge slot="end" :color="newCount ? 'primary' : 'medium'">{{ newCount }}</ion-badge>
      </ion-item>
      <ion-item router-link="/admissions/enquiries?followUp=1" detail button>
        <ion-label>{{ t('admissions.today.followUps') }}</ion-label>
        <ion-badge slot="end" :color="followUps ? 'warning' : 'medium'">{{ followUps }}</ion-badge>
      </ion-item>
    </ion-list>
  </div>
  <p v-else-if="failed" class="muted">{{ t('admissions.today.failed') }}</p>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonBadge, IonItem, IonLabel, IonList } from '@ionic/vue';
import { admissionsApi } from './api';

/** Staff home: new enquiries to call and follow-ups due. */
const { t } = useI18n();
const newCount = ref(0);
const followUps = ref(0);
const loaded = ref(false);
const failed = ref(false);

onMounted(async () => {
  try {
    const [summary, due] = await Promise.all([
      admissionsApi.summary(),
      admissionsApi.enquiries({ followUpDue: true, page: 1 }),
    ]);
    newCount.value = summary.new ?? 0;
    followUps.value = due.total;
    loaded.value = true;
  } catch {
    failed.value = true;
  }
});
</script>

<style scoped>
.rows {
  margin: 0 -16px;
  background: transparent;
}
.rows ion-item {
  --background: transparent;
  --min-height: var(--app-tap-target);
}
.muted {
  color: var(--ion-color-medium);
}
</style>

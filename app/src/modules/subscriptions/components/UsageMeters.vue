<template>
  <div class="meters">
    <ion-card v-for="m in meters" :key="m.metric" class="meter">
      <ion-card-content>
        <div class="meter-head">
          <span class="label">{{ m.label }}</span>
          <span>
            <strong>{{ formatMetric(m.metric, m.used) }}</strong>
            <span class="muted"> / {{ formatMetric(m.metric, m.included) }}</span>
          </span>
        </div>
        <ion-progress-bar :value="meterValue(m.percent)" :color="meterColor(m.percent)" />
        <div class="muted small">
          <template v-if="m.included === null">No limit on this plan</template>
          <template v-else-if="m.used > m.included"
            >{{ formatMetric(m.metric, m.used - m.included) }} over the limit</template
          >
          <template v-else>{{ formatMetric(m.metric, m.remaining ?? 0) }} left</template>
          <template v-if="m.overage">
            · extra billed at {{ rupees(m.overage.pricePaise) }} per
            {{ packSize(m.metric, m.overage.unitSize) }}
          </template>
        </div>
      </ion-card-content>
    </ion-card>

    <ion-card class="meter ai">
      <ion-card-content>
        <div class="meter-head">
          <span class="label">AI quota this month</span>
          <span>
            <strong>{{ formatMetric('aiTokens', ai.usedThisMonth) }}</strong>
            <span class="muted"> / {{ formatMetric('aiTokens', ai.includedThisMonth) }} tokens</span>
          </span>
        </div>
        <ion-progress-bar :value="meterValue(aiPercent)" :color="meterColor(aiPercent)" />
        <div class="muted small">
          <template v-if="ai.remaining === null">No AI limit on this plan</template>
          <template v-else>{{ formatMetric('aiTokens', ai.remaining) }} tokens remaining</template>
          · {{ ai.requestsThisMonth.toLocaleString('en-IN') }} requests
          <template v-if="ai.creditsThisMonth > 0">
            · includes {{ formatMetric('aiTokens', ai.creditsThisMonth) }} from credit packs</template
          >
          <template v-if="ai.overage">
            · extra billed at {{ rupees(ai.overage.pricePaise) }} per
            {{ packSize('aiTokens', ai.overage.unitSize) }}
          </template>
        </div>
        <ion-list v-if="ai.byFeature.length" lines="none" class="features">
          <ion-item v-for="f in ai.byFeature" :key="f.feature">
            <ion-label>{{ f.feature }}</ion-label>
            <ion-note slot="end"
              >{{ f.tokens.toLocaleString('en-IN') }} tokens · {{ f.requests }} req.</ion-note
            >
          </ion-item>
        </ion-list>
      </ion-card-content>
    </ion-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { IonCard, IonCardContent, IonItem, IonLabel, IonList, IonNote, IonProgressBar } from '@ionic/vue';
import type { AiQuotaDto, UsageMetricDto } from '@erp/shared';
import { rupees } from '@/modules/hr/api';
import { formatMetric, meterColor, meterValue, packSize } from '../format';

const props = defineProps<{ usage: UsageMetricDto[]; ai: AiQuotaDto }>();

const meters = computed(() => props.usage.filter((m) => m.metric !== 'aiTokens'));
const aiPercent = computed(() => {
  const { includedThisMonth: included, usedThisMonth: used } = props.ai;
  if (included === null) return null;
  if (included === 0) return used > 0 ? 100 : 0;
  return Math.round((used / included) * 100);
});
</script>

<style scoped>
.meters {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.meter {
  margin: 0;
}
.meter.ai {
  grid-column: 1 / -1;
}
.meter-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.label {
  font-size: 12px;
  text-transform: uppercase;
  color: var(--ion-color-medium);
}
.small {
  font-size: 12px;
  margin-top: 6px;
}
.features {
  margin-top: 8px;
}
</style>

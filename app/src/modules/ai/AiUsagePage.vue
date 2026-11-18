<template>
  <AppPage title="AI usage" :on-refresh="load">
    <template v-if="summary">
      <ion-note v-if="notice" :color="notice.color" class="notice">{{ notice.text }}</ion-note>

      <h3 class="section-title">This month</h3>
      <p class="muted">
        Since {{ displayDate(summary.periodStart) }}. The allowance resets at the start of each month.
      </p>
      <div class="quota">
        <div class="quota-line">
          <strong>{{ formatTokens(summary.tokensUsed) }}</strong>
          <span v-if="summary.monthlyLimit !== null">
            of {{ formatTokens(summary.monthlyLimit) }} tokens</span
          >
          <span v-else> tokens · no monthly limit</span>
          <span v-if="percentUsed !== null" class="muted"> ({{ percentUsed }}%)</span>
        </div>
        <ion-progress-bar v-if="summary.monthlyLimit !== null" :value="quotaFraction" :color="quotaColor" />
        <p class="muted">
          {{ summary.requests }} requests<span v-if="summary.errors"> · {{ summary.errors }} failed</span
          ><span v-if="summary.images"> · {{ summary.images }} images</span> · estimated cost
          {{ formatUsd(summary.estimatedCostUsd) }}
        </p>
      </div>

      <ion-list v-if="summary.byFeature.length">
        <ion-list-header><ion-label>By feature</ion-label></ion-list-header>
        <ion-item v-for="f in summary.byFeature" :key="f.feature">
          <ion-label class="ion-text-wrap">
            <h3>{{ featureLabel(f.feature) }}</h3>
            <p>
              {{ f.requests }} requests<span v-if="f.errors"> · {{ f.errors }} failed</span> ·
              {{ formatTokens(f.totalTokens) }} tokens<span v-if="f.images"> · {{ f.images }} images</span> ·
              est.
              {{ formatUsd(f.estimatedCostUsd) }}
            </p>
          </ion-label>
        </ion-item>
      </ion-list>
      <p v-else class="muted">No AI requests this month.</p>

      <template v-if="history">
        <h3 class="section-title">Last {{ HISTORY_DAYS }} days</h3>
        <p class="muted">{{ usageLine(history.byInstitute[0]) }}</p>
        <ion-list v-if="history.byProvider.length">
          <ion-list-header><ion-label>By provider</ion-label></ion-list-header>
          <ion-item v-for="p in history.byProvider" :key="`${p.provider}/${p.model}`">
            <ion-label class="ion-text-wrap">
              <h3>{{ p.provider }} · {{ p.model }}</h3>
              <p>{{ usageLine(p) }}</p>
            </ion-label>
          </ion-item>
        </ion-list>
      </template>
      <p class="muted footnote">Costs are estimates from the provider's list prices, in US dollars.</p>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonProgressBar,
  onIonViewWillEnter,
} from '@ionic/vue';
import type { AiAdminUsageDto, AiAdminUsageRow, AiUsageSummaryDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { aiAvailabilityNotice, formatTokens, formatUsd } from '@/core/ai';
import { toastError } from '@/core/toast';
import { aiApi } from './api';

const HISTORY_DAYS = 30;
const FEATURE_LABELS: Record<string, string> = {
  'exams.grading': 'Exam grading',
  'question-bank.generate': 'Question generation',
};

const summary = ref<AiUsageSummaryDto | null>(null);
const history = ref<AiAdminUsageDto | null>(null);

const notice = computed(() => {
  const s = summary.value;
  // The quota line already covers the normal case; only explain why AI can't run.
  return s && s.reason ? aiAvailabilityNotice(s) : null;
});
const quotaFraction = computed(() => {
  const s = summary.value;
  if (!s || s.monthlyLimit === null) return 0;
  return s.monthlyLimit > 0 ? Math.min(1, s.tokensUsed / s.monthlyLimit) : 1;
});
const percentUsed = computed(() =>
  summary.value?.monthlyLimit ? Math.round(quotaFraction.value * 100) : null,
);
const quotaColor = computed(() =>
  quotaFraction.value >= 1 ? 'danger' : quotaFraction.value >= 0.8 ? 'warning' : 'primary',
);

const featureLabel = (f: string) => FEATURE_LABELS[f] ?? f;
const displayDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function usageLine(u: Omit<AiAdminUsageRow, 'instituteId'>) {
  const parts = [`${u.calls} calls`];
  if (u.errors) parts.push(`${u.errors} failed`);
  parts.push(`${formatTokens(u.totalTokens)} tokens`);
  if (u.images) parts.push(`${u.images} images`);
  parts.push(`est. ${formatUsd(u.estimatedCostUsd)}`);
  return parts.join(' · ');
}

async function load() {
  try {
    summary.value = await aiApi.usage();
    // The history is only available while AI is in the plan.
    history.value = summary.value.reason === 'MODULE_DISABLED' ? null : await aiApi.history(HISTORY_DAYS);
  } catch (err) {
    toastError(err);
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.notice {
  display: block;
  margin-bottom: 12px;
}
.section-title {
  margin: 16px 0 4px;
}
.quota {
  margin: 8px 0 12px;
}
.quota-line {
  margin-bottom: 6px;
}
.footnote {
  margin-top: 16px;
  font-size: 0.85em;
}
</style>

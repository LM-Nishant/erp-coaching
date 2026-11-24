<template>
  <ion-card v-if="status && !status.complete && !hidden" class="setup">
    <ion-card-header>
      <ion-card-title>{{ t('dashboard.setup.title') }}</ion-card-title>
      <ion-card-subtitle>{{
        t('dashboard.setup.progress', { done: status.done, total: status.total })
      }}</ion-card-subtitle>
    </ion-card-header>
    <ion-card-content>
      <ion-progress-bar :value="status.done / status.total" :aria-label="t('dashboard.setup.title')" />
      <ion-list lines="none" class="steps">
        <ion-item
          v-for="s in shownSteps"
          :key="s.key"
          :button="!s.done && !!link(s.key)"
          :detail="!s.done && !!link(s.key)"
          :router-link="s.done ? undefined : link(s.key)"
          :class="{ done: s.done }"
        >
          <ion-icon
            slot="start"
            :icon="s.done ? checkmarkCircle : ellipseOutline"
            :color="s.done ? 'success' : 'medium'"
            aria-hidden="true"
          />
          <ion-label class="ion-text-wrap">
            <h3>{{ t(`dashboard.setup.steps.${s.key}.title`) }}</h3>
            <p v-if="!s.done">{{ t(`dashboard.setup.steps.${s.key}.hint`) }}</p>
          </ion-label>
          <span class="sr-only">{{ s.done ? t('common.status.done') : t('common.status.pending') }}</span>
        </ion-item>
      </ion-list>
      <ion-button
        v-if="status.done"
        fill="clear"
        size="small"
        :aria-expanded="showDone"
        @click="showDone = !showDone"
        >{{
          showDone ? t('dashboard.setup.hideDone') : t('dashboard.setup.showDone', { n: status.done })
        }}</ion-button
      >
      <ion-button fill="clear" size="small" @click="hide">{{ t('dashboard.setup.hide') }}</ion-button>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonProgressBar,
} from '@ionic/vue';
import { checkmarkCircle, ellipseOutline } from 'ionicons/icons';
import type { PermissionKey, SetupStatusDto, SetupStepKey } from '@erp/shared';
import { api } from '@/core/api';
import { useAuthStore } from '@/stores/auth';

/** "Finish setting up" for a new institute: each step links to the page that does it; gone once all are done. */
const auth = useAuthStore();
const showDone = ref(false);
const { t } = useI18n();
const status = ref<SetupStatusDto | null>(null);
/** What is left comes first; finished steps only on request, so the card stays short. */
const shownSteps = computed(() => status.value?.steps.filter((s) => showDone.value || !s.done) ?? []);

const STEP_LINKS: Record<SetupStepKey, { to: string; permission: PermissionKey; planModule?: string }> = {
  profile: { to: '/institute', permission: 'institute.configure' },
  course: { to: '/academics/courses', permission: 'academics.view', planModule: 'academics' },
  batch: { to: '/academics/batches?new=1', permission: 'academics.create', planModule: 'academics' },
  feeStructure: { to: '/fees/structures', permission: 'fees.view', planModule: 'fees' },
  teacher: { to: '/hr/employees', permission: 'hr.view', planModule: 'hr' },
  student: { to: '/students?add=1', permission: 'students.create', planModule: 'students' },
  paymentGateway: { to: '/fees/settings', permission: 'fees.configure', planModule: 'fees' },
  parents: { to: '/guardians', permission: 'guardians.view', planModule: 'students' },
};

function link(key: SetupStepKey): string | undefined {
  const l = STEP_LINKS[key];
  return auth.can(l.permission) && (!l.planModule || auth.moduleEnabled(l.planModule)) ? l.to : undefined;
}

const storageKey = computed(() => `erp.setupHidden.${auth.me?.institute?.id ?? 0}`);
const hiddenFlag = ref(false);
const hidden = computed(() => hiddenFlag.value);

function hide() {
  hiddenFlag.value = true;
  try {
    localStorage.setItem(storageKey.value, '1');
  } catch {
    /* private mode */
  }
}

onMounted(async () => {
  try {
    hiddenFlag.value = localStorage.getItem(storageKey.value) === '1';
  } catch {
    hiddenFlag.value = false;
  }
  if (hiddenFlag.value) return;
  status.value = await api.get<SetupStatusDto>('/institute/setup-status').catch(() => null);
});
</script>

<style scoped>
.setup {
  margin: 0;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.35);
}
.steps {
  margin-top: 8px;
  background: transparent;
}
.steps ion-item {
  --background: transparent;
  --min-height: var(--app-tap-target);
}
.steps ion-item.done h3 {
  color: var(--ion-color-medium);
  text-decoration: line-through;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>

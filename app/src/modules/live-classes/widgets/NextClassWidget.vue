<template>
  <div v-if="!loaded" class="skeleton" aria-hidden="true" />
  <EmptyState
    v-else-if="!cls"
    :icon="videocamOutline"
    :title="t('liveClasses.widgets.noClass')"
    :message="t('liveClasses.widgets.noClassHint')"
  />
  <div v-else class="next" :class="state.kind">
    <div class="meta">
      <StatusChip
        v-if="state.kind === 'live'"
        :label="t('common.status.live')"
        tone="danger"
        :icon="radioOutline"
      />
      <StatusChip
        v-else-if="state.kind === 'soon'"
        :label="t('liveClasses.widgets.startsIn', { n: state.minutes })"
        tone="warning"
      />
      <StatusChip
        v-else-if="state.kind === 'waiting'"
        :label="t('liveClasses.widgets.waiting')"
        tone="warning"
      />
      <span class="when">{{ formatDayShort(cls.scheduledStartAt) }}</span>
      <span v-if="state.kind === 'later'" class="when rel"
        >· {{ formatRelative(cls.scheduledStartAt, now) }}</span
      >
    </div>
    <h3 class="title">{{ cls.title }}</h3>
    <p class="sub">
      {{ formatTime(cls.scheduledStartAt) }}–{{ formatTime(cls.scheduledEndAt) }} · {{ cls.teacher.name
      }}<span v-if="cls.batchName"> · {{ cls.batchName }}</span>
    </p>
    <ion-button
      v-if="state.kind === 'live'"
      expand="block"
      color="light"
      class="join"
      :router-link="`/live-classes/${cls.id}/room`"
    >
      <ion-icon slot="start" :icon="videocamOutline" />{{ t('liveClasses.widgets.joinNow') }}
    </ion-button>
    <ion-button
      v-else
      expand="block"
      color="light"
      fill="outline"
      class="join"
      :router-link="`/live-classes/${cls.id}`"
      >{{
        state.kind === 'soon' || state.kind === 'waiting'
          ? t('liveClasses.widgets.openClass')
          : t('liveClasses.widgets.details')
      }}</ion-button
    >
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { IonButton, IonIcon } from '@ionic/vue';
import { radioOutline, videocamOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { LiveSessionDto } from '@erp/shared';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDayShort, formatRelative, formatTime } from '@/core/format';
import { liveApi } from '../api';
import { joinState, nextClass } from '../format';

/** Student home: the live class (one tap to join) or the next one, with a countdown when it is close. */
const { t } = useI18n();
const list = ref<LiveSessionDto[]>([]);
const loaded = ref(false);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

const cls = computed(() => nextClass(list.value, now.value));
const state = computed(() => (cls.value ? joinState(cls.value, now.value) : { kind: 'over' as const }));

async function load() {
  try {
    list.value = (await liveApi.list({ upcoming: true, pageSize: 20 })).items;
  } catch {
    list.value = [];
  } finally {
    loaded.value = true;
  }
}

onMounted(() => {
  void load();
  // Tick for the countdown; reload once a minute so a class the teacher starts shows "Join now".
  let ticks = 0;
  timer = setInterval(() => {
    now.value = Date.now();
    if (++ticks % 4 === 0) void load();
  }, 15_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.next {
  padding: 16px;
  border-radius: 12px;
  color: #fff;
  background: linear-gradient(135deg, var(--ion-color-primary), var(--ion-color-primary-tint));
}
.next.live {
  background: linear-gradient(135deg, var(--ion-color-danger-shade), var(--ion-color-danger));
}
.sub {
  margin: 0;
  opacity: 0.9;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.when {
  font-size: 0.9rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.title {
  margin: 8px 0 2px;
  font-size: 1.25rem;
  font-weight: 700;
}
.join {
  margin-top: 12px;
  min-height: var(--app-tap-target, 48px);
}
.skeleton {
  height: 96px;
  border-radius: 8px;
  background: var(--ion-color-light);
}
</style>

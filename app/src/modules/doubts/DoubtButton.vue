<template>
  <ion-fab v-if="allowed" slot="fixed" vertical="bottom" horizontal="end" class="doubt-fab">
    <ion-fab-button
      class="doubt-fab-button"
      :aria-label="t('doubts.ask.button')"
      data-testid="ask-doubt"
      @click="ask"
    >
      <ion-icon :icon="helpCircleOutline" aria-hidden="true" />
      <span class="label">{{ t('doubts.ask.button') }}</span>
    </ion-fab-button>
  </ion-fab>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { IonFab, IonFabButton, IonIcon } from '@ionic/vue';
import { helpCircleOutline } from 'ionicons/icons';
import { useAuthStore } from '@/stores/auth';

/**
 * Persistent "Ask doubt" button for lecture and live-class pages. Place it inside the page's
 * `ion-content` (it is a fixed FAB). Pass `position` as a function so the current video time is read
 * at the moment the student taps.
 */
const props = defineProps<{
  lectureId?: number | null;
  liveClassId?: number | null;
  /** Shown on the ask page ("About: <title>"). */
  title?: string | null;
  /** Current video position in seconds. */
  position?: (() => number | null | undefined) | number | null;
}>();

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const allowed = computed(() => auth.can('doubts.create'));

function ask() {
  const pos = typeof props.position === 'function' ? props.position() : props.position;
  const query: Record<string, string> = {};
  if (props.lectureId) query.lectureId = String(props.lectureId);
  if (props.liveClassId) query.liveClassId = String(props.liveClassId);
  if (props.title) query.title = props.title;
  if (pos != null && Number.isFinite(pos)) query.t = String(Math.floor(pos));
  void router.push({ path: '/doubts/ask', query });
}
</script>

<style scoped>
.doubt-fab {
  margin-bottom: calc(8px + env(safe-area-inset-bottom));
}
.doubt-fab-button {
  width: auto;
  min-height: var(--app-tap-target, 48px);
  --border-radius: 28px;
  --padding-start: 16px;
  --padding-end: 18px;
}
.doubt-fab-button ion-icon {
  font-size: 22px;
}
.label {
  margin-left: 6px;
  font-weight: 600;
  font-size: 15px;
}
</style>

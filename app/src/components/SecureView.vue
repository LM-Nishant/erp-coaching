<template>
  <div ref="root" class="secure-view" @contextmenu="onContextMenu" @dragstart.prevent>
    <slot />
    <Watermark v-if="watermark && label" :text="label" />
    <div v-if="shielded" class="secure-shield" role="alert">
      <div class="secure-shield-message">
        <ion-icon :icon="eyeOffOutline" />
        <p>Screen recording or mirroring is on. This content is hidden until it stops.</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IonIcon } from '@ionic/vue';
import { eyeOffOutline } from 'ionicons/icons';
import { captureActive, useSecureScreen } from '@/core/secure-screen';
import { useAuthStore } from '@/stores/auth';
import Watermark from './Watermark.vue';

/**
 * Protected content (lectures, live classes, recordings, exam attempts, question papers): a dynamic watermark,
 * screenshot / recording restrictions while it is visible (see core/secure-screen.ts for what each platform allows)
 * and, on iOS, a shield over the content while the screen is recorded or mirrored. Other screens are unaffected.
 */
const props = withDefaults(
  defineProps<{
    /** Names the screen in capture audit events, e.g. `exam-attempt`. */
    screen: string;
    /** false turns the protection off, e.g. while no recording is playing. */
    active?: boolean;
    /** Watermark identity; defaults to the signed-in user's name and mobile number. */
    text?: string;
    watermark?: boolean;
  }>(),
  { active: true, text: undefined, watermark: true },
);

const auth = useAuthStore();
const root = ref<HTMLElement | null>(null);
// Ionic keeps a page mounted (hidden) under the pages opened from it: protect only while it is shown.
const pageVisible = ref(true);
const on = computed(() => props.active && pageVisible.value);
const shielded = computed(() => on.value && captureActive.value);
const label = computed(() => {
  if (props.text) return props.text;
  const user = auth.me?.user;
  return user ? [user.name, user.mobile].filter(Boolean).join(' · ') : '';
});

useSecureScreen(props.screen, on);

type Media = HTMLMediaElement & { webkitExitFullscreen?: () => void };
// Media keeps playing (and native fullscreen video escapes the shield) unless stopped; live streams resume afterwards.
watch(shielded, (hide) => {
  const media = [...(root.value?.querySelectorAll<Media>('video, audio') ?? [])];
  for (const m of media) {
    if (hide) {
      m.pause();
      m.webkitExitFullscreen?.();
    } else if (m.autoplay) void m.play().catch(() => undefined);
  }
  if (hide && document.fullscreenElement && root.value?.contains(document.fullscreenElement)) {
    void document.exitFullscreen().catch(() => undefined);
  }
});

function onContextMenu(e: MouseEvent) {
  // No "save image / video" menu; text fields keep theirs (paste).
  if (!(e.target as Element | null)?.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
}

let observer: MutationObserver | undefined;
onMounted(() => {
  const page = root.value?.closest('.ion-page');
  if (!page) return;
  const update = () => (pageVisible.value = !page.classList.contains('ion-page-hidden'));
  update();
  observer = new MutationObserver(update);
  observer.observe(page, { attributes: true, attributeFilter: ['class'] });
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.secure-view {
  position: relative;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.secure-view :is(input, textarea, [contenteditable='true']) {
  user-select: text;
  -webkit-user-select: text;
}
.secure-shield {
  position: absolute;
  inset: 0;
  z-index: 20;
  background: var(--ion-background-color, #fff);
  color: var(--ion-text-color, #000);
}
.secure-shield-message {
  position: sticky;
  top: 25%;
  max-width: 320px;
  margin: 48px auto 0;
  padding: 16px;
  text-align: center;
}
.secure-shield-message ion-icon {
  font-size: 40px;
}
</style>

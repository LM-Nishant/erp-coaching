<template>
  <ion-button
    :fill="block ? 'outline' : 'clear'"
    :expand="block ? 'block' : undefined"
    :size="block ? 'default' : 'small'"
    class="wish"
    :class="{ saved, floating: !block }"
    :aria-label="saved ? 'Remove from wishlist' : 'Add to wishlist'"
    :aria-pressed="saved"
    :disabled="busy"
    :data-testid="`wishlist-${courseId}`"
    @click.prevent.stop="toggle"
  >
    <ion-icon :slot="block ? 'start' : 'icon-only'" :icon="saved ? heart : heartOutline" />
    <template v-if="block">{{ saved ? 'Wishlisted' : 'Add to wishlist' }}</template>
  </ion-button>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IonButton, IonIcon } from '@ionic/vue';
import { heart, heartOutline } from 'ionicons/icons';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { useWishlist } from '../wishlist-store';

const props = withDefaults(defineProps<{ courseId: number; block?: boolean }>(), { block: false });

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const wishlist = useWishlist();
const busy = ref(false);
const saved = computed(() => wishlist.ids.value.has(props.courseId));
onMounted(() => void wishlist.load());

async function toggle() {
  if (!auth.isAuthenticated) {
    void router.push({ name: 'login', query: { redirect: route.fullPath } });
    return;
  }
  busy.value = true;
  try {
    const now = await wishlist.toggle(props.courseId);
    if (props.block) await toast(now ? 'Added to wishlist' : 'Removed from wishlist');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.wish.saved {
  --color: var(--ion-color-danger);
  --border-color: var(--ion-color-danger);
}
.floating {
  position: absolute;
  top: 6px;
  right: 6px;
  margin: 0;
  --background: rgba(255, 255, 255, 0.92);
  --border-radius: 50%;
  --padding-start: 6px;
  --padding-end: 6px;
  height: 34px;
  width: 34px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  border-radius: 50%;
}
.floating:not(.saved) {
  --color: #333;
}
</style>

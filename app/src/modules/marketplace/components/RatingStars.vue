<template>
  <span class="stars" :class="size" role="img" :aria-label="`Rated ${rating.toFixed(1)} out of 5`">
    <ion-icon v-for="i in parts.full" :key="`f${i}`" :icon="star" />
    <ion-icon v-if="parts.half" :icon="starHalf" />
    <ion-icon v-for="i in parts.empty" :key="`e${i}`" :icon="starOutline" />
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { IonIcon } from '@ionic/vue';
import { star, starHalf, starOutline } from 'ionicons/icons';
import { starParts } from '../engagement-api';

const props = withDefaults(defineProps<{ rating: number; size?: 'small' | 'large' }>(), { size: 'small' });
const parts = computed(() => starParts(props.rating));
</script>

<style scoped>
.stars {
  display: inline-flex;
  gap: 1px;
  color: var(--ion-color-warning-shade);
  vertical-align: -2px;
}
.small ion-icon {
  font-size: 13px;
}
.large ion-icon {
  font-size: 20px;
}
</style>

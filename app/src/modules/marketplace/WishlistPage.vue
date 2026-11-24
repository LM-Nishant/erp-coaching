<template>
  <MarketShell title="Wishlist" :on-refresh="load" wide>
    <div v-if="items.length" class="grid" data-testid="wishlist-items">
      <div v-for="c in items" :key="c.id" class="cell" :data-testid="`wish-${c.slug}`">
        <CourseCard :course="c" :wishlist="false" />
        <div class="actions">
          <ion-button
            v-if="!(c.isFree || c.pricePaise === 0)"
            size="small"
            :disabled="busy === c.id"
            :data-testid="`move-to-cart-${c.slug}`"
            @click="moveToCart(c)"
          >
            <ion-icon slot="start" :icon="cartOutline" />Move to cart
          </ion-button>
          <ion-button v-else size="small" :router-link="`/market/course/${c.slug}`"
            >Enrol for free</ion-button
          >
          <ion-button
            size="small"
            fill="clear"
            color="medium"
            :disabled="busy === c.id"
            :data-testid="`unwish-${c.slug}`"
            @click="remove(c)"
            >Remove</ion-button
          >
        </div>
      </div>
    </div>
    <div v-else-if="loaded" class="empty" data-testid="wishlist-empty">
      <ion-icon :icon="heartOutline" />
      <p>Your wishlist is empty. Tap the heart on a course to save it for later.</p>
      <ion-button router-link="/market">Browse courses</ion-button>
    </div>
  </MarketShell>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonButton, IonIcon } from '@ionic/vue';
import { cartOutline, heartOutline } from 'ionicons/icons';
import type { MktCourseCardDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import CourseCard from './components/CourseCard.vue';
import MarketShell from './components/MarketShell.vue';
import { engagementApi } from './engagement-api';
import { useMarketAccount } from './store';
import { useWishlist } from './wishlist-store';

const items = ref<MktCourseCardDto[]>([]);
const loaded = ref(false);
const busy = ref<number | null>(null);
const wishlist = useWishlist();
const { refresh: refreshAccount } = useMarketAccount();

async function load() {
  try {
    items.value = (await engagementApi.wishlist()).items;
    loaded.value = true;
    void wishlist.load(true);
  } catch (e) {
    void toastError(e);
  }
}

async function moveToCart(c: MktCourseCardDto) {
  busy.value = c.id;
  try {
    await engagementApi.moveToCart(c.id);
    items.value = items.value.filter((x) => x.id !== c.id);
    wishlist.forget(c.id);
    void refreshAccount();
    await toast('Moved to cart');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = null;
  }
}

async function remove(c: MktCourseCardDto) {
  busy.value = c.id;
  try {
    await engagementApi.removeFromWishlist(c.id);
    items.value = items.value.filter((x) => x.id !== c.id);
    wishlist.forget(c.id);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = null;
  }
}

onMounted(load);
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.actions {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
}
.empty {
  text-align: center;
  padding: 48px 16px;
  color: var(--ion-color-medium-shade);
}
.empty ion-icon {
  font-size: 48px;
}
</style>

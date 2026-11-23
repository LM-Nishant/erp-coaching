<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button v-if="backHref" :default-href="backHref" />
          <ion-menu-button v-else-if="auth.isAuthenticated && !auth.needsInstitute" />
        </ion-buttons>
        <ion-title>
          <router-link v-if="!backHref && !auth.isAuthenticated" to="/market" class="brand"
            >Courses</router-link
          >
          <template v-else>{{ title }}</template>
        </ion-title>
        <ion-buttons slot="end">
          <slot name="actions" />
          <ion-button v-if="search" router-link="/market/search" aria-label="Search courses">
            <ion-icon slot="icon-only" :icon="searchOutline" />
          </ion-button>
          <ion-button
            v-if="auth.isAuthenticated"
            router-link="/market/wishlist"
            aria-label="Wishlist"
            data-testid="wishlist-link"
          >
            <ion-icon slot="icon-only" :icon="heartOutline" />
          </ion-button>
          <ion-button router-link="/market/cart" aria-label="Cart" class="cart-btn">
            <ion-icon slot="icon-only" :icon="cartOutline" />
            <ion-badge v-if="cartCount" color="danger" data-testid="cart-count">{{ cartCount }}</ion-badge>
          </ion-button>
          <ion-button
            v-if="!auth.isAuthenticated"
            :router-link="{ name: 'login', query: { redirect: route.fullPath } }"
            fill="solid"
            size="small"
            color="primary"
            >Sign in</ion-button
          >
        </ion-buttons>
      </ion-toolbar>
      <slot name="toolbar" />
    </ion-header>
    <ion-content :class="{ 'ion-padding': padded }">
      <ion-refresher v-if="onRefresh" slot="fixed" @ion-refresh="refresh"
        ><ion-refresher-content
      /></ion-refresher>
      <div class="page-container" :class="{ wide }"><slot /></div>
    </ion-content>
    <slot name="footer" />
  </ion-page>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonBackButton,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonMenuButton,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonTitle,
  IonToolbar,
  type RefresherCustomEvent,
} from '@ionic/vue';
import { cartOutline, heartOutline, searchOutline } from 'ionicons/icons';
import { useAuthStore } from '@/stores/auth';
import { useMarketAccount } from '../store';

const props = withDefaults(
  defineProps<{
    title: string;
    backHref?: string;
    padded?: boolean;
    search?: boolean;
    wide?: boolean;
    onRefresh?: () => Promise<unknown>;
  }>(),
  { backHref: undefined, padded: true, search: true, wide: false, onRefresh: undefined },
);

const auth = useAuthStore();
const route = useRoute();
const { cartCount, refresh: refreshAccount } = useMarketAccount();
onMounted(() => void refreshAccount());

async function refresh(ev: RefresherCustomEvent) {
  try {
    await Promise.all([props.onRefresh?.(), refreshAccount()]);
  } finally {
    await ev.target.complete();
  }
}
</script>

<style scoped>
.brand {
  color: inherit;
  text-decoration: none;
  font-weight: 700;
}
.cart-btn {
  position: relative;
}
.cart-btn ion-badge {
  position: absolute;
  top: 0;
  right: 0;
  font-size: 10px;
  min-width: 16px;
  padding: 2px 4px;
}
.page-container.wide {
  max-width: 1200px;
}
</style>

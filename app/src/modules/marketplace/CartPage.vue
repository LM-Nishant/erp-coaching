<template>
  <MarketShell title="Cart" back-href="/market" :on-refresh="load">
    <template v-if="cart">
      <p v-if="!cart.items.length" class="empty" data-testid="cart-empty">
        Your cart is empty.<br />
        <ion-button router-link="/market" fill="outline">Keep browsing</ion-button>
      </p>
      <div v-else class="cart">
        <ion-list class="items">
          <ion-item
            v-for="item in cart.items"
            :key="item.course.id"
            :data-testid="`cart-item-${item.course.slug}`"
          >
            <ion-thumbnail slot="start">
              <img v-if="item.course.thumbnailUrl" :src="item.course.thumbnailUrl" alt="" />
            </ion-thumbnail>
            <ion-label>
              <router-link :to="`/market/course/${item.course.slug}`" class="title">{{
                item.course.title
              }}</router-link>
              <p>{{ item.course.seller.displayName }}</p>
              <p v-if="item.discountPaise" class="discount">Coupon saves {{ rupees(item.discountPaise) }}</p>
            </ion-label>
            <div slot="end" class="price-col">
              <strong>{{ rupees(item.course.pricePaise) }}</strong>
              <ion-button
                fill="clear"
                size="small"
                color="danger"
                :disabled="busy"
                @click="remove(item.course.id)"
                >Remove</ion-button
              >
            </div>
          </ion-item>
        </ion-list>
        <div class="summary">
          <ion-item lines="none">
            <ion-input
              v-model="coupon"
              label="Coupon code"
              label-placement="stacked"
              autocapitalize="characters"
              data-testid="coupon-input"
            />
            <ion-button slot="end" fill="clear" :disabled="busy" data-testid="apply-coupon" @click="load"
              >Apply</ion-button
            >
          </ion-item>
          <p v-if="cart.couponMessage" class="warn">{{ cart.couponMessage }}</p>
          <p v-else-if="cart.couponCode" class="ok">{{ cart.couponCode }} applied</p>
          <div class="line">
            <span>Subtotal</span><span>{{ rupees(cart.subtotalPaise) }}</span>
          </div>
          <div v-if="cart.discountPaise" class="line">
            <span>Discount</span><span>- {{ rupees(cart.discountPaise) }}</span>
          </div>
          <div class="line total">
            <span>Total</span><span data-testid="cart-total">{{ rupees(cart.totalPaise) }}</span>
          </div>
          <ion-button expand="block" :disabled="busy" data-testid="checkout" @click="checkout"
            >Checkout</ion-button
          >
          <p class="muted">
            Payments are processed securely. Courses unlock as soon as the payment is confirmed.
          </p>
        </div>
      </div>
    </template>
    <div v-else class="center"><ion-spinner /></div>
  </MarketShell>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IonButton, IonInput, IonItem, IonLabel, IonList, IonSpinner, IonThumbnail } from '@ionic/vue';
import type { MktCartDto } from '@erp/shared';
import { checkoutReturnTo } from '@/core/payment-checkout';
import { toast, toastError } from '@/core/toast';
import MarketShell from './components/MarketShell.vue';
import { marketApi, rupees } from './api';
import { pendingCheckouts } from './checkout-state';
import { useMarketAccount } from './store';

const router = useRouter();
const { refresh: refreshAccount } = useMarketAccount();
const cart = ref<MktCartDto | null>(null);
const coupon = ref('');
const busy = ref(false);

async function load() {
  busy.value = true;
  try {
    cart.value = await marketApi.cart(coupon.value.trim() || undefined);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function remove(courseId: number) {
  busy.value = true;
  try {
    await marketApi.removeFromCart(courseId);
    await load();
    void refreshAccount();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function checkout() {
  if (!cart.value) return;
  busy.value = true;
  try {
    const usable = cart.value.couponCode && !cart.value.couponMessage ? cart.value.couponCode : null;
    const o = await marketApi.checkout({ couponCode: usable, returnTo: checkoutReturnTo('/market/orders') });
    void refreshAccount();
    if (!o.payment) {
      await toast('You are enrolled. Enjoy the course!');
      await router.replace('/market/learning');
      return;
    }
    pendingCheckouts.set(o.orderId, o.payment);
    await router.replace(`/market/orders/${o.orderId}`);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.cart {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 20px;
  align-items: start;
}
@media (max-width: 800px) {
  .cart {
    grid-template-columns: 1fr;
  }
}
ion-thumbnail {
  --size: 64px;
  --border-radius: 6px;
}
.title {
  color: inherit;
  font-weight: 600;
  text-decoration: none;
  white-space: normal;
}
.price-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.discount,
.ok {
  color: var(--ion-color-success-shade);
}
.warn {
  color: var(--ion-color-warning-shade);
  font-size: 13px;
}
.summary {
  border-radius: 12px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  padding: 12px;
}
.line {
  display: flex;
  justify-content: space-between;
  margin: 6px 4px;
}
.total {
  font-size: 20px;
  font-weight: 700;
}
.muted {
  font-size: 12px;
  color: var(--ion-color-medium);
}
.empty,
.center {
  text-align: center;
  padding: 40px;
}
</style>

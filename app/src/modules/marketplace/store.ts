import { ref } from 'vue';
import type { MktAccountDto } from '@erp/shared';
import { useAuthStore } from '@/stores/auth';
import { marketApi } from './api';

/** Marketplace standing of the signed-in user (cart badge, instructor profile), shared by every page. */
const account = ref<MktAccountDto | null>(null);
const cartCount = ref(0);

export function useMarketAccount() {
  const auth = useAuthStore();
  async function refresh() {
    if (!auth.isAuthenticated || auth.offline) {
      account.value = null;
      cartCount.value = 0;
      return null;
    }
    try {
      account.value = await marketApi.account();
      cartCount.value = account.value.cartCount;
    } catch {
      account.value = null;
    }
    return account.value;
  }
  return { account, cartCount, refresh };
}

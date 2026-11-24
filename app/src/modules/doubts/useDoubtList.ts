import { ref } from 'vue';
import type { DoubtBox, DoubtDto, DoubtStatus } from '@erp/shared';
import type { InfiniteScrollCustomEvent } from '@ionic/vue';
import { toastError } from '@/core/toast';
import { doubtsApi } from './api';

/** Paged doubt list for one box and status. */
export function useDoubtList(query: () => { box: DoubtBox; status: DoubtStatus }) {
  const items = ref<DoubtDto[]>([]);
  const total = ref(0);
  const page = ref(1);
  const loading = ref(true);

  async function load(reset = true) {
    loading.value = true;
    if (reset) page.value = 1;
    try {
      const res = await doubtsApi.list({ ...query(), page: page.value, pageSize: 25 });
      items.value = reset ? res.items : [...items.value, ...res.items];
      total.value = res.total;
    } catch (e) {
      await toastError(e);
    } finally {
      loading.value = false;
    }
  }

  async function more(ev: InfiniteScrollCustomEvent) {
    page.value++;
    await load(false);
    await ev.target.complete();
  }

  return { items, total, loading, load, reload: () => load(true), more };
}

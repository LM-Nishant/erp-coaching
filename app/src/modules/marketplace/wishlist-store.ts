import { ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { engagementApi } from './engagement-api';

/** Ids of the signed-in learner's wishlisted courses, shared by every card and the landing page. */
const ids = ref<Set<number>>(new Set());
let loaded: Promise<void> | null = null;

export function useWishlist() {
  const auth = useAuthStore();

  function load(force = false) {
    if (!auth.isAuthenticated || auth.offline) {
      ids.value = new Set();
      loaded = null;
      return Promise.resolve();
    }
    if (!loaded || force)
      loaded = engagementApi
        .wishlistIds()
        .then((r) => void (ids.value = new Set(r.courseIds)))
        .catch(() => void (loaded = null));
    return loaded;
  }

  const has = (courseId: number) => ids.value.has(courseId);

  /** Adds or removes `courseId`; returns whether it is now saved. */
  async function toggle(courseId: number) {
    const res = has(courseId)
      ? await engagementApi.removeFromWishlist(courseId)
      : await engagementApi.addToWishlist(courseId);
    ids.value = new Set(res.courseIds);
    return has(courseId);
  }

  function forget(courseId: number) {
    const next = new Set(ids.value);
    next.delete(courseId);
    ids.value = next;
  }

  return { ids, load, has, toggle, forget };
}

import { computed } from 'vue';
import { useAuthStore } from '@/stores/auth';

/** LMS audiences: staff manage content; learners study and submit; parents (view-only) follow their children. */
export function useLmsRole() {
  const auth = useAuthStore();
  const isStaff = computed(() => auth.can('lms.edit') || auth.can('lms-assignments.edit'));
  const isLearner = computed(() => !isStaff.value && auth.can('lms-assignments.create'));
  const isParent = computed(() => !isStaff.value && !isLearner.value && auth.can('lms.view'));
  return { auth, isStaff, isLearner, isParent };
}

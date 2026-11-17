import type { Directive } from 'vue';
import type { PermissionKey } from '@erp/shared';
import { useAuthStore } from '@/stores/auth';

/** `v-can="'branches.create'"` hides the element unless the user has the permission (array = any of). */
export const vCan: Directive<HTMLElement, PermissionKey | PermissionKey[]> = {
  mounted: apply,
  updated: apply,
};

function apply(el: HTMLElement, binding: { value: PermissionKey | PermissionKey[] }) {
  const auth = useAuthStore();
  const keys = Array.isArray(binding.value) ? binding.value : [binding.value];
  el.style.display = keys.some((k) => auth.can(k)) ? '' : 'none';
}

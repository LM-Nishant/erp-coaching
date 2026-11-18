import { reactive } from 'vue';
import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router';
import { SUBSCRIPTION_ERROR_CODES, type SubscriptionStatusDto } from '@erp/shared';
import type { ApiError } from '@/core/api';
import { useAuthStore } from '@/stores/auth';
import { billingApi } from './api';

const FRESH_MS = 5 * 60_000;
const FORCED_RELOAD_GAP_MS = 30_000;

/** Subscription state of the selected institute, shared by the toolbar chip, the guard and the billing page. */
export const subscriptionState = reactive({
  status: null as SubscriptionStatusDto | null,
  instituteId: null as number | null,
  loadedAt: 0,
});

let inflight: { instituteId: number; promise: Promise<SubscriptionStatusDto> } | null = null;
let lastForcedAt = 0;

/** Institute whose subscription applies; null for super admins (impersonation is never blocked either). */
function governedInstituteId(): number | null {
  const me = useAuthStore().me;
  return me?.institute && !me.impersonatedBy ? me.institute.id : null;
}

function currentInstituteId(): number | null {
  return useAuthStore().me?.institute?.id ?? null;
}

/** Status of the selected institute, cached for a few minutes; `force` always asks the API. */
export async function loadSubscriptionStatus(force = false): Promise<SubscriptionStatusDto | null> {
  const instituteId = currentInstituteId();
  if (!instituteId) {
    Object.assign(subscriptionState, { status: null, instituteId: null, loadedAt: 0 });
    return null;
  }
  if (subscriptionState.instituteId !== instituteId)
    Object.assign(subscriptionState, { status: null, instituteId, loadedAt: 0 });
  if (!force && subscriptionState.status && Date.now() - subscriptionState.loadedAt < FRESH_MS)
    return subscriptionState.status;
  if (!force && inflight?.instituteId === instituteId) return inflight.promise;
  const promise = billingApi.status().then((status) => {
    if (currentInstituteId() === instituteId)
      Object.assign(subscriptionState, { status, instituteId, loadedAt: Date.now() });
    return status;
  });
  const entry = { instituteId, promise };
  inflight = entry;
  void promise
    .catch(() => undefined)
    .finally(() => {
      if (inflight === entry) inflight = null;
    });
  return promise;
}

/** Pages that load the status anyway (the billing overview) share it with the chip and the guard. */
export function shareSubscriptionStatus(status: SubscriptionStatusDto, instituteId: number) {
  if (currentInstituteId() === instituteId)
    Object.assign(subscriptionState, { status, instituteId, loadedAt: Date.now() });
}

/** `setPaymentRequiredHandler` callback: a 402 means the state changed under us, so refresh it. */
export function handlePaymentRequired(e: ApiError) {
  const instituteId = currentInstituteId();
  if (!instituteId || e.code === 'PLAN_LIMIT_EXCEEDED') return;
  const state =
    e.code === SUBSCRIPTION_ERROR_CODES.SUSPENDED
      ? 'suspended'
      : e.code === SUBSCRIPTION_ERROR_CODES.RESTRICTED
        ? 'restricted'
        : null;
  if (state && subscriptionState.status && subscriptionState.instituteId === instituteId)
    subscriptionState.status = { ...subscriptionState.status, state };
  if (Date.now() - lastForcedAt < FORCED_RELOAD_GAP_MS) return;
  lastForcedAt = Date.now();
  void loadSubscriptionStatus(true).catch(() => undefined);
}

/** Where a suspended institute's members land: billing for those who can pay, a notice for others. */
export function suspendedTarget(): RouteLocationRaw {
  return useAuthStore().can('subscription.view')
    ? { name: 'subscription-billing' }
    : { name: 'subscription-suspended' };
}

/** A suspended institute can only reach pages marked `allowWhenSuspended` (the API answers 402 elsewhere). */
export async function suspendedGuard(to: RouteLocationNormalized): Promise<true | RouteLocationRaw> {
  if (to.meta.allowWhenSuspended || !governedInstituteId()) return true;
  const cached = subscriptionState.instituteId === currentInstituteId() ? subscriptionState.status : null;
  let status = cached;
  if (!cached) status = await loadSubscriptionStatus().catch(() => null);
  else if (Date.now() - subscriptionState.loadedAt >= FRESH_MS)
    void loadSubscriptionStatus().catch(() => undefined);
  return status?.state === 'suspended' ? suspendedTarget() : true;
}

/** True when the current page should be left because the institute is now suspended. */
export function mustLeaveForSuspension(meta: { allowWhenSuspended?: boolean }): boolean {
  return (
    subscriptionState.status?.state === 'suspended' &&
    subscriptionState.instituteId === governedInstituteId() &&
    !meta.allowWhenSuspended
  );
}

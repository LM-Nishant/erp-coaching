import { config } from '../infrastructure/config';

/**
 * Base URL (no trailing slash) for links into the web app, e.g. registration or course checkout.
 * `override` is a per-tenant setting such as a website's app URL; otherwise `PUBLIC_WEB_URL`.
 * Links to API-served resources (signed documents, exports, webhooks) use `API_PUBLIC_URL` instead.
 */
export function webAppBaseUrl(override?: string | null): string {
  return (override?.trim() || config.publicWebUrl).replace(/\/+$/, '');
}

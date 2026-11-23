import { setDefaultMessagingResolver, setPlatformWebhookResolver } from '../../infrastructure/messaging';
import { config } from '../../infrastructure/config';
import { logger } from '../../infrastructure/logger';
import { setSaasGatewayResolver } from '../subscriptions/api';
import { setPlatformFeesGatewayProvider } from '../fees/api';
import { setMarketplaceGatewayResolver } from '../marketplace/api';
import {
  defaultMessagingProvider,
  instituteGatewayCredentials,
  loadIntegrations,
  offeredInstituteGateway,
  platformMessagingWebhook,
  resolveSaasGateway,
} from './platform.service';

const REFRESH_MS = 60_000;

/**
 * Wires the super admin's global integrations into their consumers. Institute-level settings keep
 * precedence (notification providers, fee gateways); the global configuration is the fallback.
 */
export async function registerPlatformIntegrations(): Promise<void> {
  setSaasGatewayResolver(resolveSaasGateway);
  // Marketplace sales are collected by the platform, with the same gateway as subscriptions.
  setMarketplaceGatewayResolver(resolveSaasGateway);
  setDefaultMessagingResolver(defaultMessagingProvider);
  setPlatformWebhookResolver(platformMessagingWebhook);
  setPlatformFeesGatewayProvider({
    offered: offeredInstituteGateway,
    credentials: instituteGatewayCredentials,
  });
  // Loading the snapshot also applies the active storage driver to this process.
  await loadIntegrations(true);
  if (!config.isTest) {
    // Keeps the storage driver of long-running processes in sync with the super admin's settings.
    setInterval(() => {
      loadIntegrations().catch((err) => logger.error({ err }, 'Platform integrations refresh failed'));
    }, REFRESH_MS).unref();
  }
}

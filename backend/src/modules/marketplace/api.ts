/**
 * Public marketplace API for other modules. Import only from this file.
 *
 * The platform module registers the gateway the platform collects marketplace payments with.
 */
export { setMarketplaceGatewayResolver, type MarketplaceGatewayResolver } from './commerce.service';

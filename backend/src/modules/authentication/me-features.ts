import type { MeFeature } from '@erp/shared';
import { logger } from '../../infrastructure/logger';

type Resolver = () => Promise<boolean>;
const resolvers = new Map<MeFeature, Resolver>();

/**
 * Lets another module add a feature flag to `GET /auth/me` (`MeDto.features`), e.g. HR reports whether
 * the signed-in user has a staff profile so the app can hide "My payslips" instead of opening a dead end.
 * Resolvers run in the request's institute context and only when an institute is selected.
 */
export function registerMeFeature(feature: MeFeature, resolve: Resolver): void {
  resolvers.set(feature, resolve);
}

/** Features whose resolver says yes; a failing resolver counts as no. */
export async function meFeatures(): Promise<MeFeature[]> {
  const entries = [...resolvers.entries()];
  const results = await Promise.all(
    entries.map(([feature, resolve]) =>
      resolve().catch((err: unknown) => {
        logger.warn({ err, feature }, 'me feature resolver failed');
        return false;
      }),
    ),
  );
  return entries.filter((_, i) => results[i]).map(([feature]) => feature);
}

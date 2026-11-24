import type { MktAccountDto, MktSignupInput } from '@erp/shared';
import { hashPassword } from '../../infrastructure/password';
import { getContext, hasPermission } from '../../shared/context';
import { Conflict } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { User } from '../users/user.model';
import { cartCount } from './commerce.service';
import { instituteSeller, instructorOf, toSellerAdminDto } from './sellers.service';

/**
 * A learner account that is not tied to any institute: it signs in with the regular login and
 * can buy from every seller. Becoming an instructor later is one more step (instructor profile).
 */
export async function signup(input: MktSignupInput): Promise<{ id: number; name: string }> {
  const mobile = input.mobile.replace(/[^\d+]/g, '');
  if (await User.count({ where: { mobile } }))
    throw Conflict('An account with this mobile number exists; sign in instead', 'ACCOUNT_EXISTS');
  if (input.email && (await User.count({ where: { email: input.email.toLowerCase() } })))
    throw Conflict('An account with this email exists; sign in instead', 'ACCOUNT_EXISTS');
  const user = await User.create({
    name: input.name.trim(),
    mobile,
    email: input.email ? input.email.toLowerCase() : null,
    passwordHash: await hashPassword(input.password),
    status: 'active',
    lastLoginAt: null,
  });
  await audit({
    action: 'marketplace.learner.signed_up',
    entityType: 'user',
    entityId: user.id,
    instituteId: null,
  });
  return { id: user.id, name: user.name };
}

export async function account(): Promise<MktAccountDto> {
  const { userId, instituteId } = getContext();
  const [instructor, count] = await Promise.all([instructorOf(userId!), cartCount(userId!)]);
  const institute =
    instituteId && hasPermission('marketplace.view') ? await instituteSeller(instituteId) : null;
  return {
    instructor: instructor ? await toSellerAdminDto(instructor) : null,
    institute: institute ? await toSellerAdminDto(institute) : null,
    cartCount: count,
  };
}

import type { PermissionKey } from './permissions';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type LoginResult =
  | ({ status: 'authenticated' } & AuthTokens)
  | { status: 'otp_required'; challengeId: string; reason: 'new_device' | 'otp_login'; maskedMobile: string }
  | { status: 'device_limit_reached'; maxDevices: number };

export interface InstituteBranding {
  id: number;
  slug: string;
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
}

export interface MembershipDto extends InstituteBranding {
  roles: string[];
}

export interface MeDto {
  user: { id: number; name: string; mobile: string; email: string | null; isSuperAdmin: boolean };
  institute: InstituteBranding | null;
  branches: { id: number; name: string }[];
  /** null = all branches of the institute. */
  allowedBranchIds: number[] | null;
  roles: string[];
  permissions: PermissionKey[] | ['*'];
  memberships: MembershipDto[];
  impersonatedBy: { id: number; name: string } | null;
  enabledModules: string[] | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

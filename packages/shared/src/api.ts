import type { SessionPolicyDto } from './devices';
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
  | { status: 'device_limit_reached'; maxDevices: number }
  | {
      /** The verified number signs in to several accounts (e.g. children sharing a parent's mobile). */
      status: 'choose_profile';
      /** Single-use proof of the verified code for `POST /auth/select-profile`, valid on this device only. */
      selectionToken: string;
      /** Seconds the selection token stays valid. */
      expiresIn: number;
      profiles: SignInProfileDto[];
    };

/** An account offered by "Who's signing in?" after a mobile number is verified. */
export interface SignInProfileDto {
  id: number;
  name: string;
  /** Institutes the account belongs to, with its role slugs there. */
  memberships: {
    id: number;
    name: string;
    logoUrl: string | null;
    primaryColor: string | null;
    roles: string[];
  }[];
}

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

/** App languages; saved on the account as `users.locale`. */
export const APP_LOCALES = ['en', 'hi'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

/** Optional parts of the app that depend on the user's records rather than permissions (`MeDto.features`). */
export const ME_FEATURES = ['staff-profile'] as const;
export type MeFeature = (typeof ME_FEATURES)[number];

export interface MeDto {
  user: {
    id: number;
    name: string;
    /** The number the account is reached on: its own, or the one it shares (`sharesMobile`). */
    mobile: string;
    email: string | null;
    isSuperAdmin: boolean;
    /** The account has no number of its own and uses another account's (e.g. a sibling's on a parent's). */
    sharesMobile?: boolean;
    /** Active accounts signing in with this number (including this one); more than 1 offers "Switch profile". */
    profileCount?: number;
    /** Language saved on the account (`PUT /auth/me/locale`); `en` unless the user picked Hindi. */
    locale: AppLocale;
  };
  institute: InstituteBranding | null;
  branches: { id: number; name: string }[];
  /** null = all branches of the institute. */
  allowedBranchIds: number[] | null;
  roles: string[];
  permissions: PermissionKey[] | ['*'];
  memberships: MembershipDto[];
  impersonatedBy: { id: number; name: string } | null;
  enabledModules: string[] | null;
  /** Inactivity timeout and biometric unlock state of this session (absent on older APIs). */
  session?: SessionPolicyDto;
  /** Record-based features, e.g. `staff-profile`: the login is linked to an HR employee (absent on older APIs). */
  features?: MeFeature[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

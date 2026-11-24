import { defineStore } from 'pinia';
import { Capacitor } from '@capacitor/core';
import type { AuthTokens, LoginResult, MeDto, PermissionKey, SignInProfileDto } from '@erp/shared';
import {
  ApiError,
  api,
  sessionEndSettled,
  sessionEnded,
  SESSION_END_CODES,
  type RequestOptions,
} from '@/core/api';
import { getDeviceDescriptor } from '@/core/device';
import { loadProfile, loadSession, patchSession, saveProfile, saveSession } from '@/core/token-storage';
import { applyBranding } from '@/core/branding';
import { syncLocaleFromMe } from '@/core/locale-sync';
import { personaOf, type Persona } from '@/core/persona';
import {
  BiometricError,
  biometricAvailability,
  disableBiometric as turnOffBiometric,
  enableBiometric as turnOnBiometric,
  exchangeUnlockSecret,
  forgetBiometric,
  getBiometricRecord,
  readUnlockSecret,
  type BiometricRecord,
} from '@/core/biometric';

export interface PendingOtp {
  challengeId: string;
  maskedMobile: string;
  reason: 'new_device' | 'otp_login';
}

/** "Who's signing in?": the verified number signs in to several accounts (children sharing a parent's mobile). */
export interface PendingProfiles {
  selectionToken: string;
  /** `Date.now()` when the selection token expires. */
  expiresAt: number;
  profiles: SignInProfileDto[];
}

interface ImpersonationResponse {
  accessToken: string;
  expiresIn: number;
  sessionId: number;
}

export type NextStep = 'home' | 'otp' | 'choose-profile' | 'select-institute' | 'device-limit';

/** Why the last session ended; the login and unlock pages explain it. */
export type SessionEndReason = 'idle' | 'revoked' | 'inactive' | 'expired';

export function sessionEndReason(code: string): SessionEndReason {
  if (code === 'SESSION_IDLE') return 'idle';
  if (code === 'SESSION_REVOKED') return 'revoked';
  if (code === 'ACCOUNT_INACTIVE') return 'inactive';
  return 'expired';
}

const isNetworkError = (e: unknown) => e instanceof ApiError && e.code === 'NETWORK_ERROR';
const isServerError = (e: unknown) => e instanceof ApiError && e.status >= 500;

let restoring: Promise<void> | null = null;
/** Secret read during an offline biometric unlock; exchanged for a session once the network is back. */
let pendingUnlockSecret: string | null = null;
/** Modules' sign-out clean-up (core/session.ts sets it): runs while the session still works. */
let beforeLogout: (() => Promise<void>) | null = null;
export function setBeforeLogoutHandler(fn: (() => Promise<void>) | null) {
  beforeLogout = fn;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    me: null as MeDto | null,
    ready: false,
    pendingOtp: null as PendingOtp | null,
    pendingProfiles: null as PendingProfiles | null,
    activeBranchId: null as number | null,
    /** Biometric unlock set up on this device (app only). With no session, the app shows the unlock screen. */
    biometric: null as BiometricRecord | null,
    /** No network: `me` is the cached profile and only offline pages (downloaded lectures) work. */
    offline: false,
    /** Signed in with password or OTP in this app session: the app may offer biometric unlock. */
    freshLogin: false,
    endReason: null as SessionEndReason | null,
  }),

  getters: {
    isAuthenticated: (s) => !!s.me,
    isPlatformAdmin: (s) => !!s.me?.user.isSuperAdmin && !s.me.impersonatedBy,
    /** Shell persona (home, tabs, menu); null when signed out. See core/persona.ts. */
    persona: (s): Persona | null =>
      s.me
        ? personaOf({
            isPlatformAdmin: !!s.me.user.isSuperAdmin && !s.me.impersonatedBy,
            hasInstitute: !!s.me.institute,
            roles: s.me.roles,
          })
        : null,
    /** Member of institutes but none chosen yet. Marketplace learners and instructors belong to none and skip this. */
    needsInstitute: (s) =>
      !!s.me && !s.me.institute && !s.me.user.isSuperAdmin && s.me.memberships.length > 0,
    /**
     * Signed in without an institute (marketplace learners, independent instructors): notifications come from the
     * personal inbox (`/notifications/personal`), which needs no institute permission.
     */
    personalInbox: (s) => !!s.me && !s.me.institute && !s.me.user.isSuperAdmin && !s.me.impersonatedBy,
    /** The login is linked to an HR employee, so "My leave" and "My payslips" have something to show. */
    hasStaffProfile: (s) => !s.me?.features || s.me.features.includes('staff-profile'),
    permissionSet: (s) => new Set<string>((s.me?.permissions as string[]) ?? []),
    /** Locked: no session, but biometric unlock can start one. */
    canUnlock: (s) => !s.me && !!s.biometric,
    /** Other accounts sign in with this account's number (siblings on a parent's mobile): "Switch profile". */
    canSwitchProfile: (s) =>
      !!s.me && !s.me.impersonatedBy && !s.offline && (s.me.user.profileCount ?? 1) > 1,
    /** Minutes without activity before the app locks or signs out; 0 = never (and while impersonating). */
    idleTimeoutMinutes: (s) => (s.me && !s.me.impersonatedBy ? (s.me.session?.idleTimeoutMinutes ?? 0) : 0),
  },

  actions: {
    can(key: PermissionKey) {
      if (!this.me) return false;
      return this.permissionSet.has('*') || this.permissionSet.has(key);
    },

    moduleEnabled(moduleId: string) {
      const enabled = this.me?.enabledModules;
      return !enabled || enabled.includes(moduleId);
    },

    /** Restores the persisted session on app start (once; concurrent callers share it). */
    init() {
      restoring ??= this.restore().finally(() => {
        this.ready = true;
        applyBranding(this.me?.institute ?? null);
      });
      return restoring;
    },

    async restore() {
      this.biometric = await getBiometricRecord();
      const session = await loadSession();
      this.activeBranchId = session?.branchId ?? null;
      if (!session?.accessToken) return;
      try {
        await this.fetchMe();
      } catch (e) {
        // Only a 401 ends the session, and the API layer already handed it to the session-ended handler. Network
        // errors and server errors (5xx, maintenance…) keep the stored session: downloaded lectures work offline in
        // the app, and it resumes once the server answers again.
        if (isNetworkError(e) || isServerError(e)) {
          if (!session.impersonator) await this.startOffline(session.userId ?? null);
        }
      }
      // A 401, or the idle monitor (closed for longer than the timeout), may have ended the session: wait for the
      // session-ended handler to lock the app or sign out.
      await sessionEndSettled();
    },

    /** Signs in from the cached profile without network (app only). */
    async startOffline(userId: number | null) {
      if (!Capacitor.isNativePlatform() || !userId) return false;
      const profile = await loadProfile();
      if (profile?.user.id !== userId) return false;
      this.me = profile;
      this.offline = true;
      return true;
    },

    async fetchMe(opts?: RequestOptions) {
      const me = await api.get<MeDto>('/auth/me', undefined, opts);
      if (!me.impersonatedBy) {
        // Before `me` is set: setting it starts the idle monitor, which may end the session at once.
        const session = await loadSession();
        if (session && session.userId !== me.user.id)
          await patchSession({ userId: me.user.id }, (s) => s.accessToken === session.accessToken);
        await saveProfile(me).catch(() => undefined);
        // Turned off on the server (signed out elsewhere, re-enrolled on another install…).
        if (me.session && !me.session.biometricUnlock && this.biometric?.userId === me.user.id)
          await this.forgetBiometricRecord();
      }
      this.me = me;
      this.offline = false;
      applyBranding(me.institute);
      syncLocaleFromMe(me);
      return me;
    },

    async loginWithPassword(identifier: string, password: string): Promise<NextStep> {
      const device = await getDeviceDescriptor();
      return this.handleLogin(
        await api.post<LoginResult>('/auth/login', { identifier, password, device }, { anonymous: true }),
      );
    },

    async requestOtp(mobile: string): Promise<NextStep> {
      const device = await getDeviceDescriptor();
      return this.handleLogin(
        await api.post<LoginResult>('/auth/otp/request', { mobile, device }, { anonymous: true }),
      );
    },

    async verifyOtp(code: string): Promise<NextStep> {
      if (!this.pendingOtp) throw new Error('No OTP in progress');
      const device = await getDeviceDescriptor();
      const result = await api.post<LoginResult>(
        '/auth/otp/verify',
        { challengeId: this.pendingOtp.challengeId, code, device },
        { anonymous: true },
      );
      return this.handleLogin(result);
    },

    async handleLogin(result: LoginResult, method: 'password' | 'biometric' = 'password'): Promise<NextStep> {
      if (result.status === 'otp_required') {
        this.pendingOtp = {
          challengeId: result.challengeId,
          maskedMobile: result.maskedMobile,
          reason: result.reason,
        };
        return 'otp';
      }
      if (result.status === 'device_limit_reached') return 'device-limit';
      if (result.status === 'choose_profile') {
        this.pendingOtp = null;
        this.pendingProfiles = {
          selectionToken: result.selectionToken,
          expiresAt: Date.now() + result.expiresIn * 1000,
          profiles: result.profiles,
        };
        return 'choose-profile';
      }
      this.pendingOtp = null;
      this.pendingProfiles = null;
      pendingUnlockSecret = null;
      await saveSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        branchId: null,
      });
      this.activeBranchId = null;
      this.endReason = null;
      const me = await this.fetchMe();
      // One biometric credential per device: another user's sign-in removes it.
      if (this.biometric && this.biometric.userId !== me.user.id) await this.forgetBiometricRecord();
      this.freshLogin = method === 'password';
      if (!me.institute && !me.user.isSuperAdmin) {
        if (me.memberships.length === 1) {
          await this.selectInstitute(me.memberships[0]!.id);
          return 'home';
        }
        if (me.memberships.length) return 'select-institute';
      }
      return 'home';
    },

    /** "Switch profile": a code to the signed-in account's number, then "Who's signing in?". */
    async startProfileSwitch(): Promise<NextStep> {
      if (!this.me) throw new Error('Not signed in');
      return this.requestOtp(this.me.user.mobile);
    },

    /**
     * "Who's signing in?": signs in as the chosen account. Switching profile (already signed in), choosing the
     * current account changes nothing; once another is signed in, the current one is signed out on this device
     * as `logout` does (requests still carrying its token retry with the new one). A chosen account at its device
     * limit leaves the current one signed in and the selection open for another.
     */
    async selectProfile(userId: number): Promise<NextStep> {
      const pending = this.pendingProfiles;
      if (!pending) throw new Error('No profile selection in progress');
      if (this.me?.user.id === userId) {
        this.pendingProfiles = null;
        return 'home';
      }
      const device = await getDeviceDescriptor();
      const result = await api.post<LoginResult>(
        '/auth/select-profile',
        { selectionToken: pending.selectionToken, userId, device },
        { anonymous: true },
      );
      if (result.status !== 'authenticated' || !this.me) return this.handleLogin(result);
      await beforeLogout?.();
      await this.forgetBiometricRecord();
      await saveProfile(null);
      const previous = await loadSession();
      try {
        return await this.handleLogin(result);
      } catch (e) {
        // Never show one account with the other's session: sign in again from the login page.
        if (this.me?.user.id !== userId) await this.clear();
        throw e;
      } finally {
        if (previous?.refreshToken && !previous.impersonator)
          await api
            .post('/auth/logout', { refreshToken: previous.refreshToken }, { anonymous: true })
            .catch(() => undefined);
      }
    },

    /**
     * Unlock screen: Face ID / Touch ID / fingerprint, then a new session for this device. Without
     * network the cached profile is used, so downloaded lectures stay available.
     */
    async unlock(): Promise<NextStep> {
      const record = this.biometric;
      if (!record) throw new BiometricError('failed', 'Biometric unlock is not set up on this device');
      const profile = await loadProfile();
      const sameUser = profile?.user.id === record.userId;
      let secret: string;
      try {
        secret = await readUnlockSecret((await biometricAvailability()).label || 'biometrics');
      } catch (e) {
        if (e instanceof BiometricError && e.reason === 'invalidated') await this.forgetBiometricRecord();
        throw e;
      }
      try {
        return await this.handleLogin(
          await exchangeUnlockSecret(record, secret, sameUser ? profile?.institute?.id : undefined),
          'biometric',
        );
      } catch (e) {
        if (isNetworkError(e) && (await this.startOffline(record.userId))) {
          pendingUnlockSecret = secret;
          this.endReason = null;
          return 'home';
        }
        if (e instanceof ApiError && e.code === 'BIOMETRIC_INVALID') await this.forgetBiometricRecord();
        // Revoked device / inactive account: the session-ended handler removes this user's data.
        if (e instanceof ApiError && SESSION_END_CODES.has(e.code)) await sessionEnded(e.code);
        throw e;
      }
    },

    /** Back online, or the app resumed: refresh the profile and leave offline mode. */
    async revalidate() {
      if (!this.me) return;
      const session = await loadSession();
      if (session) {
        await this.fetchMe({ background: true }).catch(() => undefined);
        return;
      }
      // Unlocked offline with biometrics: finish the unlock now.
      const secret = pendingUnlockSecret;
      if (!secret || !this.biometric) return;
      try {
        await this.handleLogin(
          await exchangeUnlockSecret(this.biometric, secret, this.me.institute?.id),
          'biometric',
        );
      } catch (e) {
        if (isNetworkError(e)) return;
        pendingUnlockSecret = null;
        if (e instanceof ApiError && e.code === 'BIOMETRIC_INVALID') await this.forgetBiometricRecord();
        await sessionEnded(e instanceof ApiError ? e.code : 'UNAUTHORIZED');
      }
    },

    async enableBiometric() {
      if (!this.me) return;
      this.biometric = await turnOnBiometric(this.me.user.id);
      if (this.me.session) this.me.session.biometricUnlock = true;
    },

    async disableBiometric() {
      await turnOffBiometric();
      this.biometric = null;
      if (this.me?.session) this.me.session.biometricUnlock = false;
    },

    async forgetBiometricRecord() {
      await forgetBiometric();
      this.biometric = null;
    },

    async selectInstitute(instituteId: number) {
      const tokens = await api.post<AuthTokens>('/auth/select-institute', { instituteId });
      const session = await loadSession();
      await saveSession({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        branchId: null,
        userId: session?.userId ?? null,
      });
      this.activeBranchId = null;
      await this.fetchMe();
    },

    /** null = all permitted branches. Sent as `X-Branch-Id` on every request. */
    async setActiveBranch(branchId: number | null) {
      const session = await loadSession();
      if (!session) return;
      await saveSession({ ...session, branchId });
      this.activeBranchId = branchId;
    },

    async impersonate(instituteId: number, userId?: number, reason?: string) {
      const session = await loadSession();
      if (!session) return;
      const res = await api.post<ImpersonationResponse>('/auth/impersonate', { instituteId, userId, reason });
      await saveSession({
        accessToken: res.accessToken,
        refreshToken: null,
        branchId: null,
        userId: session.userId ?? null,
        impersonator: { accessToken: session.accessToken, refreshToken: session.refreshToken },
      });
      this.activeBranchId = null;
      await this.fetchMe();
    },

    async stopImpersonation() {
      const session = await loadSession();
      if (!session?.impersonator) return;
      await api.post('/auth/impersonation/stop').catch(() => undefined);
      await saveSession({
        ...session.impersonator,
        impersonator: null,
        branchId: null,
        userId: session.userId,
      });
      this.activeBranchId = null;
      await this.fetchMe();
    },

    /** Signs out. Also turns biometric unlock off on this device; downloaded lectures stay until they expire. */
    async logout() {
      await beforeLogout?.();
      const session = await loadSession();
      const refreshToken = session?.impersonator?.refreshToken ?? session?.refreshToken;
      if (refreshToken)
        await api.post('/auth/logout', { refreshToken }, { anonymous: true }).catch(() => undefined);
      await this.forgetBiometricRecord();
      await saveProfile(null);
      await this.clear();
    },

    /**
     * The session is over: the API answered 401 (inactivity, revoked device, expired) or the
     * inactivity timer fired. With biometric unlock set up for this user the app locks; otherwise it
     * signs out. A revoked device or deactivated account also loses its biometric credential and cached
     * profile. Returns the signed-in user so the caller can remove their data from the device.
     */
    async endSession(reason: SessionEndReason): Promise<number | null> {
      const session = await loadSession();
      const userId = session?.userId ?? this.biometric?.userId ?? null;
      const lock =
        !!this.biometric &&
        reason !== 'revoked' &&
        reason !== 'inactive' &&
        (userId === null || this.biometric.userId === userId);
      if (!lock) {
        // Inactivity noticed by the app first: end it on the server too (best effort, not awaited).
        if (reason === 'idle' && session?.refreshToken && !session.impersonator)
          void api
            .post('/auth/logout', { refreshToken: session.refreshToken }, { anonymous: true })
            .catch(() => undefined);
        await this.forgetBiometricRecord();
        await saveProfile(null);
      }
      pendingUnlockSecret = null;
      await this.clear();
      this.endReason = reason;
      return userId;
    },

    /** Drops the session (memory and storage). */
    async clear() {
      await saveSession(null);
      this.me = null;
      this.offline = false;
      this.freshLogin = false;
      this.pendingOtp = null;
      this.pendingProfiles = null;
      this.activeBranchId = null;
      this.endReason = null;
      applyBranding(null);
    },
  },
});

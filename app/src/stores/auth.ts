import { defineStore } from 'pinia';
import type { AuthTokens, LoginResult, MeDto, PermissionKey } from '@erp/shared';
import { api } from '@/core/api';
import { getDeviceDescriptor } from '@/core/device';
import { loadSession, saveSession } from '@/core/token-storage';
import { applyBranding } from '@/core/branding';

export interface PendingOtp {
  challengeId: string;
  maskedMobile: string;
  reason: 'new_device' | 'otp_login';
}

interface ImpersonationResponse {
  accessToken: string;
  expiresIn: number;
  sessionId: number;
}

export type NextStep = 'home' | 'otp' | 'select-institute' | 'device-limit';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    me: null as MeDto | null,
    ready: false,
    pendingOtp: null as PendingOtp | null,
    activeBranchId: null as number | null,
  }),

  getters: {
    isAuthenticated: (s) => !!s.me,
    isPlatformAdmin: (s) => !!s.me?.user.isSuperAdmin && !s.me.impersonatedBy,
    needsInstitute: (s) => !!s.me && !s.me.institute && !s.me.user.isSuperAdmin,
    permissionSet: (s) => new Set<string>((s.me?.permissions as string[]) ?? []),
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

    /** Restores a persisted session on app start. */
    async init() {
      try {
        const session = await loadSession();
        this.activeBranchId = session?.branchId ?? null;
        if (session?.accessToken) await this.fetchMe();
      } catch {
        await saveSession(null);
        this.me = null;
      } finally {
        this.ready = true;
        applyBranding(this.me?.institute ?? null);
      }
    },

    async fetchMe() {
      this.me = await api.get<MeDto>('/auth/me');
      applyBranding(this.me.institute);
      return this.me;
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

    async handleLogin(result: LoginResult): Promise<NextStep> {
      if (result.status === 'otp_required') {
        this.pendingOtp = {
          challengeId: result.challengeId,
          maskedMobile: result.maskedMobile,
          reason: result.reason,
        };
        return 'otp';
      }
      if (result.status === 'device_limit_reached') return 'device-limit';
      this.pendingOtp = null;
      await saveSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        branchId: null,
      });
      this.activeBranchId = null;
      const me = await this.fetchMe();
      if (!me.institute && !me.user.isSuperAdmin) {
        if (me.memberships.length === 1) {
          await this.selectInstitute(me.memberships[0]!.id);
          return 'home';
        }
        return 'select-institute';
      }
      return 'home';
    },

    async selectInstitute(instituteId: number) {
      const tokens = await api.post<AuthTokens>('/auth/select-institute', { instituteId });
      await saveSession({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        branchId: null,
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
        impersonator: { accessToken: session.accessToken, refreshToken: session.refreshToken },
      });
      this.activeBranchId = null;
      await this.fetchMe();
    },

    async stopImpersonation() {
      const session = await loadSession();
      if (!session?.impersonator) return;
      await api.post('/auth/impersonation/stop').catch(() => undefined);
      await saveSession({ ...session.impersonator, impersonator: null, branchId: null });
      this.activeBranchId = null;
      await this.fetchMe();
    },

    async logout() {
      const session = await loadSession();
      const refreshToken = session?.impersonator?.refreshToken ?? session?.refreshToken;
      if (refreshToken)
        await api.post('/auth/logout', { refreshToken }, { anonymous: true }).catch(() => undefined);
      await this.clear();
    },

    async clear() {
      await saveSession(null);
      this.me = null;
      this.pendingOtp = null;
      this.activeBranchId = null;
      applyBranding(null);
    },
  },
});

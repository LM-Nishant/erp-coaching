import type { AiAdminUsageDto, AiUsageSummaryDto } from '@erp/shared';
import { api } from '@/core/api';

export const aiApi = {
  /** This month's tokens against the plan's monthly allowance, per feature. */
  usage: () => api.get<AiUsageSummaryDto>('/ai/usage'),
  /** The institute's calls, tokens and cost over the last `days`, per provider and model. */
  history: (days = 30) => api.get<AiAdminUsageDto>('/ai/usage/history', { days }),
};

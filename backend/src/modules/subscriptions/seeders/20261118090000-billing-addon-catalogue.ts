import type { PlanAddonPrice } from '@erp/shared';
import type { Migration } from '../../../infrastructure/database/migration-helpers';
import { Plan } from '../models';

/** Demo add-on catalogue for the seeded plans (only where a plan has none yet). */
const CATALOGUE: Record<string, PlanAddonPrice[]> = {
  starter: [
    { kind: 'students', unitSize: 50, monthlyPricePaise: 49900, yearlyPricePaise: 499000 },
    { kind: 'branches', unitSize: 1, monthlyPricePaise: 99900, yearlyPricePaise: 999000 },
    { kind: 'teachers', unitSize: 5, monthlyPricePaise: 29900, yearlyPricePaise: 299000 },
    { kind: 'storage', unitSize: 10240, monthlyPricePaise: 19900, yearlyPricePaise: 199000 },
    { kind: 'ai_credits', unitSize: 100000, monthlyPricePaise: 29900, yearlyPricePaise: 0 },
  ],
  growth: [
    { kind: 'students', unitSize: 100, monthlyPricePaise: 79900, yearlyPricePaise: 799000 },
    { kind: 'branches', unitSize: 1, monthlyPricePaise: 79900, yearlyPricePaise: 799000 },
    { kind: 'teachers', unitSize: 10, monthlyPricePaise: 49900, yearlyPricePaise: 499000 },
    { kind: 'storage', unitSize: 51200, monthlyPricePaise: 79900, yearlyPricePaise: 799000 },
    { kind: 'ai_credits', unitSize: 500000, monthlyPricePaise: 99900, yearlyPricePaise: 0 },
  ],
};

export const up: Migration = async () => {
  for (const [code, addons] of Object.entries(CATALOGUE)) {
    const plan = await Plan.findOne({ where: { code } });
    if (plan && !plan.addons?.length) await plan.update({ addons });
  }
};

export const down: Migration = async () => {};

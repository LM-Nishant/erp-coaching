import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { paginationSchema } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import * as svc from './parent-portal.service';

const M = svc.MODULE;
const can = (action: Parameters<typeof requirePermission>[1]) => requirePermission(M, action);

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');
const childParam = z.object({ studentId: id });

/** Parent home (spec §4.12). Every child route is limited to the caller's actively linked children. */
export function parentPortalRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule(M));

  r.get('/children', can('view'), async (_req, res) => {
    res.json(await svc.myChildren());
  });
  r.get('/children/:studentId/timetable', can('view'), async (req, res) => {
    const { studentId } = parse(childParam, req.params);
    res.json(
      await svc.childTimetable(
        studentId,
        parse(z.object({ from: date.optional(), to: date.optional() }), req.query),
      ),
    );
  });
  r.get('/children/:studentId/summary', can('view'), async (req, res) => {
    res.json(await svc.childSummary(parse(childParam, req.params).studentId));
  });
  r.get('/children/:studentId/monthly-reports', can('view'), async (req, res) => {
    res.json(await svc.childReports(parse(childParam, req.params).studentId));
  });

  // Staff.
  r.get('/monthly-reports', can('configure'), async (req, res) => {
    res.json(
      await svc.listReports(
        parse(paginationSchema.extend({ period: period.optional(), studentId: id.optional() }), req.query),
      ),
    );
  });
  r.post('/monthly-reports/generate', can('configure'), async (req, res) => {
    const body = parse(
      z
        .object({
          period: period.optional(),
          studentIds: z.array(z.number().int().positive()).max(1000).optional(),
        })
        .strict(),
      req.body ?? {},
    );
    res.status(202).json(await svc.requestGeneration(body));
  });

  api.use('/parent-portal', r);
}

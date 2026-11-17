import { Router } from 'express';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule } from '../../shared/middleware/authorize';
import { structureRoutes } from './structure.routes';
import { batchRoutes } from './batches.routes';
import { timetableRoutes } from './timetable.routes';

/** Mounted at `/api/academics`. */
export function academicsRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule('academics'));
  structureRoutes(r);
  batchRoutes(r);
  timetableRoutes(r);
  api.use('/academics', r);
}

import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
});

export function toLimitOffset(p: { page: number; pageSize: number }) {
  return { limit: p.pageSize, offset: (p.page - 1) * p.pageSize };
}

export function paginated<T>(rows: T[], total: number, p: { page: number; pageSize: number }) {
  return { items: rows, total, page: p.page, pageSize: p.pageSize };
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

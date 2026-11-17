import { z } from 'zod';
import type { WebsiteBlock } from '@erp/shared';

const str = (max: number) => z.string().trim().max(max);
const optStr = (max: number) => str(max).nullable().optional();
const fileId = z.number().int().positive();
const optFileId = fileId.nullable().optional();
const heading = optStr(150);

/** See `WebsiteHref` in @erp/shared. Anything else (e.g. `javascript:`) is rejected. */
export const hrefSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) =>
      /^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/i.test(v) ||
      /^page:[a-z0-9-]{1,80}$/.test(v) ||
      v === 'admission' ||
      v === 'enquiry' ||
      /^checkout:\d+$/.test(v),
    'Use a /path, #anchor, http(s) URL, mailto:, tel:, page:<slug>, admission, enquiry or checkout:<courseId>',
  );

const settingsSchemas = {
  hero: z.object({
    heading: str(150).min(1),
    subheading: optStr(300),
    imageFileId: optFileId,
    ctaLabel: optStr(40),
    ctaHref: hrefSchema.nullable().optional(),
  }),
  text: z.object({ heading, body: str(20000) }),
  image: z.object({
    fileId,
    alt: optStr(200),
    caption: optStr(300),
    href: hrefSchema.nullable().optional(),
  }),
  gallery: z.object({
    heading,
    images: z.array(z.object({ fileId, caption: optStr(200) })).max(60),
  }),
  courses: z.object({
    heading,
    courseIds: z.array(z.number().int().positive()).max(100).nullable().optional(),
    showDescription: z.boolean().optional(),
    showBuyButton: z.boolean().optional(),
  }),
  batches: z.object({
    heading,
    courseId: z.number().int().positive().nullable().optional(),
    branchId: z.number().int().positive().nullable().optional(),
    upcomingOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  faculty: z.object({
    heading,
    members: z
      .array(
        z.object({
          name: str(150).min(1),
          subject: optStr(100),
          bio: optStr(1000),
          photoFileId: optFileId,
        }),
      )
      .max(60),
  }),
  testimonials: z.object({
    heading,
    items: z
      .array(
        z.object({
          name: str(150).min(1),
          role: optStr(100),
          quote: str(1500).min(1),
          photoFileId: optFileId,
        }),
      )
      .max(40),
  }),
  announcements: z.object({ heading, limit: z.number().int().min(1).max(20).optional() }),
  enquiry_form: z.object({
    heading,
    intro: optStr(1000),
    branchId: z.number().int().positive().nullable().optional(),
    submitLabel: optStr(40),
    successMessage: optStr(300),
  }),
  demo_form: z.object({
    heading,
    intro: optStr(1000),
    courseId: z.number().int().positive().nullable().optional(),
    branchId: z.number().int().positive().nullable().optional(),
    slots: z.array(z.object({ label: str(120).min(1), startsAt: optStr(40) })).max(30),
    submitLabel: optStr(40),
    successMessage: optStr(300),
  }),
  contact: z.object({
    heading,
    address: optStr(500),
    phone: optStr(30),
    email: z.string().trim().email().max(150).nullable().optional().or(z.literal('')),
    mapQuery: optStr(300),
  }),
  cta: z.object({
    heading: str(150).min(1),
    text: optStr(500),
    buttonLabel: str(40).min(1),
    buttonHref: hrefSchema,
  }),
} as const;

const blockId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const blockSchema = z.discriminatedUnion(
  'type',
  Object.entries(settingsSchemas).map(([type, settings]) =>
    z.object({
      id: blockId,
      type: z.literal(type),
      hidden: z.boolean().optional(),
      settings,
    }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
);

export const blocksSchema = z
  .array(blockSchema)
  .max(60)
  .refine((bs) => new Set(bs.map((b) => b.id)).size === bs.length, 'Block ids must be unique')
  .transform((bs) => bs as unknown as WebsiteBlock[]);

export const seoSchema = z.object({
  title: optStr(70),
  description: optStr(160),
  ogImageFileId: optFileId,
});

/** Every file referenced by the blocks/SEO; only these are served by the public media route. */
export function collectMediaFileIds(blocks: WebsiteBlock[], seo?: { ogImageFileId?: number | null } | null) {
  const ids = new Set<number>();
  const add = (v: number | null | undefined) => {
    if (v) ids.add(v);
  };
  add(seo?.ogImageFileId);
  for (const b of blocks) {
    switch (b.type) {
      case 'hero':
        add(b.settings.imageFileId);
        break;
      case 'image':
        add(b.settings.fileId);
        break;
      case 'gallery':
        b.settings.images.forEach((i) => add(i.fileId));
        break;
      case 'faculty':
        b.settings.members.forEach((m) => add(m.photoFileId));
        break;
      case 'testimonials':
        b.settings.items.forEach((t) => add(t.photoFileId));
        break;
    }
  }
  return [...ids];
}

import type { WebsiteBlock, WebsiteBlockType } from '@erp/shared';

const defaults: { [K in WebsiteBlockType]: Extract<WebsiteBlock, { type: K }>['settings'] } = {
  hero: { heading: 'Welcome', subheading: '', ctaLabel: 'Enquire now', ctaHref: 'enquiry' },
  text: { heading: '', body: '' },
  image: { fileId: 0, alt: '', caption: '' },
  gallery: { heading: 'Gallery', images: [] },
  courses: { heading: 'Our courses', courseIds: [], showDescription: true, showBuyButton: false },
  batches: { heading: 'Upcoming batches', courseId: null, branchId: null, upcomingOnly: true, limit: 12 },
  faculty: { heading: 'Our faculty', members: [] },
  testimonials: { heading: 'What our students say', items: [] },
  announcements: { heading: 'Announcements', limit: 5 },
  enquiry_form: {
    heading: 'Enquire now',
    intro: '',
    branchId: null,
    submitLabel: 'Submit',
    successMessage: '',
  },
  demo_form: {
    heading: 'Book a free demo class',
    intro: '',
    courseId: null,
    branchId: null,
    slots: [],
    submitLabel: 'Book demo',
    successMessage: '',
  },
  contact: { heading: 'Contact us', address: '', phone: '', email: '', mapQuery: '' },
  cta: { heading: 'Ready to start?', text: '', buttonLabel: 'Apply online', buttonHref: 'admission' },
};

export function newBlock(type: WebsiteBlockType): WebsiteBlock {
  const id = `${type.replace('_', '-')}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, type, settings: structuredClone(defaults[type]) } as WebsiteBlock;
}

/** Normalises editor values (blank strings, string numbers) before sending to the API. */
export function cleanBlock(b: WebsiteBlock): WebsiteBlock {
  const s = { ...(b.settings as unknown as Record<string, unknown>) };
  for (const k of ['limit']) {
    if (s[k] === '' || s[k] === null) delete s[k];
    else if (s[k] !== undefined) s[k] = Number(s[k]);
  }
  if (Array.isArray(s.courseIds) && !s.courseIds.length) s.courseIds = null;
  if (b.type === 'demo_form')
    s.slots = (s.slots as { label: string; startsAt?: string | null }[]).map((x) => ({
      label: x.label,
      startsAt: x.startsAt || null,
    }));
  return { ...b, settings: s } as unknown as WebsiteBlock;
}

export function blockSummary(b: WebsiteBlock): string {
  const s = b.settings as unknown as Record<string, unknown>;
  const text = (s.heading as string) || (s.caption as string) || (s.body as string) || '';
  return text.slice(0, 80);
}

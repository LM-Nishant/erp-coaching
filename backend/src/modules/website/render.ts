/**
 * Server-side HTML rendering of a page. No client JavaScript: forms post back to the server and
 * buttons are plain links, so pages are fast, cacheable and crawlable. Every dynamic value is
 * escaped; rich text is a small Markdown subset rendered after escaping.
 */
import type { FormFieldDef, WebsiteSeo, WebsiteTheme } from '@erp/shared';
import type { PublicAnnouncement, PublicBatch, PublicCourse, ResolvedBlock } from './content.service';

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SAFE_URL = /^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/i;

/** Markdown subset → HTML. Input is escaped first, so only the tags produced here can appear. */
export function markdown(src: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
        const raw = url.replace(/&amp;/g, '&');
        return SAFE_URL.test(raw) ? `<a href="${esc(raw)}">${text}</a>` : text;
      });
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    para = [];
    list = [];
  };
  for (const line of src.replace(/\r/g, '').split('\n')) {
    const t = line.trim();
    if (!t) flush();
    else if (/^#{2,3}\s/.test(t)) {
      flush();
      out.push(`<h3>${inline(t.replace(/^#+\s/, ''))}</h3>`);
    } else if (/^[-*]\s/.test(t)) {
      if (para.length) flush();
      list.push(t.slice(2));
    } else {
      if (list.length) flush();
      para.push(t);
    }
  }
  flush();
  return out.join('\n');
}

export interface RenderOptions {
  institute: {
    name: string;
    logoUrl: string | null;
    primaryColor: string | null;
    secondaryColor: string | null;
  };
  theme: WebsiteTheme;
  page: { slug: string; title: string; seo: WebsiteSeo | null; isHome: boolean };
  siteSeo: WebsiteSeo;
  indexable: boolean;
  /** Absolute canonical URL of this page. */
  canonicalUrl: string;
  basePath: string;
  nav: { title: string; href: string; active: boolean }[];
  mediaUrl: (fileId: number) => string;
  /** Absolute media URL for OG tags. */
  absoluteMediaUrl: (fileId: number) => string;
  resolveHref: (href: string) => string;
  checkoutHref: (courseId: number) => string;
  ref: string | null;
  preview: boolean;
  flash: { blockId: string; ok: boolean; message: string } | null;
  contact: { address: string | null; phone: string | null; email: string | null };
}

const FONTS: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Nunito", "Trebuchet MS", system-ui, sans-serif',
};

const COLOUR = /^#[0-9a-fA-F]{6}$/;
const colour = (v: string | null | undefined, fallback: string) => (v && COLOUR.test(v) ? v : fallback);

function heading(h: string | null | undefined) {
  return h ? `<h2>${esc(h)}</h2>` : '';
}

function fmtDate(d: string | null) {
  if (!d) return '';
  const date = new Date(d.length === 10 ? `${d}T00:00:00Z` : d);
  return Number.isNaN(date.getTime())
    ? esc(d)
    : date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      });
}

function hiddenCommon(o: RenderOptions, blockId: string) {
  return (
    `<input type="hidden" name="block" value="${esc(blockId)}">` +
    (o.ref ? `<input type="hidden" name="ref" value="${esc(o.ref)}">` : '') +
    `<div class="hp" aria-hidden="true"><label>Leave empty<input name="website" tabindex="-1" autocomplete="off"></label></div>`
  );
}

function fieldInput(f: FormFieldDef) {
  const name = `customFields[${esc(f.key)}]`;
  const req = f.required ? ' required' : '';
  const label = `${esc(f.label)}${f.required ? ' *' : ''}`;
  const help = f.helpText ? `<small>${esc(f.helpText)}</small>` : '';
  switch (f.type) {
    case 'textarea':
      return `<label>${label}<textarea name="${name}"${req}></textarea>${help}</label>`;
    case 'select':
      return `<label>${label}<select name="${name}"${req}><option value="">Select…</option>${(f.options ?? [])
        .map((o) => `<option>${esc(o)}</option>`)
        .join('')}</select>${help}</label>`;
    case 'checkbox':
      return `<label class="check"><input type="checkbox" name="${name}" value="true"${req}> ${label}</label>${help}`;
    default: {
      const type =
        { number: 'number', date: 'date', email: 'email', phone: 'tel', text: 'text' }[f.type] ?? 'text';
      return `<label>${label}<input type="${type}" name="${name}"${req}>${help}</label>`;
    }
  }
}

function branchSelect(branches: { id: number; name: string }[] | undefined) {
  if (!branches || branches.length < 2) return '';
  return `<label>Branch<select name="branchId">${branches
    .map((b) => `<option value="${b.id}">${esc(b.name)}</option>`)
    .join('')}</select></label>`;
}

function flashFor(o: RenderOptions, blockId: string) {
  if (o.flash?.blockId !== blockId) return '';
  return `<p class="flash ${o.flash.ok ? 'ok' : 'err'}" role="status">${esc(o.flash.message)}</p>`;
}

function formAction(o: RenderOptions) {
  return `${o.basePath}/forms/${esc(o.page.slug)}`;
}

function courseCard(c: PublicCourse, showDescription: boolean, buy: string | null) {
  return `<article class="card">
<h3>${esc(c.name)}</h3>
<p class="meta">${esc(c.mode)}${c.duration ? ` · ${esc(c.duration)}` : ''}${c.price ? ` · <strong>${esc(c.price)}</strong>` : ''}</p>
${showDescription && c.description ? `<p>${esc(c.description)}</p>` : ''}
${buy ? `<a class="btn" href="${esc(buy)}">Enrol online</a>` : ''}
</article>`;
}

function batchRow(b: PublicBatch) {
  return `<tr><td>${esc(b.name)}</td><td>${esc(b.courseName)}</td><td>${esc(b.branchName)}</td><td>${fmtDate(
    b.startDate,
  )}</td><td>${esc(b.mode)}</td><td>${b.seatsLeft > 0 ? `${b.seatsLeft} seats left` : 'Full'}</td></tr>`;
}

function announcementItem(a: PublicAnnouncement) {
  const title =
    a.linkUrl && SAFE_URL.test(a.linkUrl) ? `<a href="${esc(a.linkUrl)}">${esc(a.title)}</a>` : esc(a.title);
  return `<li>${a.isPinned ? '📌 ' : ''}<strong>${title}</strong> <span class="meta">${fmtDate(a.date)}</span>${
    a.body ? `<div>${markdown(a.body)}</div>` : ''
  }</li>`;
}

export function renderBlock(b: ResolvedBlock, o: RenderOptions): string {
  const id = `id="${esc(b.id)}"`;
  switch (b.type) {
    case 'hero': {
      const s = b.settings;
      const bg = s.imageFileId ? ` style="background-image:url('${esc(o.mediaUrl(s.imageFileId))}')"` : '';
      return `<section ${id} class="hero${s.imageFileId ? ' has-img' : ''}"${bg}><div class="wrap">
<h1>${esc(s.heading)}</h1>${s.subheading ? `<p class="lead">${esc(s.subheading)}</p>` : ''}
${s.ctaLabel && s.ctaHref ? `<a class="btn btn-lg" href="${esc(o.resolveHref(s.ctaHref))}">${esc(s.ctaLabel)}</a>` : ''}
</div></section>`;
    }
    case 'text':
      return `<section ${id} class="wrap text">${heading(b.settings.heading)}${markdown(b.settings.body)}</section>`;
    case 'image': {
      const s = b.settings;
      const img = `<img src="${esc(o.mediaUrl(s.fileId))}" alt="${esc(s.alt ?? s.caption ?? '')}" loading="lazy">`;
      return `<section ${id} class="wrap"><figure>${s.href ? `<a href="${esc(o.resolveHref(s.href))}">${img}</a>` : img}${
        s.caption ? `<figcaption>${esc(s.caption)}</figcaption>` : ''
      }</figure></section>`;
    }
    case 'gallery':
      return `<section ${id} class="wrap">${heading(b.settings.heading)}<div class="gallery">${b.settings.images
        .map(
          (i) =>
            `<figure><img src="${esc(o.mediaUrl(i.fileId))}" alt="${esc(i.caption ?? '')}" loading="lazy">${
              i.caption ? `<figcaption>${esc(i.caption)}</figcaption>` : ''
            }</figure>`,
        )
        .join('')}</div></section>`;
    case 'courses': {
      const courses = b.data?.courses ?? [];
      return `<section ${id} class="wrap">${heading(b.settings.heading)}<div class="grid">${
        courses
          .map((c) =>
            courseCard(
              c,
              b.settings.showDescription !== false,
              b.settings.showBuyButton ? o.checkoutHref(c.id) : null,
            ),
          )
          .join('') || '<p class="meta">New courses coming soon.</p>'
      }</div></section>`;
    }
    case 'batches': {
      const batches = b.data?.batches ?? [];
      return `<section ${id} class="wrap">${heading(b.settings.heading)}${
        batches.length
          ? `<div class="table"><table><thead><tr><th>Batch</th><th>Course</th><th>Branch</th><th>Starts</th><th>Mode</th><th>Seats</th></tr></thead><tbody>${batches
              .map(batchRow)
              .join('')}</tbody></table></div>`
          : '<p class="meta">New batches will be announced soon.</p>'
      }</section>`;
    }
    case 'faculty':
      return `<section ${id} class="wrap">${heading(b.settings.heading)}<div class="grid">${b.settings.members
        .map(
          (m) =>
            `<article class="card person">${
              m.photoFileId
                ? `<img src="${esc(o.mediaUrl(m.photoFileId))}" alt="${esc(m.name)}" loading="lazy">`
                : ''
            }<h3>${esc(m.name)}</h3>${m.subject ? `<p class="meta">${esc(m.subject)}</p>` : ''}${
              m.bio ? `<p>${esc(m.bio)}</p>` : ''
            }</article>`,
        )
        .join('')}</div></section>`;
    case 'testimonials':
      return `<section ${id} class="wrap">${heading(b.settings.heading)}<div class="grid">${b.settings.items
        .map(
          (t) =>
            `<blockquote class="card">${
              t.photoFileId
                ? `<img class="avatar" src="${esc(o.mediaUrl(t.photoFileId))}" alt="" loading="lazy">`
                : ''
            }<p>“${esc(t.quote)}”</p><footer>— ${esc(t.name)}${t.role ? `, ${esc(t.role)}` : ''}</footer></blockquote>`,
        )
        .join('')}</div></section>`;
    case 'announcements': {
      const items = b.data?.announcements ?? [];
      return `<section ${id} class="wrap">${heading(b.settings.heading)}${
        items.length
          ? `<ul class="announcements">${items.map(announcementItem).join('')}</ul>`
          : '<p class="meta">No announcements right now.</p>'
      }</section>`;
    }
    case 'enquiry_form': {
      const s = b.settings;
      return `<section ${id} class="wrap form"><a id="enquiry"></a>${heading(s.heading)}${s.intro ? `<p>${esc(s.intro)}</p>` : ''}
${flashFor(o, b.id)}
<form method="post" action="${formAction(o)}">${hiddenCommon(o, b.id)}
<label>Name *<input name="name" required minlength="2" maxlength="150" autocomplete="name"></label>
<label>Mobile *<input name="mobile" type="tel" required pattern="\\+?[0-9]{10,15}" autocomplete="tel"></label>
<label>Email<input name="email" type="email" autocomplete="email"></label>
${branchSelect(b.data?.branches)}
<label>Course of interest<input name="courseInterest" maxlength="150"></label>
${(b.data?.fields ?? []).map(fieldInput).join('\n')}
<label>Message<textarea name="message" maxlength="2000"></textarea></label>
<button class="btn" type="submit">${esc(s.submitLabel ?? 'Send enquiry')}</button></form></section>`;
    }
    case 'demo_form': {
      const s = b.settings;
      const slot = s.slots.length
        ? `<label>Demo session *<select name="slot" required>${s.slots
            .map((x) => `<option value="${esc(x.label)}">${esc(x.label)}</option>`)
            .join('')}</select></label>`
        : '<label>Preferred date &amp; time<input name="slot" maxlength="120"></label>';
      return `<section ${id} class="wrap form">${heading(s.heading)}${s.intro ? `<p>${esc(s.intro)}</p>` : ''}
${b.data?.courseName ? `<p class="meta">Course: ${esc(b.data.courseName)}</p>` : ''}
${flashFor(o, b.id)}
<form method="post" action="${formAction(o)}">${hiddenCommon(o, b.id)}
<label>Name *<input name="name" required minlength="2" maxlength="150" autocomplete="name"></label>
<label>Mobile *<input name="mobile" type="tel" required pattern="\\+?[0-9]{10,15}" autocomplete="tel"></label>
<label>Email<input name="email" type="email" autocomplete="email"></label>
${branchSelect(b.data?.branches)}
${slot}
<button class="btn" type="submit">${esc(s.submitLabel ?? 'Book a free demo')}</button></form></section>`;
    }
    case 'contact': {
      const s = b.settings;
      const address = s.address ?? o.contact.address;
      const phone = s.phone ?? o.contact.phone;
      const email = s.email || o.contact.email;
      const map = s.mapQuery ?? address;
      return `<section ${id} class="wrap contact">${heading(s.heading)}<div class="grid">
<div>${address ? `<p>${esc(address).replace(/\n/g, '<br>')}</p>` : ''}${
        phone ? `<p>📞 <a href="tel:${esc(phone)}">${esc(phone)}</a></p>` : ''
      }${email ? `<p>✉️ <a href="mailto:${esc(email)}">${esc(email)}</a></p>` : ''}</div>
${
  map
    ? `<iframe title="Map" class="map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${encodeURIComponent(
        map,
      )}&amp;output=embed"></iframe>`
    : ''
}</div></section>`;
    }
    case 'cta': {
      const s = b.settings;
      return `<section ${id} class="cta"><div class="wrap"><h2>${esc(s.heading)}</h2>${s.text ? `<p>${esc(s.text)}</p>` : ''}<a class="btn btn-lg btn-inv" href="${esc(
        o.resolveHref(s.buttonHref),
      )}">${esc(s.buttonLabel)}</a></div></section>`;
    }
  }
}

export function renderPage(blocks: ResolvedBlock[], o: RenderOptions): string {
  const primary = colour(o.theme.primaryColor ?? o.institute.primaryColor, '#3949ab');
  const secondary = colour(o.theme.secondaryColor ?? o.institute.secondaryColor, '#00897b');
  const font = FONTS[o.theme.font ?? 'system'] ?? FONTS.system;
  const title =
    o.page.seo?.title ??
    (o.page.isHome ? (o.siteSeo.title ?? o.institute.name) : `${o.page.title} | ${o.institute.name}`);
  const description = o.page.seo?.description ?? o.siteSeo.description ?? '';
  const ogImage = o.page.seo?.ogImageFileId ?? o.siteSeo.ogImageFileId ?? null;
  const robots = o.preview || !o.indexable ? 'noindex, nofollow' : 'index, follow';
  const socials = (o.theme.socialLinks ?? [])
    .filter((l) => /^https?:\/\//i.test(l.url))
    .map((l) => `<a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a>`)
    .join(' · ');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${esc(o.canonicalUrl)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(o.canonicalUrl)}">
<meta property="og:site_name" content="${esc(o.institute.name)}">
${ogImage ? `<meta property="og:image" content="${esc(o.absoluteMediaUrl(ogImage))}"><meta name="twitter:card" content="summary_large_image">` : ''}
${o.institute.logoUrl ? `<link rel="icon" href="${esc(o.institute.logoUrl)}">` : ''}
<style>
:root{--primary:${primary};--secondary:${secondary}}
*{box-sizing:border-box}body{margin:0;font-family:${font};color:#1f2933;line-height:1.6;background:#fff}
a{color:var(--primary)}img{max-width:100%;height:auto}
.wrap{max-width:1100px;margin:0 auto;padding:2rem 1.25rem}
header.site{background:#fff;border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:5}
header.site .wrap{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;padding:.75rem 1.25rem}
header.site .brand{display:flex;align-items:center;gap:.5rem;font-weight:700;color:inherit;text-decoration:none;font-size:1.15rem}
header.site .brand img{height:40px;width:auto}
nav{margin-left:auto;display:flex;gap:1rem;flex-wrap:wrap}nav a{text-decoration:none;color:#374151}nav a.active{color:var(--primary);font-weight:600}
.preview-banner{background:#fde68a;text-align:center;padding:.4rem;font-size:.9rem}
.hero{background:linear-gradient(135deg,var(--primary),var(--secondary));color:#fff;background-size:cover;background-position:center}
.hero.has-img{background-blend-mode:multiply;background-color:var(--primary)}
.hero .wrap{padding:5rem 1.25rem}.hero h1{font-size:clamp(2rem,5vw,3rem);margin:0 0 .5rem}.lead{font-size:1.2rem;opacity:.95}
h2{color:var(--primary);margin-top:0}
.btn{display:inline-block;background:var(--primary);color:#fff;padding:.6rem 1.2rem;border-radius:.5rem;text-decoration:none;border:0;font:inherit;cursor:pointer}
.btn-lg{padding:.85rem 1.6rem;font-size:1.1rem}.hero .btn,.btn-inv{background:#fff;color:var(--primary)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.25rem}
.card{border:1px solid #e5e7eb;border-radius:.75rem;padding:1.25rem;margin:0;background:#fff}
.card h3{margin:.25rem 0}.meta{color:#6b7280;font-size:.92rem}
.person img{width:96px;height:96px;object-fit:cover;border-radius:50%}.avatar{width:48px;height:48px;border-radius:50%;object-fit:cover}
blockquote footer{color:#6b7280;margin-top:.5rem}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.75rem}.gallery img{aspect-ratio:4/3;object-fit:cover;width:100%;border-radius:.5rem}
figure{margin:0}figcaption{color:#6b7280;font-size:.9rem}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #e5e7eb}
.announcements{list-style:none;padding:0}.announcements li{padding:.75rem 0;border-bottom:1px solid #e5e7eb}
.form form{display:grid;gap:.75rem;max-width:560px}label{display:grid;gap:.25rem;font-weight:500}
label.check{display:flex;gap:.5rem;align-items:center}
input,select,textarea{font:inherit;padding:.55rem .7rem;border:1px solid #d1d5db;border-radius:.4rem;width:100%}
textarea{min-height:90px}.hp{position:absolute;left:-9999px}
.flash{padding:.75rem 1rem;border-radius:.5rem}.flash.ok{background:#dcfce7}.flash.err{background:#fee2e2}
.map{width:100%;min-height:300px;border:0;border-radius:.75rem}
.cta{background:var(--secondary);color:#fff;text-align:center}.cta h2{color:#fff}
footer.site{background:#111827;color:#d1d5db;font-size:.92rem}footer.site a{color:#fff}
</style></head><body>
${o.preview ? '<div class="preview-banner">Preview of the current draft — publish to make changes live.</div>' : ''}
<header class="site"><div class="wrap"><a class="brand" href="${esc(o.basePath || '/')}${o.basePath ? '/' : ''}">${
    o.institute.logoUrl ? `<img src="${esc(o.institute.logoUrl)}" alt="">` : ''
  }<span>${esc(o.institute.name)}</span></a>
<nav>${o.nav.map((n) => `<a href="${esc(n.href)}"${n.active ? ' class="active"' : ''}>${esc(n.title)}</a>`).join('')}</nav></div></header>
<main>
${blocks.map((b) => renderBlock(b, o)).join('\n')}
</main>
<footer class="site"><div class="wrap">${o.theme.footerText ? `<p>${esc(o.theme.footerText)}</p>` : ''}${socials ? `<p>${socials}</p>` : ''}
<p>© ${new Date().getFullYear()} ${esc(o.institute.name)}</p></div></footer>
</body></html>`;
}

export function renderSitemap(urls: { loc: string; lastmod: Date }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod.toISOString().slice(0, 10)}</lastmod></url>`).join('\n')}
</urlset>
`;
}

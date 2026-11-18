import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Institute } from '../src/modules/institutes/institute.model';
import { Enquiry } from '../src/modules/admissions/models';
import { redeemCoupon, releaseCoupon, setCheckoutHandoff, validateCoupon } from '../src/modules/website/api';
import { asInstitute } from '../src/modules/website/site.service';
import { USERS, bearer, getApp, idWatermarks, login, purgeCreatedSince, snapshotRows } from './helpers';

const PUB = '/api/public/sites';
const run = Date.now().toString(36);
let seq = 0;
const mobile = () => `934${String(Date.now() % 10000).padStart(4, '0')}${String(seq++).padStart(3, '0')}`;

/** Rows the suite creates (enquiries and applications from public forms and checkout), purged afterwards. */
const CREATED_TABLES = [
  'admission_applications',
  'enquiries',
  'website_referral_codes',
  'website_coupons',
  'website_announcements',
  'website_page_versions',
  'website_pages',
  'website_sites',
  'students',
  'users',
  'batches',
  'courses',
  'notification_messages',
  'jobs',
] as const;
let watermarks: Record<string, number>;
let restoreSites: () => Promise<void>;
let restorePages: () => Promise<void>;

beforeAll(async () => {
  await getApp();
  watermarks = await idWatermarks(CREATED_TABLES);
  // The suite edits, publishes and restores the existing sites and home pages (domains included).
  restoreSites = await snapshotRows('website_sites', '1 = 1');
  restorePages = await snapshotRows('website_pages', '1 = 1');
});

afterAll(async () => {
  await purgeCreatedSince(watermarks);
  await restorePages();
  await restoreSites();
});

describe('website builder & online admissions', () => {
  let apex: string;
  let zenith: string;
  let teacher: string;
  let branchAdmin: string;
  let apexId: number;
  let zenithId: number;
  let homeId: number;
  let courseId: number;

  beforeAll(async () => {
    await getApp();
    apex = (await login(USERS.apexAdmin)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
    branchAdmin = (await login(USERS.apexBranchAdmin)).accessToken;
    apexId = (await Institute.findOne({ where: { slug: 'apex' } }))!.id;
    zenithId = (await Institute.findOne({ where: { slug: 'zenith' } }))!.id;
  });

  afterAll(() => setCheckoutHandoff(null));

  it('enforces permissions', async () => {
    const app = await getApp();
    expect((await request(app).get('/api/website/pages').set(bearer(teacher))).status).toBe(403);
    expect((await request(app).get('/api/website/site')).status).toBe(401);
    const pages = await request(app).get('/api/website/pages').set(bearer(branchAdmin));
    expect(pages.status).toBe(200);
    expect(
      (await request(app).post(`/api/website/pages/${pages.body[0].id}/publish`).set(bearer(branchAdmin)))
        .status,
    ).toBe(403);
    expect((await request(app).patch('/api/website/site').set(bearer(branchAdmin)).send({})).status).toBe(
      403,
    );
  });

  it('builds, previews, publishes and versions pages', async () => {
    const app = await getApp();
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(apex))
      .send({ name: `Web Course ${run}`, code: `W${run}`.toUpperCase(), mode: 'offline' });
    expect(course.status).toBe(201);
    courseId = course.body.id;

    const list = await request(app).get('/api/website/pages').set(bearer(apex));
    const home = list.body.find((p: { isHome: boolean }) => p.isHome);
    homeId = home.id;
    const page = await request(app).get(`/api/website/pages/${homeId}`).set(bearer(apex));
    expect(page.body.blocks.map((b: { type: string }) => b.type)).toContain('enquiry_form');

    // Invalid blocks are rejected
    const bad = await request(app)
      .patch(`/api/website/pages/${homeId}`)
      .set(bearer(apex))
      .send({ blocks: [{ id: 'x', type: 'marquee', settings: {} }] });
    expect(bad.status).toBe(422);
    const foreignImage = await request(app)
      .patch(`/api/website/pages/${homeId}`)
      .set(bearer(apex))
      .send({ blocks: [{ id: 'img', type: 'image', settings: { fileId: 999999 } }] });
    expect(foreignImage.status).toBe(400);

    const blocks = [
      ...page.body.blocks,
      {
        id: 'intro',
        type: 'text',
        settings: { heading: 'About', body: 'We teach **well**. <script>x</script>' },
      },
    ];
    expect(
      (await request(app).patch(`/api/website/pages/${homeId}`).set(bearer(apex)).send({ blocks })).status,
    ).toBe(200);
    expect(
      (await request(app).post(`/api/website/pages/${homeId}/publish`).set(bearer(apex))).body.status,
    ).toBe('published');

    const html = await request(app).get(`${PUB}/apex`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.text).toContain('<strong>well</strong>');
    expect(html.text).toContain('&lt;script&gt;');
    expect(html.text).not.toContain('<script>');
    expect(html.text).toContain(`Web Course ${run}`);
    expect(html.headers['content-security-policy']).toContain("default-src 'none'");

    // Draft changes stay private until published
    const draft = blocks.map((b) => (b.id === 'intro' ? { ...b, settings: { body: 'Draft only text' } } : b));
    const patched = await request(app)
      .patch(`/api/website/pages/${homeId}`)
      .set(bearer(apex))
      .send({ blocks: draft });
    expect(patched.body.status).toBe('changed');
    expect((await request(app).get(`${PUB}/apex`)).text).not.toContain('Draft only text');
    const preview = await request(app).get(`/api/website/pages/${homeId}/preview`).set(bearer(apex));
    expect(preview.body.html).toContain('Draft only text');
    expect(preview.body.html).toContain('noindex');

    await request(app).post(`/api/website/pages/${homeId}/publish`).set(bearer(apex));
    expect((await request(app).get(`${PUB}/apex`)).text).toContain('Draft only text');
    const versions = await request(app).get(`/api/website/pages/${homeId}/versions`).set(bearer(apex));
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const restored = await request(app)
      .post(`/api/website/pages/${homeId}/versions/${versions.body[1].id}/restore`)
      .set(bearer(apex));
    expect(restored.body.status).toBe('changed');
    expect(JSON.stringify(restored.body.blocks)).toContain('We teach');

    // Unpublished pages 404 publicly; JSON API serves resolved blocks
    const about = await request(app)
      .post('/api/website/pages')
      .set(bearer(apex))
      .send({
        slug: 'about',
        title: 'About us',
        blocks: [{ id: 't', type: 'text', settings: { body: 'Hello' } }],
      });
    expect(about.status).toBe(201);
    expect(
      (await request(app).post('/api/website/pages').set(bearer(apex)).send({ slug: 'about', title: 'x' }))
        .status,
    ).toBe(409);
    expect((await request(app).get(`${PUB}/apex/p/about`)).status).toBe(404);
    await request(app).post(`/api/website/pages/${about.body.id}/publish`).set(bearer(apex));
    expect((await request(app).get(`${PUB}/apex/p/about`)).text).toContain('Hello');
    const json = await request(app).get(`${PUB}/apex/pages/${'home'}`);
    expect(json.status).toBe(200);
    const courses = json.body.blocks.find((b: { type: string }) => b.type === 'courses');
    expect(courses.data.courses.some((c: { id: number }) => c.id === courseId)).toBe(true);
    const site = await request(app).get(`${PUB}/apex/site`);
    expect(site.body.pages.map((p: { slug: string }) => p.slug)).toEqual(
      expect.arrayContaining(['home', 'about']),
    );
  });

  it('serves sitemap.xml and robots.txt honouring indexability', async () => {
    const app = await getApp();
    const sitemap = await request(app).get(`${PUB}/apex/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).toContain('/p/about</loc>');
    expect((await request(app).get(`${PUB}/apex/robots.txt`)).text).toContain('Sitemap:');

    const patch = await request(app)
      .patch('/api/website/site')
      .set(bearer(apex))
      .send({ seo: { title: 'Apex Coaching', indexable: false }, theme: { primaryColor: '#112233' } });
    expect(patch.status).toBe(200);
    expect((await request(app).get(`${PUB}/apex/robots.txt`)).text).toContain('Disallow: /');
    expect((await request(app).get(`${PUB}/apex/sitemap.xml`)).text).not.toContain('<url>');
    const html = (await request(app).get(`${PUB}/apex`)).text;
    expect(html).toContain('noindex');
    expect(html).toContain('#112233');
    await request(app)
      .patch('/api/website/site')
      .set(bearer(apex))
      .send({ seo: { indexable: true } });
  });

  it('feeds enquiry and demo forms into admissions enquiries', async () => {
    const app = await getApp();
    const m = mobile();
    const res = await request(app)
      .post(`${PUB}/apex/forms/home`)
      .send({ block: 'enquiry-form', name: 'Web Lead', mobile: m, courseId, instituteId: zenithId });
    expect(res.status).toBe(201);
    const enquiry = await Enquiry.findOne({ where: { id: res.body.enquiryId, instituteId: apexId } });
    expect(enquiry).toMatchObject({ instituteId: apexId, source: 'website', mobile: m, courseId });

    // HTML form: post/redirect/get with flash
    const form = await request(app)
      .post(`${PUB}/apex/forms/home`)
      .type('form')
      .send({ block: 'enquiry-form', name: 'Form Lead', mobile: mobile() });
    expect(form.status).toBe(303);
    expect(form.headers.location).toContain('submitted=enquiry-form');
    const flash = await request(app).get(form.headers.location.split('#')[0]);
    expect(flash.text).toContain('flash ok');
    const invalid = await request(app)
      .post(`${PUB}/apex/forms/home`)
      .type('form')
      .send({ block: 'enquiry-form', name: 'X', mobile: '12' });
    expect(invalid.status).toBe(303);
    expect(invalid.headers.location).toContain('formError=enquiry-form');

    // Honeypot: accepted silently, nothing stored
    const before = await Enquiry.count({ where: { instituteId: apexId } });
    await request(app)
      .post(`${PUB}/apex/forms/home`)
      .send({ block: 'enquiry-form', name: 'Bot', mobile: mobile(), website: 'spam' });
    expect(await Enquiry.count({ where: { instituteId: apexId } })).toBe(before);
    expect(
      (
        await request(app)
          .post(`${PUB}/apex/forms/home`)
          .send({ block: 'intro', name: 'A B', mobile: mobile() })
      ).status,
    ).toBe(404);

    // Demo-class registration
    const demo = await request(app)
      .post('/api/website/pages')
      .set(bearer(apex))
      .send({
        slug: 'demo',
        title: 'Free demo',
        blocks: [
          {
            id: 'demo',
            type: 'demo_form',
            settings: { courseId, slots: [{ label: 'Sat 10am' }, { label: 'Sun 4pm' }] },
          },
        ],
      });
    await request(app).post(`/api/website/pages/${demo.body.id}/publish`).set(bearer(apex));
    expect(
      (
        await request(app)
          .post(`${PUB}/apex/forms/demo`)
          .send({ block: 'demo', name: 'Demo Kid', mobile: mobile(), slot: 'Mon' })
      ).status,
    ).toBe(400);
    const ok = await request(app)
      .post(`${PUB}/apex/forms/demo`)
      .send({ block: 'demo', name: 'Demo Kid', mobile: mobile(), slot: 'Sun 4pm' });
    expect(ok.status).toBe(201);
    const demoEnquiry = await Enquiry.findOne({ where: { id: ok.body.enquiryId, instituteId: apexId } });
    expect(demoEnquiry!.notes).toContain('[Demo class] Sun 4pm');
    expect(demoEnquiry!.courseId).toBe(courseId);
  });

  it('tracks referral clicks and signups', async () => {
    const app = await getApp();
    const code = `REF${run}`.toUpperCase();
    const created = await request(app)
      .post('/api/website/referrals')
      .set(bearer(apex))
      .send({ code, name: 'Alumni partner' });
    expect(created.status).toBe(201);
    expect(created.body.shareUrl).toContain(`/r/${code}`);

    const click = await request(app).get(`${PUB}/apex/r/${code}`).set('User-Agent', 'ua-1');
    expect(click.status).toBe(302);
    expect(click.headers.location).toBe(`${PUB}/apex/?ref=${code}`);
    await request(app).get(`${PUB}/apex/r/${code}`).set('User-Agent', 'ua-1');
    await request(app).get(`${PUB}/apex/r/${code}`).set('User-Agent', 'ua-2');
    const landing = await request(app).get(`${PUB}/apex/?ref=${code}`);
    expect(landing.text).toContain(`register/apex?ref=${code}`);

    await request(app)
      .post(`${PUB}/apex/forms/home`)
      .send({ block: 'enquiry-form', name: 'Referred Lead', mobile: mobile(), ref: code.toLowerCase() });
    const list = await request(app).get('/api/website/referrals').set(bearer(apex)).query({ search: code });
    expect(list.body.items[0]).toMatchObject({ code, clicks: 2, signups: 1, purchases: 0 });
    const events = await request(app)
      .get(`/api/website/referrals/${created.body.id}/events`)
      .set(bearer(apex));
    expect(events.body.items.map((e: { kind: string }) => e.kind).sort()).toEqual([
      'click',
      'click',
      'signup',
    ]);

    // Zenith cannot see or touch Apex's referral codes
    expect(
      (await request(app).get(`/api/website/referrals/${created.body.id}/events`).set(bearer(zenith))).status,
    ).toBe(404);
  });

  it('manages coupons and validates/redeems them for fees', async () => {
    const app = await getApp();
    const code = `SAVE${run}`.toUpperCase();
    const c = await request(app).post('/api/website/coupons').set(bearer(apex)).send({
      code,
      discountType: 'percent',
      discountValue: 20,
      maxDiscount: 1000,
      minAmount: 500,
      usageLimit: 1,
      perCustomerLimit: 1,
    });
    expect(c.status).toBe(201);
    expect(
      (
        await request(app)
          .post('/api/website/coupons')
          .set(bearer(apex))
          .send({ code, discountType: 'fixed', discountValue: 5 })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post('/api/website/coupons')
          .set(bearer(apex))
          .send({ code: 'BIG', discountType: 'percent', discountValue: 150 })
      ).status,
    ).toBe(422);

    const v = await request(app)
      .post('/api/website/coupons/validate')
      .set(bearer(apex))
      .send({ code: code.toLowerCase(), amountPaise: 1_000_000 });
    expect(v.body).toMatchObject({ valid: true, discountPaise: 100_000, finalAmountPaise: 900_000 });
    const pub = await request(app).post(`${PUB}/apex/coupons/validate`).send({ code, amountPaise: 10_000 });
    expect(pub.body).toMatchObject({ valid: false, reason: 'MIN_AMOUNT', couponId: null });
    expect(
      (await request(app).post(`${PUB}/zenith/coupons/validate`).send({ code, amountPaise: 1_000_000 })).body
        .reason,
    ).toBe('NOT_FOUND');

    await asInstitute(apexId, async () => {
      expect((await validateCoupon({ code: 'NOPE', amountPaise: 1 })).reason).toBe('NOT_FOUND');
      expect(
        (await validateCoupon({ code, amountPaise: 100_000, now: new Date(Date.now() - 1) })).valid,
      ).toBe(true);
      const r1 = await redeemCoupon({
        code,
        amountPaise: 100_000,
        orderRef: `o1-${run}`,
        customerKey: 'cust-1',
      });
      expect(r1.discountPaise).toBe(20_000);
      const again = await redeemCoupon({
        code,
        amountPaise: 100_000,
        orderRef: `o1-${run}`,
        customerKey: 'cust-1',
      });
      expect(again.discountPaise).toBe(20_000);
      await expect(redeemCoupon({ code, amountPaise: 100_000, orderRef: `o2-${run}` })).rejects.toMatchObject(
        {
          status: 409,
          code: 'COUPON_USAGE_LIMIT',
        },
      );
      expect(await releaseCoupon({ code, orderRef: `o1-${run}` })).toBe(true);
      expect(await releaseCoupon({ code, orderRef: `o1-${run}` })).toBe(false);
      expect((await redeemCoupon({ code, amountPaise: 100_000, orderRef: `o2-${run}` })).valid).toBe(true);
    });
    const after = await request(app).get(`/api/website/coupons/${c.body.id}`).set(bearer(apex));
    expect(after.body.usedCount).toBe(1);
    const reds = await request(app).get(`/api/website/coupons/${c.body.id}/redemptions`).set(bearer(apex));
    expect(reds.body.items.map((x: { status: string }) => x.status).sort()).toEqual(['redeemed', 'released']);
    expect((await request(app).delete(`/api/website/coupons/${c.body.id}`).set(bearer(apex))).status).toBe(
      409,
    );

    const expired = await request(app)
      .patch(`/api/website/coupons/${c.body.id}`)
      .set(bearer(apex))
      .send({
        validUntil: new Date(Date.now() - 86_400_000).toISOString(),
        validFrom: null,
      });
    expect(expired.status).toBe(200);
    await asInstitute(apexId, async () => {
      expect((await validateCoupon({ code, amountPaise: 100_000 })).reason).toBe('EXPIRED');
    });

    // Tenant isolation
    expect((await request(app).get(`/api/website/coupons/${c.body.id}`).set(bearer(zenith))).status).toBe(
      404,
    );
    const zl = await request(app).get('/api/website/coupons').set(bearer(zenith));
    expect(zl.body.items.some((x: { code: string }) => x.code === code)).toBe(false);
  });

  it('hands checkout off to fees, falling back to online admission', async () => {
    const app = await getApp();
    const fallback = await request(app).get(`${PUB}/apex/checkout/${courseId}?ref=ABC123&coupon=save`);
    expect(fallback.status).toBe(302);
    expect(fallback.headers.location).toMatch(/\/register\/apex\?ref=ABC123&courseId=\d+$/);

    setCheckoutHandoff(async (i) => ({
      url: `https://pay.example.com/checkout?inst=${i.instituteSlug}&course=${i.courseId}&coupon=${i.couponCode}`,
    }));
    const handed = await request(app).post(`${PUB}/apex/checkout/${courseId}`).send({ coupon: 'save' });
    expect(handed.body).toEqual({
      url: `https://pay.example.com/checkout?inst=apex&course=${courseId}&coupon=SAVE`,
      handler: 'fees',
    });
    setCheckoutHandoff(null);
    // Another institute's catalogue does not include Apex's course
    expect((await request(app).get(`${PUB}/zenith/checkout/${courseId}`)).status).toBe(404);
  });

  it('isolates tenants and resolves sites by subdomain and custom domain', async () => {
    const app = await getApp();
    expect((await request(app).get(`/api/website/pages/${homeId}`).set(bearer(zenith))).status).toBe(404);
    expect((await request(app).post(`/api/website/pages/${homeId}/publish`).set(bearer(zenith))).status).toBe(
      404,
    );
    const zPages = await request(app).get('/api/website/pages').set(bearer(zenith));
    expect(zPages.body.some((p: { id: number }) => p.id === homeId)).toBe(false);
    // Zenith has not published anything: its public site is not Apex's
    expect((await request(app).get(`${PUB}/zenith`)).status).toBe(404);
    expect((await request(app).get(`${PUB}/zenith/p/about`)).status).toBe(404);
    expect((await request(app).get(`${PUB}/nope-${run}`)).status).toBe(404);

    const sub = `apex-${run}`;
    const domain = `www.apex-${run}.example.org`;
    const set = await request(app)
      .patch('/api/website/site')
      .set(bearer(apex))
      .send({ subdomain: sub, customDomain: domain });
    expect(set.status).toBe(200);
    expect(set.body.publicUrl).toBe(`https://${domain}`);
    expect(
      (await request(app).patch('/api/website/site').set(bearer(zenith)).send({ subdomain: sub })).status,
    ).toBe(409);
    expect(
      (await request(app).patch('/api/website/site').set(bearer(apex)).send({ subdomain: 'admin' })).status,
    ).toBe(422);

    const bySub = await request(app).get(`${PUB}/_host`).set('Host', `${sub}.erp.example.com`);
    expect(bySub.status).toBe(200);
    expect(bySub.text).toContain('href="/p/about"');
    const byDomain = await request(app).get(`${PUB}/_host/p/about`).set('Host', domain);
    expect(byDomain.text).toContain('Hello');
    expect((await request(app).get(`${PUB}/_host`).set('Host', `unknown-${run}.example.net`)).status).toBe(
      404,
    );

    // Media: only images used by published pages are public
    expect((await request(app).get(`${PUB}/apex/media/1`)).status).toBe(404);
  });

  it('manages announcements shown on the public site', async () => {
    const app = await getApp();
    const a = await request(app)
      .post('/api/website/announcements')
      .set(bearer(apex))
      .send({ title: `Admissions open ${run}`, body: 'Apply **now**', isPinned: true });
    expect(a.status).toBe(201);
    await request(app)
      .post('/api/website/announcements')
      .set(bearer(apex))
      .send({ title: `Hidden ${run}`, isPublished: false });
    expect(
      (
        await request(app)
          .post('/api/website/announcements')
          .set(bearer(apex))
          .send({ title: 'x', linkUrl: 'javascript:alert(1)' })
      ).status,
    ).toBe(422);
    const html = (await request(app).get(`${PUB}/apex`)).text;
    expect(html).toContain(`Admissions open ${run}`);
    expect(html).not.toContain(`Hidden ${run}`);
    const upd = await request(app)
      .patch(`/api/website/announcements/${a.body.id}`)
      .set(bearer(apex))
      .send({ isPublished: false });
    expect(upd.body.isPublished).toBe(false);
    expect((await request(app).get(`${PUB}/apex`)).text).not.toContain(`Admissions open ${run}`);
    expect(
      (await request(app).delete(`/api/website/announcements/${a.body.id}`).set(bearer(zenith))).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/website/announcements/${a.body.id}`).set(bearer(apex))).status,
    ).toBe(204);
  });
});

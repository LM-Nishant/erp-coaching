import request from 'supertest';
import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { MktSaleLedger, MktSeller, MktSettings } from '../src/modules/marketplace/models';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';

/** Test mobiles start with 964 (the marketplace demo users are 9640000001/2). */
let seq = 0;
const mobile = () => `96411${String(seq++).padStart(5, '0')}`;
const VIDEO = Buffer.from('0000001866747970', 'hex'); // a few bytes are enough without ffmpeg

let app: Express;
let admin: string;

async function newAccount(name: string) {
  const m = mobile();
  const res = await request(app)
    .post('/api/marketplace/public/signup')
    .send({ name, mobile: m, password: DEMO_PASSWORD });
  expect(res.status).toBe(201);
  return (await login({ mobile: m, password: DEMO_PASSWORD })).accessToken;
}

async function upload(
  token: string,
  base: string,
  kind: 'video' | 'image' | 'file',
  data: Buffer,
  mime: string,
) {
  const start = await request(app)
    .post(`${base}/media`)
    .set(bearer(token))
    .send({ kind, name: `x.${mime.split('/')[1]}`, mimeType: mime, sizeBytes: data.length });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  const put = await request(app)
    .put(`${base}/media/${start.body.id}/content?offset=0`)
    .set(bearer(token))
    .set('content-type', 'application/octet-stream')
    .send(data);
  expect(put.status).toBe(200);
  await processDueJobs();
  return start.body.id as number;
}

/** Builds a complete, submittable course in a seller's studio and returns its id. */
async function buildCourse(token: string, base: string, pricePaise: number, title = `Course ${mobile()}`) {
  const thumb = await upload(token, base, 'image', Buffer.from('\x89PNG fake'), 'image/png');
  const cats = await request(app).get('/api/marketplace/public/categories');
  const created = await request(app)
    .post(`${base}/courses`)
    .set(bearer(token))
    .send({
      title,
      subtitle: 'A short subtitle',
      description: 'A description that is comfortably longer than fifty characters in total.',
      categoryId: cats.body[0].id,
      pricePaise,
      outcomes: ['One thing', 'Another thing'],
      thumbnailMediaId: thumb,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as number;
  const section = await request(app)
    .post(`${base}/courses/${id}/sections`)
    .set(bearer(token))
    .send({ title: 'Intro' });
  expect(section.status, JSON.stringify(section.body)).toBe(201);
  const sectionId = section.body.sections.at(-1).id as number;
  const video = await upload(token, base, 'video', VIDEO, 'video/mp4');
  const lectures = [
    { title: 'Welcome', type: 'video', mediaId: video, preview: true, durationSeconds: 100 },
    { title: 'Read me', type: 'article', articleBody: 'Hello learners' },
  ];
  for (const l of lectures) {
    const res = await request(app)
      .post(`${base}/courses/${id}/sections/${sectionId}/lectures`)
      .set(bearer(token))
      .send(l);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  return id;
}

async function publish(token: string, base: string, id: number) {
  const submit = await request(app).post(`${base}/courses/${id}/submit`).set(bearer(token));
  expect(submit.status, JSON.stringify(submit.body)).toBe(200);
  const approve = await request(app)
    .post(`/api/admin/marketplace/courses/${id}/approve`)
    .set(bearer(admin))
    .send({});
  expect(approve.status).toBe(200);
  expect(approve.body.status).toBe('published');
}

async function buy(token: string, courseIds: number[], couponCode?: string) {
  const checkout = await request(app)
    .post('/api/marketplace/checkout')
    .set(bearer(token))
    .send({ courseIds, couponCode });
  expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
  if (checkout.body.payment) {
    const done = await request(app)
      .post(`/api/marketplace/orders/${checkout.body.orderId}/mock-complete`)
      .set(bearer(token))
      .send({ outcome: 'success' });
    expect(done.body.order.status).toBe('paid');
  }
  return checkout.body.orderId as number;
}

beforeAll(async () => {
  app = await getApp();
  admin = (await login(USERS.superAdmin)).accessToken;
});

describe('public catalog', () => {
  it('lists the seeded categories and courses, filters and hides non-preview content', async () => {
    const home = await request(app).get('/api/marketplace/public/home');
    expect(home.status).toBe(200);
    expect(home.body.categories.map((c: { slug: string }) => c.slug)).toContain('test-prep');

    const free = await request(app).get('/api/marketplace/public/courses?price=free');
    expect(free.body.items.every((c: { pricePaise: number }) => c.pricePaise === 0)).toBe(true);
    const search = await request(app).get('/api/marketplace/public/courses?q=python');
    expect(search.body.items[0].slug).toBe('python-for-absolute-beginners');
    const byCategory = await request(app).get('/api/marketplace/public/courses?category=medical-entrance');
    expect(byCategory.body.items.map((c: { slug: string }) => c.slug)).toEqual(['neet-biology-crash-course']);

    const detail = await request(app).get(
      '/api/marketplace/public/courses/jee-physics-mechanics-masterclass',
    );
    expect(detail.status).toBe(200);
    expect(detail.body.seller.slug).toBe('apex-coaching-classes');
    const lectures = detail.body.sections.flatMap((s: { lectures: unknown[] }) => s.lectures);
    const preview = lectures.find((l: { preview: boolean }) => l.preview);
    const locked = lectures.find((l: { preview: boolean }) => !l.preview);
    expect(JSON.stringify(detail.body)).not.toContain('articleBody');

    const open = await request(app).get(`/api/marketplace/public/lectures/${preview.id}/preview`);
    expect(open.status).toBe(200);
    expect(open.body.stream.fileUrl).toContain('/api/marketplace/public/media/');
    const media = await request(app)
      .get(new URL(open.body.stream.fileUrl).pathname)
      .set('Range', 'bytes=0-9');
    expect(media.status).toBe(206);
    expect((await request(app).get(`/api/marketplace/public/lectures/${locked.id}/preview`)).status).toBe(
      404,
    );

    const seller = await request(app).get('/api/marketplace/public/instructors/riya-sharma');
    expect(seller.body.courses.length).toBeGreaterThanOrEqual(2);
    expect((await request(app).get('/api/marketplace/public/media/forged.token')).status).toBe(404);
  });
});

describe('instructor studio and review', () => {
  it('requires an instructor profile, then takes a course through review to the catalog', async () => {
    const token = await newAccount('Indie Instructor');
    const base = '/api/marketplace/instructor';
    const none = await request(app).get(`${base}/courses`).set(bearer(token));
    expect(none.body.error.code).toBe('INSTRUCTOR_PROFILE_REQUIRED');
    const profile = await request(app)
      .put('/api/marketplace/instructor-profile')
      .set(bearer(token))
      .send({ displayName: 'Indie Instructor', headline: 'Teaches things' });
    expect(profile.status).toBe(200);

    const empty = await request(app).post(`${base}/courses`).set(bearer(token)).send({ title: 'Too early' });
    const notReady = await request(app).post(`${base}/courses/${empty.body.id}/submit`).set(bearer(token));
    expect(notReady.status).toBe(400);
    expect(notReady.body.error.details.issues).toContain('Add at least one lecture');

    const id = await buildCourse(token, base, 29900, 'Indie Review Course');
    expect((await request(app).post(`${base}/courses/${id}/submit`).set(bearer(token))).body.status).toBe(
      'in_review',
    );
    const queue = await request(app).get('/api/admin/marketplace/courses').set(bearer(admin));
    expect(queue.body.map((c: { course: { id: number } }) => c.course.id)).toContain(id);
    expect(
      (await request(app).post(`/api/admin/marketplace/courses/${id}/reject`).set(bearer(admin)).send({}))
        .status,
    ).toBe(422);
    const rejected = await request(app)
      .post(`/api/admin/marketplace/courses/${id}/reject`)
      .set(bearer(admin))
      .send({ reason: 'Add more lectures' });
    expect(rejected.body.status).toBe('rejected');
    const mine = await request(app).get(`${base}/courses/${id}`).set(bearer(token));
    expect(mine.body.reviewNote).toBe('Add more lectures');
    let hits = await request(app).get('/api/marketplace/public/courses?q=Indie%20Review');
    expect(hits.body.items).toHaveLength(0);

    await publish(token, base, id);
    hits = await request(app).get('/api/marketplace/public/courses?q=Indie%20Review');
    expect(hits.body.items.map((c: { id: number }) => c.id)).toEqual([id]);

    // admin unpublish hides it; admin can publish it again
    await request(app).post(`/api/admin/marketplace/courses/${id}/unpublish`).set(bearer(admin)).send({});
    hits = await request(app).get('/api/marketplace/public/courses?q=Indie%20Review');
    expect(hits.body.items).toHaveLength(0);
    expect(
      (await request(app).post(`/api/admin/marketplace/courses/${id}/publish`).set(bearer(admin))).body
        .status,
    ).toBe('published');
  });

  it("keeps sellers out of each other's courses and coupons", async () => {
    const a = await newAccount('Seller A');
    const b = await newAccount('Seller B');
    for (const t of [a, b])
      await request(app)
        .put('/api/marketplace/instructor-profile')
        .set(bearer(t))
        .send({ displayName: 'Seller' });
    const base = '/api/marketplace/instructor';
    const course = await request(app).post(`${base}/courses`).set(bearer(a)).send({ title: 'Private draft' });
    const coupon = await request(app)
      .post(`${base}/coupons`)
      .set(bearer(a))
      .send({ code: `A${mobile()}`, kind: 'percent', value: 10 });
    expect(coupon.status).toBe(201);

    expect((await request(app).get(`${base}/courses/${course.body.id}`).set(bearer(b))).status).toBe(404);
    expect(
      (await request(app).patch(`${base}/courses/${course.body.id}`).set(bearer(b)).send({ title: 'x' }))
        .status,
    ).toBe(404);
    expect((await request(app).delete(`${base}/coupons/${coupon.body.id}`).set(bearer(b))).status).toBe(404);
    expect((await request(app).get(`/api/marketplace/public/courses/${course.body.slug}`)).status).toBe(404);

    // an institute admin only sees their own institute's storefront
    const zenith = (await login(USERS.zenithAdmin)).accessToken;
    const apexCourses = await request(app)
      .get('/api/marketplace/institute/courses')
      .set(bearer((await login(USERS.apexAdmin)).accessToken));
    expect(apexCourses.body.length).toBeGreaterThan(0);
    expect(
      (
        await request(app)
          .get(`/api/marketplace/institute/courses/${apexCourses.body[0].id}`)
          .set(bearer(zenith))
      ).status,
    ).toBe(404);
  });

  it('guards institute storefront routes with marketplace permissions', async () => {
    const learner = await newAccount('No Institute');
    expect((await request(app).get('/api/marketplace/institute/courses').set(bearer(learner))).status).toBe(
      403,
    );
    const teacher = (await login(USERS.apexTeacher)).accessToken;
    expect((await request(app).get('/api/marketplace/institute/courses').set(bearer(teacher))).status).toBe(
      200,
    );
    const del = await request(app).delete('/api/marketplace/institute/courses/1').set(bearer(teacher));
    expect(del.body.error.code).toBe('PERMISSION_DENIED');
    expect(
      (await request(app).get('/api/admin/marketplace/settings').set(bearer(learner))).body.error.code,
    ).toBe('SUPER_ADMIN_ONLY');
    expect((await request(app).get('/api/marketplace/cart')).status).toBe(401);
  });
});

describe('buying and learning', () => {
  it('sells with coupons, records commission in the ledger and enrols the buyer', async () => {
    const seller = await newAccount('Ledger Seller');
    await request(app)
      .put('/api/marketplace/instructor-profile')
      .set(bearer(seller))
      .send({ displayName: 'Ledger Seller' });
    const base = '/api/marketplace/instructor';
    const id = await buildCourse(seller, base, 100000);
    await publish(seller, base, id);
    const code = `L${mobile()}`;
    await request(app)
      .post(`${base}/coupons`)
      .set(bearer(seller))
      .send({ code, kind: 'amount', value: 20000 });

    await request(app)
      .put('/api/admin/marketplace/settings')
      .set(bearer(admin))
      .send({ commissionPercent: 25 });
    const buyer = await newAccount('Buyer');
    const cart = await request(app)
      .post('/api/marketplace/cart/items')
      .set(bearer(buyer))
      .send({ courseId: id });
    expect(cart.status).toBe(201);
    const priced = await request(app).get(`/api/marketplace/cart?coupon=${code}`).set(bearer(buyer));
    expect(priced.body.totalPaise).toBe(80000);
    const bad = await request(app)
      .post('/api/marketplace/checkout')
      .set(bearer(buyer))
      .send({ couponCode: 'NOPE123' });
    expect(bad.status).toBe(400);

    expect((await request(app).get(`/api/marketplace/learning/${id}`).set(bearer(buyer))).status).toBe(404);
    const orderId = await buy(buyer, [id], code);
    const ledger = await MktSaleLedger.findOne({ where: { orderId } });
    expect(ledger).toMatchObject({ grossPaise: 80000, commissionPaise: 20000, netPaise: 60000 });
    expect((await request(app).get('/api/marketplace/cart').set(bearer(buyer))).body.items).toHaveLength(0);

    // the seller override wins over the platform default
    const sellerRow = (await MktSeller.findOne({ where: { displayName: 'Ledger Seller' } }))!;
    await request(app)
      .patch(`/api/admin/marketplace/sellers/${sellerRow.id}`)
      .set(bearer(admin))
      .send({ commissionPercent: 10 });
    const buyer2 = await newAccount('Buyer Two');
    const order2 = await buy(buyer2, [id]);
    expect(await MktSaleLedger.findOne({ where: { orderId: order2 } })).toMatchObject({
      commissionPaise: 10000,
      netPaise: 90000,
    });
    const sales = await request(app).get(`${base}/sales`).set(bearer(seller));
    expect(sales.body.totals.netPaise).toBe(150000);

    // a paid course cannot be bought twice; orders are private
    expect(
      (await request(app).post('/api/marketplace/cart/items').set(bearer(buyer)).send({ courseId: id }))
        .status,
    ).toBe(409);
    expect((await request(app).get(`/api/marketplace/orders/${orderId}`).set(bearer(buyer2))).status).toBe(
      404,
    );
    expect(
      (await request(app).get(`/api/marketplace/orders/${orderId}`).set(bearer(buyer))).body.status,
    ).toBe('paid');
    await MktSettings.update({ commissionPercent: 30 }, { where: {} });

    // player: resume position, completion and progress
    const player = await request(app).get(`/api/marketplace/learning/${id}`).set(bearer(buyer));
    expect(player.status).toBe(200);
    const [video, article] = player.body.sections[0].lectures;
    const content = await request(app)
      .get(`/api/marketplace/learning/${id}/lectures/${video.id}`)
      .set(bearer(buyer));
    expect(content.body.stream.fileUrl).toBeTruthy();
    expect(
      (await request(app).get(`/api/marketplace/learning/${id}/lectures/${video.id}`).set(bearer(buyer2)))
        .status,
    ).toBe(200);
    const half = await request(app)
      .put(`/api/marketplace/learning/${id}/lectures/${video.id}/progress`)
      .set(bearer(buyer))
      .send({ positionSeconds: 40 });
    expect(half.body).toMatchObject({ completed: false, positionSeconds: 40, progressPercent: 0 });
    const nearly = await request(app)
      .put(`/api/marketplace/learning/${id}/lectures/${video.id}/progress`)
      .set(bearer(buyer))
      .send({ positionSeconds: 95 });
    expect(nearly.body).toMatchObject({ completed: true, progressPercent: 50 });
    await request(app)
      .put(`/api/marketplace/learning/${id}/lectures/${article.id}/progress`)
      .set(bearer(buyer))
      .send({ completed: true });
    const mine = await request(app).get('/api/marketplace/learning').set(bearer(buyer));
    const enrolment = mine.body.find((e: { course: { id: number } }) => e.course.id === id);
    expect(enrolment.progressPercent).toBe(100);
    expect(enrolment.lastLectureId).toBe(article.id);
  });

  it('enrols in free courses directly and keeps them out of the cart', async () => {
    const learner = await newAccount('Free Learner');
    const detail = await request(app).get(
      '/api/marketplace/public/courses/spoken-english-confidence-builder',
    );
    const id = detail.body.id as number;
    expect(
      (await request(app).post('/api/marketplace/cart/items').set(bearer(learner)).send({ courseId: id }))
        .status,
    ).toBe(400);
    expect(
      (await request(app).post(`/api/marketplace/courses/${id}/enrol`).set(bearer(learner))).status,
    ).toBe(201);
    const access = await request(app).get(`/api/marketplace/courses/${id}/access`).set(bearer(learner));
    expect(access.body.enrolled).toBe(true);
    const paid = await request(app).get('/api/marketplace/public/courses/python-for-absolute-beginners');
    expect(
      (await request(app).post(`/api/marketplace/courses/${paid.body.id}/enrol`).set(bearer(learner))).status,
    ).toBe(409);
  });

  it('a 100% coupon completes the order without the gateway', async () => {
    const code = `FREE${mobile()}`;
    await request(app)
      .post('/api/admin/marketplace/coupons')
      .set(bearer(admin))
      .send({ code, kind: 'percent', value: 100, maxUses: 1 });
    const learner = await newAccount('Coupon Learner');
    const paid = await request(app).get('/api/marketplace/public/courses/neet-biology-crash-course');
    const res = await request(app)
      .post('/api/marketplace/checkout')
      .set(bearer(learner))
      .send({ courseIds: [paid.body.id], couponCode: code });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'paid', payment: null, amountPaise: 0 });
    expect(
      (await request(app).get(`/api/marketplace/learning/${paid.body.id}`).set(bearer(learner))).status,
    ).toBe(200);
    // single-use coupon is used up
    const other = await newAccount('Late Learner');
    await request(app)
      .post('/api/marketplace/cart/items')
      .set(bearer(other))
      .send({ courseId: paid.body.id });
    const cart = await request(app).get(`/api/marketplace/cart?coupon=${code}`).set(bearer(other));
    expect(cart.body.discountPaise).toBe(0);
    expect(cart.body.couponMessage).toBeTruthy();
  });
});

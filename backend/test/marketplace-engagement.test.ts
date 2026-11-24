import request from 'supertest';
import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { NotificationMessage } from '../src/modules/notifications/models';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';

/** Reviews, Q&A and wishlist. Test mobiles start with 965. */
let seq = 0;
const mobile = () => `96522${String(seq++).padStart(5, '0')}`;
const VIDEO = Buffer.from('0000001866747970', 'hex');

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

async function upload(token: string, base: string, kind: 'video' | 'image', data: Buffer, mime: string) {
  const start = await request(app)
    .post(`${base}/media`)
    .set(bearer(token))
    .send({ kind, name: `x.${mime.split('/')[1]}`, mimeType: mime, sizeBytes: data.length });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  await request(app)
    .put(`${base}/media/${start.body.id}/content?offset=0`)
    .set(bearer(token))
    .set('content-type', 'application/octet-stream')
    .send(data);
  await processDueJobs();
  return start.body.id as number;
}

/** A published course of the seller behind `base`; returns its id, slug and first lecture id. */
async function publishedCourse(token: string, base: string, pricePaise: number) {
  const thumb = await upload(token, base, 'image', Buffer.from('\x89PNG fake'), 'image/png');
  const cats = await request(app).get('/api/marketplace/public/categories');
  const created = await request(app)
    .post(`${base}/courses`)
    .set(bearer(token))
    .send({
      title: `Engagement course ${mobile()}`,
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
  const sectionId = section.body.sections.at(-1).id as number;
  const video = await upload(token, base, 'video', VIDEO, 'video/mp4');
  const lecture = await request(app)
    .post(`${base}/courses/${id}/sections/${sectionId}/lectures`)
    .set(bearer(token))
    .send({ title: 'Welcome', type: 'video', mediaId: video, preview: true, durationSeconds: 100 });
  expect(lecture.status, JSON.stringify(lecture.body)).toBe(201);
  await request(app)
    .post(`${base}/courses/${id}/sections/${sectionId}/lectures`)
    .set(bearer(token))
    .send({ title: 'Read me', type: 'article', articleBody: 'Hello learners' });
  const submit = await request(app).post(`${base}/courses/${id}/submit`).set(bearer(token));
  expect(submit.status, JSON.stringify(submit.body)).toBe(200);
  const approved = await request(app)
    .post(`/api/admin/marketplace/courses/${id}/approve`)
    .set(bearer(admin))
    .send({});
  expect(approved.body.status).toBe('published');
  const lectureId = lecture.body.sections.at(-1).lectures[0].id as number;
  return { id, slug: approved.body.slug as string, lectureId };
}

async function instructor() {
  const token = await newAccount('Engaged Instructor');
  await request(app)
    .put('/api/marketplace/instructor-profile')
    .set(bearer(token))
    .send({ displayName: `Instructor ${mobile()}`, headline: 'Teaches things' });
  return token;
}

async function buy(token: string, courseId: number) {
  const checkout = await request(app)
    .post('/api/marketplace/checkout')
    .set(bearer(token))
    .send({ courseIds: [courseId] });
  expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
  if (checkout.body.payment)
    await request(app)
      .post(`/api/marketplace/orders/${checkout.body.orderId}/mock-complete`)
      .set(bearer(token))
      .send({ outcome: 'success' });
}

beforeAll(async () => {
  app = await getApp();
  admin = (await login(USERS.superAdmin)).accessToken;
});

describe('ratings and reviews', () => {
  it('lets enrolled learners review once, keeps the course rating in sync and supports replies and moderation', async () => {
    const teacher = await instructor();
    const course = await publishedCourse(teacher, '/api/marketplace/instructor', 49900);
    const [a, b, outsider] = [
      await newAccount('Asha Verma'),
      await newAccount('Bala K'),
      await newAccount('Out Sider'),
    ];
    await buy(a, course.id);
    await buy(b, course.id);

    const me = `/api/marketplace/courses/${course.id}/reviews/me`;
    expect((await request(app).get(me).set(bearer(outsider))).body.canReview).toBe(false);
    const denied = await request(app).put(me).set(bearer(outsider)).send({ rating: 5 });
    expect(denied.body.error.code).toBe('NOT_ENROLLED');
    expect((await request(app).put(me).set(bearer(a)).send({ rating: 6 })).status).toBe(422);

    expect(
      (await request(app).put(me).set(bearer(a)).send({ rating: 5, title: 'Great', body: 'Loved it' }))
        .status,
    ).toBe(200);
    // saving again edits the same review
    const edited = await request(app).put(me).set(bearer(a)).send({ rating: 4, title: 'Very good' });
    expect(edited.body.review).toMatchObject({ rating: 4, title: 'Very good', mine: true });
    await request(app).put(me).set(bearer(b)).send({ rating: 1, body: 'Not for me' });

    const pub = `/api/marketplace/public/courses/${course.slug}`;
    let detail = await request(app).get(pub);
    expect(detail.body).toMatchObject({ ratingAvg: 2.5, ratingCount: 2 });
    const list = await request(app).get(`${pub}/reviews?sort=highest`);
    expect(list.body.total).toBe(2);
    expect(list.body.summary.breakdown).toEqual([1, 0, 0, 1, 0]);
    expect(list.body.items[0]).toMatchObject({ rating: 4, authorName: 'Asha V.', mine: false });
    const cards = await request(app).get(
      `/api/marketplace/public/courses?q=${encodeURIComponent(detail.body.title)}`,
    );
    expect(cards.body.items[0]).toMatchObject({ ratingAvg: 2.5, ratingCount: 2 });

    // the seller replies; another seller cannot
    const inbox = await request(app)
      .get('/api/marketplace/instructor/reviews?unreplied=true')
      .set(bearer(teacher));
    expect(inbox.body.total).toBe(2);
    const reviewB = inbox.body.items.find((r: { rating: number }) => r.rating === 1);
    const reply = await request(app)
      .put(`/api/marketplace/instructor/reviews/${reviewB.id}/reply`)
      .set(bearer(teacher))
      .send({ body: 'Sorry to hear that, tell us more!' });
    expect(reply.body.reply.body).toBe('Sorry to hear that, tell us more!');
    const other = await instructor();
    expect(
      (
        await request(app)
          .put(`/api/marketplace/instructor/reviews/${reviewB.id}/reply`)
          .set(bearer(other))
          .send({ body: 'x' })
      ).status,
    ).toBe(404);

    // report → admin hides it → rating recomputed without it → restore
    expect(
      (
        await request(app)
          .post(`/api/marketplace/reviews/${reviewB.id}/report`)
          .set(bearer(b))
          .send({ reason: 'mine' })
      ).status,
    ).toBe(400);
    await request(app)
      .post(`/api/marketplace/reviews/${reviewB.id}/report`)
      .set(bearer(a))
      .send({ reason: 'Spam' });
    await request(app)
      .post(`/api/marketplace/reviews/${reviewB.id}/report`)
      .set(bearer(a))
      .send({ reason: 'Spam again' });
    const reported = await request(app)
      .get('/api/admin/marketplace/reviews?reported=true')
      .set(bearer(admin));
    const flagged = reported.body.items.find((r: { id: number }) => r.id === reviewB.id);
    expect(flagged).toMatchObject({ reportCount: 1, reports: [{ reason: 'Spam' }] });
    expect((await request(app).get('/api/admin/marketplace/reviews').set(bearer(a))).status).toBe(403);

    const hidden = await request(app)
      .post(`/api/admin/marketplace/reviews/${reviewB.id}/hide`)
      .set(bearer(admin))
      .send({ reason: 'Abusive' });
    expect(hidden.body.status).toBe('hidden');
    detail = await request(app).get(pub);
    expect(detail.body).toMatchObject({ ratingAvg: 4, ratingCount: 1 });
    expect((await request(app).get(`${pub}/reviews`)).body.total).toBe(1);

    await request(app).post(`/api/admin/marketplace/reviews/${reviewB.id}/unhide`).set(bearer(admin));
    expect((await request(app).get(pub)).body).toMatchObject({ ratingAvg: 2.5, ratingCount: 2 });

    expect((await request(app).delete(me).set(bearer(b))).status).toBe(204);
    expect((await request(app).get(pub)).body).toMatchObject({ ratingAvg: 4, ratingCount: 1 });
  });
});

describe('course Q&A', () => {
  it('lets enrolled learners ask and answer, the seller answer and mark answered', async () => {
    const teacher = await instructor();
    const course = await publishedCourse(teacher, '/api/marketplace/instructor', 0);
    const [asker, peer, outsider] = [
      await newAccount('Ravi Kumar'),
      await newAccount('Peer L'),
      await newAccount('No Enrol'),
    ];
    for (const t of [asker, peer])
      expect(
        (await request(app).post(`/api/marketplace/courses/${course.id}/enrol`).set(bearer(t))).status,
      ).toBe(201);

    const base = `/api/marketplace/courses/${course.id}/questions`;
    expect((await request(app).get(base).set(bearer(outsider))).body.error.code).toBe('NOT_ENROLLED');
    expect(
      (await request(app).post(base).set(bearer(asker)).send({ title: 'Bad', lectureId: 999999 })).status,
    ).toBe(404);
    const asked = await request(app)
      .post(base)
      .set(bearer(asker))
      .send({ title: 'How do I start?', body: 'Details', lectureId: course.lectureId });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ lectureTitle: 'Welcome', answered: false, mine: true, answers: [] });
    const qid = asked.body.id as number;

    const peerAnswer = await request(app)
      .post(`${base}/${qid}/answers`)
      .set(bearer(peer))
      .send({ body: 'Watch lecture 1' });
    expect(peerAnswer.body.answers[0]).toMatchObject({ isInstructor: false, authorName: 'Peer L.' });
    expect(
      (await request(app).put(`${base}/${qid}/answered`).set(bearer(peer)).send({ answered: true })).status,
    ).toBe(403);

    const studio = await request(app)
      .get('/api/marketplace/instructor/questions?filter=unanswered')
      .set(bearer(teacher));
    expect(studio.body.items.map((q: { id: number }) => q.id)).toContain(qid);
    const answered = await request(app)
      .post(`/api/marketplace/instructor/questions/${qid}/answers`)
      .set(bearer(teacher))
      .send({ body: 'Start with the intro.' });
    expect(answered.body.answerCount).toBe(2);
    expect(answered.body.answers[1].isInstructor).toBe(true);
    expect(answered.body.course.id).toBe(course.id);
    await request(app).put(`${base}/${qid}/answered`).set(bearer(asker)).send({ answered: true });

    const lectureQs = await request(app)
      .get(`${base}?lectureId=${course.lectureId}&filter=mine`)
      .set(bearer(asker));
    expect(lectureQs.body.items).toEqual([
      expect.objectContaining({ id: qid, answered: true, answerCount: 2 }),
    ]);
    expect((await request(app).get(`${base}?filter=unanswered`).set(bearer(peer))).body.total).toBe(0);
    expect((await request(app).get(`${base}?q=start`).set(bearer(peer))).body.total).toBe(1);
    expect((await request(app).delete(`${base}/${qid}`).set(bearer(peer))).status).toBe(403);
  });

  it('notifies the institute course author in-app about a new question', async () => {
    const author = (await login(USERS.apexBranchAdmin)).accessToken;
    const course = await publishedCourse(author, '/api/marketplace/institute', 0);
    const learner = await newAccount('Curious Learner');
    await request(app).post(`/api/marketplace/courses/${course.id}/enrol`).set(bearer(learner));
    const asked = await request(app)
      .post(`/api/marketplace/courses/${course.id}/questions`)
      .set(bearer(learner))
      .send({ title: 'Is there a doubt session?' });
    expect(asked.status).toBe(201);
    const msg = await NotificationMessage.findOne({
      where: { eventKey: 'marketplace.question.asked', channel: 'in_app' },
      order: [['id', 'DESC']],
      tenantBypass: true,
    } as object);
    expect(msg?.instituteId).toBe(1);
    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(author));
    expect(JSON.stringify(inbox.body)).toContain('Is there a doubt session?');
  });
});

describe('wishlist', () => {
  it('saves courses, lists them and moves paid ones to the cart', async () => {
    const teacher = await instructor();
    const course = await publishedCourse(teacher, '/api/marketplace/instructor', 19900);
    const learner = await newAccount('Wish Lister');
    expect((await request(app).get('/api/marketplace/wishlist')).status).toBe(401);
    const added = await request(app)
      .post('/api/marketplace/wishlist')
      .set(bearer(learner))
      .send({ courseId: course.id });
    expect(added.body.courseIds).toEqual([course.id]);
    await request(app).post('/api/marketplace/wishlist').set(bearer(learner)).send({ courseId: course.id });
    expect(
      (await request(app).post('/api/marketplace/wishlist').set(bearer(learner)).send({ courseId: 99999999 }))
        .status,
    ).toBe(404);
    const list = await request(app).get('/api/marketplace/wishlist').set(bearer(learner));
    expect(list.body.items.map((c: { id: number }) => c.id)).toEqual([course.id]);

    const cart = await request(app)
      .post(`/api/marketplace/wishlist/${course.id}/move-to-cart`)
      .set(bearer(learner));
    expect(cart.body.items.map((i: { course: { id: number } }) => i.course.id)).toEqual([course.id]);
    expect(
      (await request(app).get('/api/marketplace/wishlist/ids').set(bearer(learner))).body.courseIds,
    ).toEqual([]);

    await request(app).post('/api/marketplace/wishlist').set(bearer(learner)).send({ courseId: course.id });
    const removed = await request(app).delete(`/api/marketplace/wishlist/${course.id}`).set(bearer(learner));
    expect(removed.body.courseIds).toEqual([]);
  });

  it('seeds demo reviews that drive the course rating', async () => {
    const detail = await request(app).get('/api/marketplace/public/courses/python-for-absolute-beginners');
    expect(detail.body).toMatchObject({ ratingAvg: 4.5, ratingCount: 4 });
    const reviews = await request(app).get(
      '/api/marketplace/public/courses/python-for-absolute-beginners/reviews',
    );
    expect(reviews.body.items.some((r: { reply: unknown }) => r.reply)).toBe(true);
  });
});

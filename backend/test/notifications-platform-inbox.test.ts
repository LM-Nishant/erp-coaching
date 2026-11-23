import request from 'supertest';
import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/infrastructure/crypto';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';
import {
  notifyMarketplaceUsers,
  QUESTION_ANSWERED_EVENT,
} from '../src/modules/marketplace/engagement.notifications';
import type { MktSeller } from '../src/modules/marketplace/models';
import { notifyPayoutPaid } from '../src/modules/marketplace/payouts.notify';
import { PushToken } from '../src/modules/notifications/models';
import { PlatformMessage, PlatformPushToken } from '../src/modules/notifications/platform-inbox.models';
import { User } from '../src/modules/users/user.model';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';

/** Personal (no-institute) inbox. Test mobiles start with 96733. */
let seq = 0;
const mobile = () => `96733${String(seq++).padStart(5, '0')}`;

let app: Express;

async function newAccount(name: string) {
  const m = mobile();
  const res = await request(app)
    .post('/api/marketplace/public/signup')
    .send({ name, mobile: m, password: DEMO_PASSWORD });
  expect(res.status).toBe(201);
  const user = await User.findOne({ where: { mobile: m } });
  return { id: user!.id, token: (await login({ mobile: m, password: DEMO_PASSWORD })).accessToken };
}

const inbox = (token: string) => request(app).get('/api/notifications/personal/inbox').set(bearer(token));

beforeAll(async () => {
  app = await getApp();
});

describe('personal inbox for users without an institute', () => {
  it('delivers marketplace Q&A notices to no-institute users and keeps institute users on notify()', async () => {
    const learner = await newAccount('Inbox Learner');
    const teacher = await User.findOne({ where: { mobile: USERS.apexTeacher.mobile } });
    const delivered = await notifyMarketplaceUsers({
      event: QUESTION_ANSWERED_EVENT,
      userIds: [learner.id, teacher!.id],
      data: { course: 'Python 101', title: 'Which IDE?', author: 'Riya' },
    });
    expect(delivered).toBeGreaterThanOrEqual(2);

    const mine = await inbox(learner.token);
    expect(mine.status).toBe(200);
    expect(mine.body.unread).toBe(1);
    expect(mine.body.items[0]).toMatchObject({
      eventKey: QUESTION_ANSWERED_EVENT,
      title: 'New answer on Python 101',
      body: 'Riya answered your question "Which IDE?"',
      readAt: null,
    });
    // The institute member got it in the institute inbox, not a personal one.
    expect(await PlatformMessage.count({ where: { userId: teacher!.id } })).toBe(0);
  });

  it('tells an independent instructor their payout was sent', async () => {
    const instructor = await newAccount('Inbox Instructor');
    const seller = { id: 999999, ownerInstituteId: null, userId: instructor.id, displayName: 'Solo' };
    const sent = await notifyPayoutPaid(seller as unknown as MktSeller, {
      netPaise: 123450,
      period: 'Oct 2026',
      reference: 'UTR123',
      paidTo: 'UPI solo@upi',
    });
    expect(sent).toBe(true);
    const mine = await inbox(instructor.token);
    expect(mine.body.items[0].title).toBe('Payout of ₹1,234.50 sent');
    expect(mine.body.items[0].body).toContain('Reference: UTR123');
  });

  it('marks items read, counts unread and hides other users’ items', async () => {
    const a = await newAccount('Reader A');
    const b = await newAccount('Reader B');
    for (const title of ['One', 'Two'])
      await notifyMarketplaceUsers({
        event: QUESTION_ANSWERED_EVENT,
        userIds: [a.id],
        data: { course: 'C', title, author: 'X' },
      });
    const list = await inbox(a.token);
    expect(list.body.total).toBe(2);
    const [first] = list.body.items;

    expect(
      (await request(app).post(`/api/notifications/personal/inbox/${first.id}/read`).set(bearer(b.token)))
        .status,
    ).toBe(404);
    expect((await inbox(b.token)).body.total).toBe(0);

    const read = await request(app)
      .post(`/api/notifications/personal/inbox/${first.id}/read`)
      .set(bearer(a.token));
    expect(read.body.readAt).not.toBeNull();
    const count = await request(app)
      .get('/api/notifications/personal/inbox/unread-count')
      .set(bearer(a.token));
    expect(count.body.unread).toBe(1);
    const all = await request(app).post('/api/notifications/personal/inbox/read-all').set(bearer(a.token));
    expect(all.body.updated).toBe(1);
    expect((await inbox(a.token)).body.unread).toBe(0);
    expect((await request(app).get('/api/notifications/personal/inbox')).status).toBe(401);
  });

  it('pushes to the user’s registered devices and hands a device token over between accounts', async () => {
    const learner = await newAccount('Push Learner');
    const token = `web-mock-personal-${mobile()}`;
    const reg = await request(app)
      .post('/api/notifications/personal/push-tokens')
      .set(bearer(learner.token))
      .send({ token, platform: 'web', deviceUid: 'dev-1' });
    expect(reg.status).toBe(201);

    await notifyMarketplaceUsers({
      event: QUESTION_ANSWERED_EVENT,
      userIds: [learner.id],
      data: { course: 'Pushy', title: 'Ping?', author: 'Pong' },
    });
    await processDueJobs();
    expect(consoleOutbox.filter((m) => m.channel === 'push' && m.to === token).map((m) => m.body)).toEqual([
      'Pong answered your question "Ping?"',
    ]);

    // An institute account signing in on the same device takes the token over.
    const teacher = (await login(USERS.apexTeacher)).accessToken;
    const inst = await request(app)
      .post('/api/notifications/push-tokens')
      .set(bearer(teacher))
      .send({ token, platform: 'web' });
    expect(inst.status).toBe(201);
    expect(await PlatformPushToken.count({ where: { tokenHash: sha256(token) } })).toBe(0);

    // ...and back again.
    await request(app)
      .post('/api/notifications/personal/push-tokens')
      .set(bearer(learner.token))
      .send({ token, platform: 'web' });
    const institutional = await PushToken.count({
      where: { tokenHash: sha256(token) },
      tenantBypass: true,
    } as Parameters<typeof PushToken.count>[0]);
    expect(institutional).toBe(0);

    const removed = await request(app)
      .delete('/api/notifications/personal/push-tokens')
      .set(bearer(learner.token))
      .send({ token });
    expect(removed.status).toBe(204);
    expect(await PlatformPushToken.count({ where: { userId: learner.id } })).toBe(0);
  });
});

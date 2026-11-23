/**
 * Course marketplace (wave 2): wishlist → buy → Q&A with the instructor → rating and review.
 *
 * Setup (API): an independent instructor publishes a ₹499 course; a first learner buys it and leaves a 4-star
 * review.
 * Browser: a second learner sees that review on the landing page, saves the course to their wishlist, moves it to the
 * cart from the Wishlist page and pays with the mock gateway. In the player they ask a question; the instructor
 * answers it from the studio's "Q&A and reviews" page and the learner reads the answer. Finally the learner rates the
 * course 5 stars, which moves the course rating from 4.0 to 4.5.
 */
import { expect, test } from '../support/fixtures';
import { Api, loginWithPassword, newDevice, type Session } from '../support/api';
import { API_URL } from '../support/env';
import { PASSWORD, uniqueId } from '../support/data';
import { activePage, expectToast } from '../support/ui';

let lastMobile = 0;
/** Test mobiles in the 965… range used by this spec. */
function marketMobile(): string {
  lastMobile = Math.max(lastMobile + 1, Math.floor(Date.now() / 100));
  return `965${String(lastMobile % 10_000_000).padStart(7, '0')}`;
}

async function signUp(http: Session['api']['http'], name: string, label: string): Promise<Session> {
  const mobile = marketMobile();
  await new Api(http).post('/marketplace/public/signup', { name, mobile, password: PASSWORD });
  return loginWithPassword(http, { mobile, password: PASSWORD }, newDevice(label));
}

async function buy(learner: Session, courseId: number) {
  const checkout = await learner.api.post<{ orderId: number; payment: unknown }>('/marketplace/checkout', {
    courseIds: [courseId],
  });
  if (checkout.payment)
    await learner.api.post(`/marketplace/orders/${checkout.orderId}/mock-complete`, { outcome: 'success' });
}

test('wishlist → buy → ask the instructor → rate the course', async ({ http, superAdmin, openAs }) => {
  const tag = uniqueId();
  const title = `Pottery at home ${tag}`;
  const base = '/marketplace/instructor';

  const instructor = await signUp(http, 'Ira Potter', 'instructor');
  const course = await test.step('an instructor publishes a paid course', async () => {
    const { api } = instructor;
    await api.put('/marketplace/instructor-profile', {
      displayName: `Ira Potter ${tag}`,
      headline: 'Studio potter',
    });
    const categories = await superAdmin.api.post<{ id: number; name: string }[]>(
      '/admin/marketplace/categories',
      { name: `Crafts ${tag}` },
    );
    const category = categories.find((c) => c.name === `Crafts ${tag}`)!;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const image = await api.post<{ id: number }>(`${base}/media`, {
      kind: 'image',
      name: 'cover.png',
      mimeType: 'image/png',
      sizeBytes: png.length,
    });
    const put = await http.fetch(`${API_URL}/api${base}/media/${image.id}/content?offset=0`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${instructor.accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      data: png,
    });
    expect(put.ok(), await put.text()).toBe(true);
    await expect
      .poll(async () => (await api.get<{ status: string }>(`${base}/media/${image.id}`)).status)
      .toBe('ready');

    const created = await api.post<{ id: number }>(`${base}/courses`, {
      title,
      subtitle: 'Hand-built pots without a wheel',
      description: 'Pinch, coil and slab techniques for beginners, with tools you already have at home.',
      categoryId: category.id,
      pricePaise: 49_900,
      outcomes: ['Make a pinch pot', 'Build a coil vase'],
      thumbnailMediaId: image.id,
    });
    const withSection = await api.post<{ sections: { id: number }[] }>(
      `${base}/courses/${created.id}/sections`,
      { title: 'Clay basics' },
    );
    const sectionId = withSection.sections.at(-1)!.id;
    await api.post(`${base}/courses/${created.id}/sections/${sectionId}/lectures`, {
      title: 'Wedging the clay',
      type: 'article',
      articleBody: 'Knead the clay to push out air bubbles.',
      preview: true,
    });
    await api.post(`${base}/courses/${created.id}/sections/${sectionId}/lectures`, {
      title: 'Your first pinch pot',
      type: 'article',
      articleBody: 'Press your thumb into a ball of clay.',
    });
    await api.post(`${base}/courses/${created.id}/submit`);
    const approved = await superAdmin.api.post<{ status: string; slug: string }>(
      `/admin/marketplace/courses/${created.id}/approve`,
      {},
    );
    expect(approved.status).toBe('published');
    return { id: created.id, slug: approved.slug };
  });

  await test.step('a first learner buys it and leaves a 4-star review', async () => {
    const peer = await signUp(http, 'Nila Peer', 'peer');
    await buy(peer, course.id);
    await peer.api.put(`/marketplace/courses/${course.id}/reviews/me`, {
      rating: 4,
      title: 'Calm and clear',
      body: 'Short lessons that are easy to follow.',
    });
  });

  const learner = await signUp(http, 'Ravi Learner', 'learner');
  const page = await openAs(learner, `/market/course/${course.slug}`);

  await test.step('the landing page shows the review; the learner wishlists the course', async () => {
    const landing = activePage(page);
    const reviews = landing.getByTestId('reviews-section');
    await expect(reviews.getByTestId('rating-avg')).toHaveText('4.0');
    await expect(reviews.getByText('Calm and clear')).toBeVisible();
    await expect(reviews.getByText('Nila P.')).toBeVisible();
    // Not enrolled: no review form yet.
    await expect(reviews.getByTestId('my-review')).toHaveCount(0);

    const wish = landing.getByTestId(`wishlist-${course.id}`).last();
    await expect(wish).toContainText('Add to wishlist');
    await wish.click();
    await expect(wish).toContainText('Wishlisted');
  });

  await test.step('from the Wishlist page they move it to the cart and pay', async () => {
    await page.goto('/market/wishlist');
    const wishlist = activePage(page);
    await expect(wishlist.getByTestId(`wish-${course.slug}`)).toContainText(title);
    await wishlist.getByTestId(`move-to-cart-${course.slug}`).click();
    await expectToast(page, 'Moved to cart');
    await expect(wishlist.getByTestId(`wish-${course.slug}`)).toHaveCount(0);

    await page.goto('/market/cart');
    const cart = activePage(page);
    await expect(cart.getByTestId('cart-total')).toContainText('499');
    await cart.getByTestId('checkout').click();
    await expect(page).toHaveURL(/\/market\/orders\/\d+/);
    await activePage(page).getByTestId('mock-pay').click();
    await expect(activePage(page).getByTestId('order-paid')).toBeVisible();
  });

  const question = 'Which clay should I buy?';
  const questionId = await test.step('in the player they ask a question about the lecture', async () => {
    await page.goto(`/market/learn/${course.id}`);
    const player = activePage(page);
    await expect(player.getByTestId('lecture-title')).toHaveText('Wedging the clay');
    const qa = player.getByTestId('qa-panel');
    await qa.getByTestId('qa-ask').click();
    await qa.getByTestId('qa-ask-title').locator('input').fill(question);
    await qa.getByTestId('qa-ask-body').locator('textarea').fill('Air-dry or kiln clay?');
    await qa.getByTestId('qa-ask-send').click();
    await expect(qa.getByTestId('qa-question-title')).toHaveText(question);

    const asked = await instructor.api.get<{ items: { id: number; title: string; lectureTitle: string }[] }>(
      `${base}/questions?courseId=${course.id}`,
    );
    const found = asked.items.find((q) => q.title === question)!;
    expect(found.lectureTitle).toBe('Wedging the clay');
    return found.id;
  });

  const answer = 'Start with air-dry clay; no kiln needed.';
  await test.step('the instructor answers from the studio', async () => {
    const studio = await openAs(instructor, '/market/studio/instructor');
    await activePage(studio).getByTestId('studio-engagement').click();
    await expect(studio).toHaveURL(/\/market\/studio\/instructor\/engagement/);
    const card = activePage(studio).getByTestId(`studio-question-${questionId}`);
    await expect(card).toContainText(question);
    await card.getByTestId(`studio-answer-${questionId}`).locator('textarea').fill(answer);
    await card.getByTestId(`studio-answer-send-${questionId}`).click();
    await expect(card).toContainText(answer);
  });

  await test.step('the learner reads the answer and marks the question answered', async () => {
    await page.goto(`/market/learn/${course.id}?questionId=${questionId}`);
    const qa = activePage(page).getByTestId('qa-panel');
    await expect(qa.getByTestId('qa-question-title')).toHaveText(question);
    await expect(qa.getByText(answer)).toBeVisible();
    await qa.getByTestId('qa-toggle-answered').click();
    await expect
      .poll(
        async () =>
          (
            await learner.api.get<{ answered: boolean }>(
              `/marketplace/courses/${course.id}/questions/${questionId}`,
            )
          ).answered,
      )
      .toBe(true);
  });

  await test.step('they rate the course 5 stars; the average becomes 4.5', async () => {
    await page.goto(`/market/course/${course.slug}#reviews`);
    const reviews = activePage(page).getByTestId('reviews-section');
    await reviews.getByTestId('rate-5').click();
    await reviews.getByTestId('review-body').locator('textarea').fill('Loved the pinch pot lesson.');
    await reviews.getByTestId('save-review').click();
    await expect(reviews.getByTestId('rating-avg')).toHaveText('4.5');
    await expect(reviews.getByText('Loved the pinch pot lesson.').first()).toBeVisible();
    await expect(reviews.getByTestId('edit-review')).toBeVisible();
  });
});

/**
 * Course marketplace (wave 1): browse → buy → watch.
 *
 * Setup (API): an independent instructor signs up, builds a ₹499 course (image, two article lectures, one a free
 * preview) and submits it; the platform admin approves it, which publishes it on the shared marketplace.
 * Browser: a visitor finds the course by search, reads the free preview, is asked to sign in when buying, creates
 * a learner account (no institute), pays with the mock gateway and studies the course: the player opens the first
 * lecture, marking lectures complete moves the course progress to 100%.
 */
import { expect, test } from '../support/fixtures';
import { Api, loginWithPassword, newDevice } from '../support/api';
import { API_URL } from '../support/env';
import { waitForOtp, outboxMark } from '../support/outbox';
import { PASSWORD, uniqueId } from '../support/data';
import { activePage } from '../support/ui';

let lastMobile = 0;
/** Test mobiles in the 964… range used by the marketplace specs. */
function marketMobile(): string {
  lastMobile = Math.max(lastMobile + 1, Math.floor(Date.now() / 100));
  return `964${String(lastMobile % 10_000_000).padStart(7, '0')}`;
}

interface Media {
  id: number;
  status: string;
}

test('browse → buy with the mock gateway → watch and complete the course', async ({
  http,
  superAdmin,
  page,
}) => {
  const tag = uniqueId();
  const title = `Watercolour basics ${tag}`;
  const base = '/marketplace/instructor';

  const courseId = await test.step('an instructor publishes a paid course', async () => {
    const mobile = marketMobile();
    await new Api(http).post('/marketplace/public/signup', {
      name: 'Meera Painter',
      mobile,
      password: PASSWORD,
    });
    const instructor = await loginWithPassword(http, { mobile, password: PASSWORD }, newDevice('instructor'));
    const { api } = instructor;
    await api.put('/marketplace/instructor-profile', {
      displayName: `Meera Painter ${tag}`,
      headline: 'Painter and teacher',
    });
    const categories = await superAdmin.api.post<{ id: number; name: string }[]>(
      '/admin/marketplace/categories',
      {
        name: `Art ${tag}`,
      },
    );
    const category = categories.find((c) => c.name === `Art ${tag}`)!;

    // Course image: start an upload, send the bytes, wait until it is ready.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const started = await api.post<Media>(`${base}/media`, {
      kind: 'image',
      name: 'cover.png',
      mimeType: 'image/png',
      sizeBytes: png.length,
    });
    const put = await http.fetch(`${API_URL}/api${base}/media/${started.id}/content?offset=0`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${instructor.accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      data: png,
    });
    expect(put.ok(), await put.text()).toBe(true);
    await expect.poll(async () => (await api.get<Media>(`${base}/media/${started.id}`)).status).toBe('ready');

    const course = await api.post<{ id: number }>(`${base}/courses`, {
      title,
      subtitle: 'Paint loose, bright landscapes',
      description:
        'Learn washes, layering and colour mixing step by step, with short lessons you can follow at home.',
      categoryId: category.id,
      pricePaise: 49_900,
      outcomes: ['Mix clean colours', 'Paint a simple landscape'],
      thumbnailMediaId: started.id,
    });
    const withSection = await api.post<{ sections: { id: number }[] }>(
      `${base}/courses/${course.id}/sections`,
      {
        title: 'Getting started',
      },
    );
    const sectionId = withSection.sections.at(-1)!.id;
    await api.post(`${base}/courses/${course.id}/sections/${sectionId}/lectures`, {
      title: 'Your paint box',
      type: 'article',
      articleBody: 'Three primaries are enough to start.',
      preview: true,
    });
    await api.post(`${base}/courses/${course.id}/sections/${sectionId}/lectures`, {
      title: 'First wash',
      type: 'article',
      articleBody: 'Wet the paper, then load the brush.',
    });
    await api.post(`${base}/courses/${course.id}/submit`);
    const approved = await superAdmin.api.post<{ status: string }>(
      `/admin/marketplace/courses/${course.id}/approve`,
      {},
    );
    expect(approved.status).toBe('published');
    return course.id;
  });

  await test.step('a visitor finds the course and reads the free preview', async () => {
    await page.goto('/market');
    await activePage(page).getByRole('searchbox').first().fill(tag);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/market\/search/);
    await activePage(page).getByText(title).first().click();
    await expect(page).toHaveURL(/\/market\/course\//);
    const landing = activePage(page);
    await expect(landing.getByTestId('course-price')).toContainText('₹499');
    await landing.getByText('Your paint box').click();
    await expect(page.getByText('Three primaries are enough to start.')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  const mobile = marketMobile();
  await test.step('buying asks the visitor to sign in; they create a learner account', async () => {
    await activePage(page).getByTestId('buy-now').click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByRole('link', { name: 'Create a learner account' }).click();
    await expect(page).toHaveURL(/\/market\/signup/);
    const signup = activePage(page);
    await signup.getByTestId('signup-name').locator('input').fill('Kabir Learner');
    await signup.getByTestId('signup-mobile').locator('input').fill(mobile);
    await signup.getByTestId('signup-password').locator('input').fill(PASSWORD);
    const since = outboxMark();
    await signup.getByTestId('signup-submit').click();
    // A first sign-in on a new device may ask for the code sent to the mobile.
    await page.waitForURL(/\/(otp|market\/course)/);
    if (page.url().includes('/otp')) {
      await page.getByLabel('OTP').fill(await waitForOtp(mobile, since));
      await page.getByRole('button', { name: 'Verify' }).click();
    }
    await expect(page).toHaveURL(/\/market\/course\//);
  });

  await test.step('they pay with the mock gateway', async () => {
    await activePage(page).getByTestId('buy-now').click();
    await expect(page).toHaveURL(/\/market\/cart/);
    const cart = activePage(page);
    await expect(cart.getByTestId('cart-total')).toContainText('499');
    await cart.getByTestId('checkout').click();
    await expect(page).toHaveURL(/\/market\/orders\/\d+/);
    await activePage(page).getByTestId('mock-pay').click();
    await expect(activePage(page).getByTestId('order-paid')).toBeVisible();
    await activePage(page).getByText('Start learning').click();
    await expect(page).toHaveURL(/\/market\/learning/);
  });

  await test.step('they watch the course and complete it', async () => {
    await activePage(page).getByText(title).first().click();
    await expect(page).toHaveURL(new RegExp(`/market/learn/${courseId}`));
    const player = activePage(page);
    await expect(player.getByTestId('lecture-title')).toHaveText('Your paint box');
    await expect(player.getByTestId('lecture-article')).toContainText('Three primaries');
    await player.getByTestId('mark-complete').click();
    await expect(player.getByTestId('course-progress')).toContainText('50%');
    await player.getByText('First wash').first().click();
    await expect(player.getByTestId('lecture-title')).toHaveText('First wash');
    await player.getByTestId('mark-complete').click();
    await expect(player.getByTestId('course-progress')).toContainText('100%');
  });
});

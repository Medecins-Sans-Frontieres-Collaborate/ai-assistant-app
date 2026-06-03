import { expect, test } from '@playwright/test';

/**
 * With the out-of-band-minted session cookie (the default storage state), the
 * authenticated chat page loads and the message composer is visible. Loading
 * the page renders the client Chat component but fires no paid calls — chat
 * only calls /api/chat on send, which this test does not do.
 */
test('authenticated user lands on the chat page with a visible composer', async ({
  page,
}) => {
  await page.goto('/');

  // Not bounced to sign-in.
  await expect(page).not.toHaveURL(/\/signin/);

  // The message composer textarea is present (locale-independent selector).
  await expect(page.getByTestId('chat-input')).toBeVisible();
});

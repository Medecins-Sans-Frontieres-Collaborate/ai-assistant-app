import { expect, test } from '@playwright/test';

/**
 * EU users must accept terms before using the app. This captures that full
 * flow: the terms modal gates the page on first load, and only after accepting
 * is the chat composer actually usable.
 *
 * Uses the default (EU) storage state from the Playwright config. No paid calls:
 * /api/terms is served locally and no message is ever sent.
 */
test('EU user must accept terms before the composer is usable', async ({
  page,
}) => {
  await page.goto('/');

  // Terms modal gates the authenticated page.
  await expect(page.getByTestId('terms-modal')).toBeVisible();

  // Accept the terms.
  await page.getByTestId('terms-accept-button').click();

  // Modal is dismissed...
  await expect(page.getByTestId('terms-modal')).toHaveCount(0);

  // ...and the composer is now genuinely interactive (would fail if still
  // covered by the overlay).
  const composer = page.getByTestId('chat-input');
  await composer.fill('hello after terms');
  await expect(composer).toHaveValue('hello after terms');
});

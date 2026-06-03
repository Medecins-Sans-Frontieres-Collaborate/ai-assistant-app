import { E2E_STORAGE_STATE_US } from './constants';

import { expect, test } from '@playwright/test';

/**
 * A US user is exempt from the terms-acceptance gate, so the chat composer must
 * be usable on first load. We assert *actionability*, not mere visibility: a
 * terms (or any) modal overlaying the composer would make `fill()` fail, so
 * typing into it and reading the value back proves it is genuinely interactive.
 *
 * No paid calls: loading the page and typing never hits /api/chat (which only
 * fires on send).
 */
test.use({ storageState: E2E_STORAGE_STATE_US });

test('US user lands on the chat page with an immediately usable composer', async ({
  page,
}) => {
  await page.goto('/');

  // Not bounced to sign-in.
  await expect(page).not.toHaveURL(/\/signin/);

  // No terms gate for US users.
  await expect(page.getByTestId('terms-modal')).toHaveCount(0);

  // The composer is actionable (not just present / not covered by an overlay).
  const composer = page.getByTestId('chat-input');
  await composer.fill('hello from e2e');
  await expect(composer).toHaveValue('hello from e2e');
});

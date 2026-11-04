import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { NextIntlClientProvider } from 'next-intl';

import { PermissionCacheControls } from '@/components/Admin/GlobalAdmins/PermissionCacheControls';

import arabic from '@/messages/ar.json';
import german from '@/messages/de.json';
import english from '@/messages/en.json';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise actual translations rather than the global key-echo fixture.
vi.unmock('next-intl');

afterEach(() => vi.unstubAllGlobals());

describe('permission refresh controls', () => {
  it.each([
    ['en', english],
    ['de', german],
    ['ar', arabic],
  ] as const)('renders labeled controls in %s', (locale, messages) => {
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <PermissionCacheControls />
      </NextIntlClientProvider>,
    );
    expect(
      screen.getByRole('heading', { name: messages.permissionCache.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: messages.permissionCache.userId }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: messages.permissionCache.refreshUser,
      }),
    ).toBeDisabled();
  });

  it('requires a valid object ID and shows invalidated, not rechecked, after success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { status: 'invalidated', freshVerificationRequired: true },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <NextIntlClientProvider locale="en" messages={english}>
        <PermissionCacheControls />
      </NextIntlClientProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: english.permissionCache.refreshUser }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        english.permissionCache.invalidated,
      ),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      scope: 'user',
      userId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('requires explicit confirmation for everyone and surfaces request failures inline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ success: false }),
      }),
    );
    render(
      <NextIntlClientProvider locale="en" messages={english}>
        <PermissionCacheControls />
      </NextIntlClientProvider>,
    );
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'all' },
    });
    expect(
      screen.getByRole('button', { name: english.permissionCache.refreshAll }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(
      screen.getByRole('button', { name: english.permissionCache.refreshAll }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        english.permissionCache.failed,
      ),
    );
  });
});

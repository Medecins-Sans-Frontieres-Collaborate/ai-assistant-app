import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { EffectiveLimitsPreview } from '@/components/Limits/EffectiveLimitsPreview';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract (design §6c, app/api/limits/me/route.ts): a scoped admin's
 * out-of-scope preview is refused with
 *
 *   403 { error, details: 'undecidable' | 'outside', code: 'LIMITS_PREVIEW_OUT_OF_SCOPE' }
 *
 * and a caller who is no longer a scoped admin gets the plain
 * `403 { error, code: 'FORBIDDEN' }`. This file drives the REAL
 * `useEffectiveLimitsPreview` against those exact bodies, so it pins both
 * halves of the fix: the hook must surface `details`, and the component must
 * word each verdict differently. The sibling EffectiveLimitsPreview.test.tsx
 * mocks the hook and cannot catch the hook dropping `details` on the floor.
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

let body: unknown;

function installFetch(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

function renderScoped() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EffectiveLimitsPreview overrides={[]} dirty={false} scoped />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText('previewEmailLabel'), {
    target: { value: 'bob@paris.msf.org' },
  });
  fireEvent.click(screen.getByRole('button', { name: /previewRun/ }));
}

describe('EffectiveLimitsPreview — scoped 403 bodies through the real hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("undecidable: mixed jurisdiction → 'cannot be decided', not 'outside your scope'", async () => {
    body = {
      error:
        'Your delegation is anchored on groups or attributes; previews by mail are not possible',
      details: 'undecidable',
      code: 'LIMITS_PREVIEW_OUT_OF_SCOPE',
    };
    installFetch(403);
    renderScoped();

    expect(
      await screen.findByText('previewUndecidableScope'),
    ).toBeInTheDocument();
    expect(screen.queryByText('previewOutOfScope')).not.toBeInTheDocument();
  });

  it("outside: provably outside → 'outside your scope'", async () => {
    body = {
      error: 'This person is outside your scope',
      details: 'outside',
      code: 'LIMITS_PREVIEW_OUT_OF_SCOPE',
    };
    installFetch(403);
    renderScoped();

    expect(await screen.findByText('previewOutOfScope')).toBeInTheDocument();
    expect(
      screen.queryByText('previewUndecidableScope'),
    ).not.toBeInTheDocument();
  });

  it("plain FORBIDDEN: no longer a scoped admin → 'no longer an admin', never 'outside'", async () => {
    body = { error: 'Access denied', code: 'FORBIDDEN' };
    installFetch(403);
    renderScoped();

    expect(await screen.findByText('previewNoLongerAdmin')).toBeInTheDocument();
    expect(screen.queryByText('previewOutOfScope')).not.toBeInTheDocument();
    expect(screen.queryByText('previewForbidden')).not.toBeInTheDocument();
  });
});

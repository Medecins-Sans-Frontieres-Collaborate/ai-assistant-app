// ───────────────────────────────────────────────────────────────────
// ChatInputDocumentTranslate — translation route pre-flight
// (docs/LIMITS_USER_FACING_UX.md §7.4). At `feature.translation.jobsPerDay`
// 0 remaining the Translate action is disabled with the reason; every
// other state renders the modal exactly as before.
// ───────────────────────────────────────────────────────────────────
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { FeatureRemaining } from '@/client/hooks/settings/useMyLimits';

import ChatInputDocumentTranslate from '@/components/Chat/ChatInput/ChatInputDocumentTranslate';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const budgets: Record<string, FeatureRemaining | undefined> = {};
const refetch = vi.fn();
let countdown: string | null = null;

vi.mock('@/client/hooks/settings/useMyLimits', () => ({
  useLimitGates: () => ({
    isFeatureBlocked: () => false,
    featureRemaining: (key: string) => budgets[key],
    enforce: true,
  }),
  useMyLimits: () => ({ refetch, limits: [], models: {}, enforce: true }),
  useResetCountdown: (resetAt?: string) => (resetAt ? countdown : null),
}));

// The picker pulls in the M365 query stack; it is irrelevant here.
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  default: () => null,
}));

// Render the modal inline so the footer button is queryable without a portal.
vi.mock('@/components/UI/Modal', () => ({
  default: ({
    isOpen,
    children,
    footer,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    isOpen ? (
      <div data-testid="modal">
        {children}
        <div data-testid="modal-footer">{footer}</div>
      </div>
    ) : null,
}));

const fetchMock = vi.fn();

function renderModal() {
  const file = new File(['hello'], 'brief.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  return render(
    <ChatInputDocumentTranslate
      isOpen
      onClose={vi.fn()}
      documentFile={file}
      onTranslationComplete={vi.fn()}
    />,
  );
}

/** Pick a target language so the only remaining disable reason is the budget. */
function chooseTargetLanguage() {
  const input = screen.getByPlaceholderText(
    'documentTranslation.searchLanguage',
  ) as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: 'French' } });
  fireEvent.click(screen.getByText('Français'));
}

describe('ChatInputDocumentTranslate — daily job budget gate', () => {
  beforeEach(() => {
    for (const key of Object.keys(budgets)) delete budgets[key];
    countdown = null;
    refetch.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('renders no notice and an enabled Translate button when no counter is reported', () => {
    renderModal();
    chooseTargetLanguage();
    expect(
      screen.queryByTestId('translation-exhausted-notice'),
    ).not.toBeInTheDocument();
    const submit = screen.getByTestId('translate-submit');
    expect(submit).not.toBeDisabled();
    expect(submit).not.toHaveAttribute('title');
  });

  it('stays enabled while jobs remain', () => {
    budgets['feature.translation.jobsPerDay'] = {
      remaining: 1,
      limit: 3,
      used: 2,
      resetAt: '2099-01-01T00:00:00.000Z',
    };
    renderModal();
    chooseTargetLanguage();
    expect(screen.getByTestId('translate-submit')).not.toBeDisabled();
    expect(
      screen.queryByTestId('translation-exhausted-notice'),
    ).not.toBeInTheDocument();
  });

  it('disables Translate and shows the reason with the countdown at 0 remaining', () => {
    budgets['feature.translation.jobsPerDay'] = {
      remaining: 0,
      limit: 3,
      used: 3,
      resetAt: '2099-01-01T00:00:00.000Z',
    };
    countdown = 'in 9 hours';
    renderModal();
    chooseTargetLanguage();
    const submit = screen.getByTestId('translate-submit');
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(submit).toHaveAttribute(
      'title',
      'limitsUx.routes.translationExhausted limitsUx.routes.resetsIn',
    );
    expect(
      screen.getByTestId('translation-exhausted-notice'),
    ).toHaveTextContent(
      'limitsUx.routes.translationExhausted limitsUx.routes.resetsIn',
    );
    // A click on the disabled button must never reach the server.
    fireEvent.click(submit);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the reason without a countdown clause when resetAt is unknown', () => {
    budgets['feature.translation.jobsPerDay'] = { remaining: 0, limit: 3 };
    renderModal();
    expect(
      screen.getByTestId('translation-exhausted-notice'),
    ).toHaveTextContent(/^limitsUx\.routes\.translationExhausted$/);
  });
});

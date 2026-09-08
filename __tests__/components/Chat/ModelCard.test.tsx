import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { ModelAvailabilityView } from '@/client/hooks/settings/useMyLimits';

import { ModelCard } from '@/components/Chat/ModelCard';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ModelCard's usage-limit rendering in isolation (WP-C §7.4). The card
 * carries no React Query itself — only `useResetCountdown` — so nothing is
 * mocked here; copy assertions anchor on the echoed message keys.
 */

const renderCard = (
  limit?: ModelAvailabilityView,
  extra: Partial<React.ComponentProps<typeof ModelCard>> = {},
) => {
  const onClick = vi.fn();
  const utils = render(
    <ModelCard
      id="gpt-5.2"
      name="GPT-5.2"
      tagline="Flagship"
      isSelected={false}
      onClick={onClick}
      limit={limit}
      {...extra}
    />,
  );
  return { ...utils, onClick };
};

const inOneHour = () => new Date(Date.now() + 3600_000).toISOString();

describe('ModelCard usage-limit states', () => {
  it('renders exactly the plain row when no limit is passed', () => {
    const { onClick } = renderCard();
    const button = screen.getByRole('button', { name: /GPT-5.2/ });
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('model-limit-badge')).toBeNull();
    expect(screen.queryByTestId('model-limit-remaining')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders the plain row for an explicit "available" verdict too', () => {
    const { onClick } = renderCard({
      state: 'available',
      limit: 20,
      remaining: 15,
    });
    expect(screen.queryByTestId('model-limit-badge')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /GPT-5.2/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('exhausted: dimmed, aria-disabled, clock badge, and a click only toggles the inline note', () => {
    const { onClick, container } = renderCard({
      state: 'exhausted',
      reason: 'exhausted',
      limit: 20,
      used: 20,
      remaining: 0,
      resetAt: inOneHour(),
    });
    const button = screen.getByRole('button', { name: /GPT-5.2/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(container.querySelector('.opacity-60')).not.toBeNull();
    expect(screen.getByTestId('model-limit-badge')).toHaveAttribute(
      'title',
      'exhausted',
    );

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByTestId('model-limit-note')).toHaveTextContent(
      'exhausted',
    );
    fireEvent.click(button);
    expect(screen.queryByTestId('model-limit-note')).toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('family-exhausted uses the family sentence', () => {
    renderCard({
      state: 'exhausted',
      reason: 'familyExhausted',
      limit: 50,
      used: 50,
      remaining: 0,
      resetAt: inOneHour(),
    });
    expect(screen.getByTestId('model-limit-badge')).toHaveAttribute(
      'aria-label',
      'familyExhausted',
    );
  });

  it('blocked (stale surface) uses the unavailable sentence and refuses the click', () => {
    const { onClick } = renderCard({ state: 'blocked', reason: 'blocked' });
    expect(screen.getByTestId('model-limit-badge')).toHaveAttribute(
      'aria-label',
      'unavailable',
    );
    fireEvent.click(screen.getByRole('button', { name: /GPT-5.2/ }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the star and hide controls working on a limited row', () => {
    const onToggleStar = vi.fn();
    const onHide = vi.fn();
    renderCard(
      {
        state: 'exhausted',
        reason: 'exhausted',
        limit: 1,
        used: 1,
        remaining: 0,
      },
      { onToggleStar, starLabel: 'Star', onHide, hideLabel: 'Hide' },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Star' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(onToggleStar).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('shows the low-remaining pill at or under 10 % of the cap and never alongside the badge', () => {
    renderCard({ state: 'available', limit: 20, used: 18, remaining: 2 });
    expect(screen.getByTestId('model-limit-remaining')).toHaveTextContent(
      'remaining',
    );
    expect(screen.queryByTestId('model-limit-badge')).toBeNull();
  });

  it('caps the low-remaining threshold at one request for tiny limits', () => {
    const { unmount } = renderCard({
      state: 'available',
      limit: 3,
      used: 2,
      remaining: 1,
    });
    expect(screen.getByTestId('model-limit-remaining')).toBeInTheDocument();
    unmount();
    renderCard({ state: 'available', limit: 3, used: 1, remaining: 2 });
    expect(screen.queryByTestId('model-limit-remaining')).toBeNull();
  });

  describe('reset countdown', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-08T10:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires onLimitExpired once when the reset boundary passes while mounted', () => {
      const onLimitExpired = vi.fn();
      renderCard(
        {
          state: 'exhausted',
          reason: 'exhausted',
          limit: 20,
          used: 20,
          remaining: 0,
          resetAt: new Date('2026-09-08T10:02:00Z').toISOString(),
        },
        { onLimitExpired },
      );
      expect(onLimitExpired).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(3 * 60_000);
      });
      expect(onLimitExpired).toHaveBeenCalledTimes(1);
      // Past the boundary the sentence drops the countdown; the row stays
      // grayed until the parent's refetch replaces the verdict.
      expect(screen.getByTestId('model-limit-badge')).toHaveAttribute(
        'aria-label',
        'exhaustedNoReset',
      );
    });
  });
});

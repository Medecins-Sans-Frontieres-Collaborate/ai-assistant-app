import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { AgentTechnicalDetails } from '@/components/AgentAccess/AgentTechnicalDetails';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('AgentTechnicalDetails', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps identifiers collapsed and copies the full source and key after expansion', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const source = `/subscriptions/${'long-source/'.repeat(30)}`;
    const key = `${source}::agent-id`;
    const { container } = render(
      <AgentTechnicalDetails canonicalKey={key} source={source} />,
    );
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    // Native disclosure works in browsers; jsdom needs the open property set.
    details.open = true;
    fireEvent.click(screen.getByRole('button', { name: 'Copy (Source)' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(key));
    expect(screen.getByText(key)).toHaveClass('[overflow-wrap:anywhere]');
  });

  it('selects the full value when clipboard access is denied', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const { container } = render(
      <AgentTechnicalDetails canonicalKey="source::agent" />,
    );
    container.querySelector('details')!.open = true;
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    await waitFor(() =>
      expect(window.getSelection()?.toString()).toBe('source::agent'),
    );
  });
});

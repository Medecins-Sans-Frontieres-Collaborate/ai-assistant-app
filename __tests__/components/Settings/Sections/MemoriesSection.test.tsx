import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { MemoriesSection } from '@/components/Settings/Sections/MemoriesSection';

import { useMemoryStore } from '@/client/stores/memoryStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable LD flags (ConnectorsSection pattern). Note the section itself
// renders regardless of the `enableMemories` flag — SettingsSidebar gates
// visibility (fail-closed, covered in SettingsSidebar.test.tsx) — so no
// flag value is needed for the section to render.
const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const makeMemory = (
  id: string,
  text: string,
  updatedAt = '2026-07-01T00:00:00.000Z',
) => ({
  id,
  text,
  createdAt: updatedAt,
  updatedAt,
});

describe('MemoriesSection', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockFlags)) delete mockFlags[key];
    useSettingsStore.setState({
      memoriesEnabled: false,
      memoriesFlagEnabled: false,
    });
    useMemoryStore.setState({ memories: [] });
  });

  it('renders the empty state when no memories are stored', () => {
    render(<MemoriesSection />);

    expect(
      screen.getByText(
        'No memories yet. Facts worth remembering are saved automatically from your conversations.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Clear all memories')).not.toBeInTheDocument();
  });

  it('toggle writes memoriesEnabled to the settings store', () => {
    render(<MemoriesSection />);

    const toggle = screen.getByLabelText(/Enable memories/);
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().memoriesEnabled).toBe(true);

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().memoriesEnabled).toBe(false);
  });

  it('reflects an already-enabled setting in the checkbox', () => {
    useSettingsStore.setState({ memoriesEnabled: true });
    render(<MemoriesSection />);

    expect(screen.getByLabelText(/Enable memories/)).toBeChecked();
  });

  it('lists stored memories with the privacy note visible', () => {
    useMemoryStore.setState({
      memories: [
        makeMemory('m1', 'Works as a marine biologist'),
        makeMemory('m2', 'Prefers answers in Spanish'),
      ],
    });

    render(<MemoriesSection />);

    expect(screen.getByText('Works as a marine biologist')).toBeInTheDocument();
    expect(screen.getByText('Prefers answers in Spanish')).toBeInTheDocument();
    // Dates go through next-intl's useFormatter (app locale), mocked in
    // vitest.setup.dom.ts as the ISO date part.
    expect(screen.getAllByText('Saved 2026-07-01')).toHaveLength(2);
    expect(
      screen.getByText(
        'Facts are stored only in this browser and included in your chats to personalize replies.',
      ),
    ).toBeInTheDocument();
  });

  it('per-entry delete removes only that memory', () => {
    useMemoryStore.setState({
      memories: [
        makeMemory('m1', 'Works as a marine biologist'),
        makeMemory('m2', 'Prefers answers in Spanish'),
      ],
    });

    render(<MemoriesSection />);

    fireEvent.click(screen.getAllByLabelText('Delete memory')[0]);

    const remaining = useMemoryStore.getState().memories;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('m2');
    expect(
      screen.queryByText('Works as a marine biologist'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Prefers answers in Spanish')).toBeInTheDocument();
  });

  it('clear-all requires the inline confirm before clearing the store', () => {
    useMemoryStore.setState({
      memories: [makeMemory('m1', 'Works as a marine biologist')],
    });

    render(<MemoriesSection />);

    fireEvent.click(screen.getByText('Clear all memories'));
    // First click only reveals the confirm — nothing is deleted yet.
    expect(useMemoryStore.getState().memories).toHaveLength(1);
    expect(
      screen.getByText('Delete all memories? This cannot be undone.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Delete all'));
    expect(useMemoryStore.getState().memories).toHaveLength(0);
    expect(
      screen.getByText(
        'No memories yet. Facts worth remembering are saved automatically from your conversations.',
      ),
    ).toBeInTheDocument();
  });

  it('cancelling the inline confirm keeps the memories', () => {
    useMemoryStore.setState({
      memories: [makeMemory('m1', 'Works as a marine biologist')],
    });

    render(<MemoriesSection />);

    fireEvent.click(screen.getByText('Clear all memories'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(useMemoryStore.getState().memories).toHaveLength(1);
    expect(
      screen.queryByText('Delete all memories? This cannot be undone.'),
    ).not.toBeInTheDocument();
  });

  it('does not leave the clear-all confirm armed after the list empties and refills', () => {
    useMemoryStore.setState({
      memories: [makeMemory('m1', 'Works as a marine biologist')],
    });

    render(<MemoriesSection />);

    // Arm the confirm, then empty the list via the per-item delete instead.
    fireEvent.click(screen.getByText('Clear all memories'));
    expect(
      screen.getByText('Delete all memories? This cannot be undone.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Delete memory'));

    // A new memory arrives (e.g. auto-extraction lands while Settings is open).
    act(() => {
      useMemoryStore.setState({
        memories: [makeMemory('m2', 'Prefers answers in Spanish')],
      });
    });

    // The safe button must be shown, not the armed destructive confirm.
    expect(screen.getByText('Clear all memories')).toBeInTheDocument();
    expect(
      screen.queryByText('Delete all memories? This cannot be undone.'),
    ).not.toBeInTheDocument();
    expect(useMemoryStore.getState().memories).toHaveLength(1);
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ContextWindowSlider } from '@/components/Settings/ContextWindowSlider';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('ContextWindowSlider', () => {
  beforeEach(() => {
    useSettingsStore.setState({ contextWindowSize: 80 });
  });

  it('renders the current store value and the description', () => {
    render(<ContextWindowSlider />);

    expect(screen.getByText('80 messages')).toBeInTheDocument();
    // The label must be associated with the input (accessible name).
    expect(screen.getByRole('slider', { name: 'Context window' })).toHaveValue(
      '80',
    );
    expect(
      screen.getByText(
        'Older messages beyond this limit are summarized and sent as context.',
      ),
    ).toBeInTheDocument();
  });

  it('writes the changed value to the settings store', () => {
    render(<ContextWindowSlider />);

    fireEvent.change(screen.getByRole('slider'), { target: { value: '55' } });

    expect(useSettingsStore.getState().contextWindowSize).toBe(55);
    expect(screen.getByText('55 messages')).toBeInTheDocument();
  });

  it('never stores an out-of-range value (input max + store clamp)', () => {
    render(<ContextWindowSlider />);

    fireEvent.change(screen.getByRole('slider'), { target: { value: '500' } });

    expect(useSettingsStore.getState().contextWindowSize).toBe(200);
  });
});

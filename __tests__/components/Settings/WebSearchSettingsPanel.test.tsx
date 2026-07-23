import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { DEFAULT_WEB_SEARCH_OPTIONS } from '@/types/webSearch';

import { WebSearchSettingsPanel } from '@/components/Settings/WebSearchSettingsPanel';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('WebSearchSettingsPanel', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      webSearchOptions: { ...DEFAULT_WEB_SEARCH_OPTIONS },
    });
  });

  it('renders all provider choices with Automatic selected by default', () => {
    render(<WebSearchSettingsPanel />);

    expect(
      screen.getByRole('radio', { name: /Automatic \(recommended\)/ }),
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Combined news/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Google News only/ }),
    ).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /GDELT only/ })).not.toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Bing grounding/ }),
    ).not.toBeChecked();
  });

  it('warns that Bing grounding is slow and inconsistent', () => {
    render(<WebSearchSettingsPanel />);

    const description = screen.getByText(/30–90 seconds/);
    expect(description.textContent).toMatch(/often inconsistent/);
  });

  it('explains the Google News trade-off (anonymous, fast, headlines-only)', () => {
    render(<WebSearchSettingsPanel />);

    const description = screen.getByText(/Anonymous and fast/);
    expect(description).toBeInTheDocument();
    expect(description.textContent).toMatch(/headlines and short snippets/);
  });

  it('writes the chosen provider to the settings store', () => {
    render(<WebSearchSettingsPanel />);

    fireEvent.click(screen.getByRole('radio', { name: /Google News only/ }));

    expect(useSettingsStore.getState().webSearchOptions.provider).toBe(
      'google-news',
    );
    expect(
      screen.getByRole('radio', { name: /Google News only/ }),
    ).toBeChecked();
  });

  it('exposes the sources slider and freshness select on the same store', () => {
    render(<WebSearchSettingsPanel />);

    fireEvent.change(screen.getByRole('slider', { name: /Sources/ }), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: /recency/i }), {
      target: { value: 'week' },
    });

    const options = useSettingsStore.getState().webSearchOptions;
    expect(options.resultCount).toBe(12);
    expect(options.freshness).toBe('week');
  });
});

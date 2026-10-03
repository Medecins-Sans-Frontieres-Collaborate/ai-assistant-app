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

  it('renders all provider choices with the automatic default selected', () => {
    render(<WebSearchSettingsPanel />);

    // 'auto' is the product default (DEFAULT_WEB_SEARCH_OPTIONS): the
    // deployment picks the backend — MSF web search where configured.
    expect(
      screen.getByRole('radio', { name: /Automatic \(recommended\)/ }),
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /^MSF web search/ }),
    ).not.toBeChecked();
    expect(screen.getByText('Other providers')).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /Deep search with early headlines/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Combined news/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Google News only/ }),
    ).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /GDELT only/ })).not.toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Bing web search/ }),
    ).not.toBeChecked();
    // One Bing option: the two earlier routes (agent / direct) are merged.
    expect(
      screen.queryByRole('radio', { name: /Bing fast search/ }),
    ).toBeNull();
    expect(screen.queryByRole('radio', { name: /Bing grounding/ })).toBeNull();
  });

  it('writes the MSF web search provider to the settings store', () => {
    render(<WebSearchSettingsPanel />);

    fireEvent.click(screen.getByRole('radio', { name: /^MSF web search/ }));

    expect(useSettingsStore.getState().webSearchOptions.provider).toBe(
      'searxng',
    );
  });

  it('writes the combined provider to the settings store', () => {
    render(<WebSearchSettingsPanel />);

    fireEvent.click(
      screen.getByRole('radio', { name: /Deep search with early headlines/ }),
    );

    expect(useSettingsStore.getState().webSearchOptions.provider).toBe(
      'combined',
    );
  });

  it('describes Bing as a single model call in the user’s region', () => {
    render(<WebSearchSettingsPanel />);

    const description = screen.getByText(/single model call in your region/);
    expect(description.textContent).toMatch(/general web, not just news/);
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

  it('writes the bing provider to the settings store', () => {
    render(<WebSearchSettingsPanel />);

    fireEvent.click(screen.getByRole('radio', { name: /Bing web search/ }));

    expect(useSettingsStore.getState().webSearchOptions.provider).toBe('bing');
    expect(
      screen.getByRole('radio', { name: /Bing web search/ }),
    ).toBeChecked();
  });

  it('has multi-step search on by default and lets the user switch it off', () => {
    render(<WebSearchSettingsPanel />);

    const toggle = screen.getByRole('checkbox', { name: /Multi-step search/ });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().webSearchOptions.multiStep).toBe(false);
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().webSearchOptions.multiStep).toBe(true);
  });

  it('treats settings persisted before the option existed as on', () => {
    useSettingsStore.setState({
      webSearchOptions: {
        resultCount: 8,
        freshness: 'auto',
        provider: 'auto',
      } as never,
    });
    render(<WebSearchSettingsPanel />);

    expect(
      screen.getByRole('checkbox', { name: /Multi-step search/ }),
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

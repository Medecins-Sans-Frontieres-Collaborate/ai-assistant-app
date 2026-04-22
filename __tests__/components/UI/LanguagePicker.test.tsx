import { fireEvent, render, screen } from '@testing-library/react';
import React, { useRef } from 'react';

import { LanguageOption } from '@/lib/utils/app/languagePickerHelpers';

import { LanguagePicker } from '@/components/UI/LanguagePicker';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MESSAGES: Record<string, string> = {
  'chat.searchLanguages': 'Search languages',
  'chat.selectLanguage': 'Select language',
  'common.clearSearch': 'Clear search',
  'common.noResults': 'No results',
};

vi.mock('next-intl', () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      const value = MESSAGES[key] ?? key;
      if (!values) return value;
      return Object.entries(values).reduce<string>(
        (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
        value,
      );
    },
}));

const withIntl = (ui: React.ReactNode) => <>{ui}</>;

interface HarnessProps {
  options: LanguageOption[];
  value?: string | null;
  onSelect?: (code: string | null) => void;
  isOpen?: boolean;
  clearOption?: { label: string } | null;
  cachedCodes?: Set<string>;
  disabled?: boolean;
}

const Harness: React.FC<HarnessProps> = ({
  options,
  value = null,
  onSelect = () => undefined,
  isOpen = true,
  clearOption = null,
  cachedCodes,
  disabled,
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button" data-testid="trigger">
        trigger
      </button>
      <LanguagePicker
        triggerRef={triggerRef}
        isOpen={isOpen}
        onClose={() => undefined}
        options={options}
        value={value}
        onSelect={onSelect}
        clearOption={clearOption}
        cachedCodes={cachedCodes}
        disabled={disabled}
      />
    </>
  );
};

const OPTIONS: LanguageOption[] = [
  { code: 'en', label: 'English', sublabel: 'en' },
  { code: 'es', label: 'Spanish', sublabel: 'Español' },
  { code: 'zh', label: 'Chinese', sublabel: '中文' },
  { code: 'my', label: 'Burmese', sublabel: 'မြန်မာ', supported: false },
];

const getSearchInput = (container: HTMLElement): HTMLInputElement => {
  // The search input is inside the portaled listbox; it's the only text input
  // on the page in these tests.
  const input = document.body.querySelector<HTMLInputElement>(
    '[role="listbox"] input[type="text"]',
  );
  if (!input) throw new Error('search input not found');
  void container;
  return input;
};

describe('LanguagePicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when closed', () => {
    render(withIntl(<Harness options={OPTIONS} isOpen={false} />));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('portals the listbox to document.body when open', () => {
    const { container } = render(withIntl(<Harness options={OPTIONS} />));
    // Listbox is not inside the rendered container (it's portaled).
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('renders each option', () => {
    render(withIntl(<Harness options={OPTIONS} />));
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('Spanish')).toBeInTheDocument();
    expect(screen.getByText('Chinese')).toBeInTheDocument();
    expect(screen.getByText('Burmese')).toBeInTheDocument();
  });

  it('fires onSelect(null) when the clearOption row is chosen', () => {
    const onSelect = vi.fn();
    render(
      withIntl(
        <Harness
          options={OPTIONS}
          clearOption={{ label: 'Auto-detect' }}
          onSelect={onSelect}
        />,
      ),
    );
    fireEvent.click(screen.getByText('Auto-detect'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('fires onSelect(code) when a language row is chosen', () => {
    const onSelect = vi.fn();
    render(withIntl(<Harness options={OPTIONS} onSelect={onSelect} />));
    fireEvent.click(screen.getByText('Spanish'));
    expect(onSelect).toHaveBeenCalledWith('es');
  });

  it('filters options by label, sublabel, and code', () => {
    const { container } = render(withIntl(<Harness options={OPTIONS} />));
    const search = getSearchInput(container);

    fireEvent.change(search, { target: { value: 'Eng' } });
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.queryByText('Spanish')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: '中文' } });
    expect(screen.getByText('Chinese')).toBeInTheDocument();
    expect(screen.queryByText('English')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'my' } });
    expect(screen.getByText('Burmese')).toBeInTheDocument();
    expect(screen.queryByText('English')).not.toBeInTheDocument();
  });

  it('renders unsupported rows muted via data-supported="false"', () => {
    render(withIntl(<Harness options={OPTIONS} />));
    const burmeseRow = screen.getByText('Burmese').closest('button')!;
    expect(burmeseRow).toHaveAttribute('data-supported', 'false');
    const englishRow = screen.getByText('English').closest('button')!;
    expect(englishRow).toHaveAttribute('data-supported', 'true');
  });

  it('shows cached badge for codes in cachedCodes', () => {
    render(
      withIntl(
        <Harness
          options={OPTIONS}
          cachedCodes={new Set(['es'])}
          value={null}
        />,
      ),
    );
    // Cached indicator is rendered inside the Spanish row (green check SVG).
    const spanishRow = screen.getByText('Spanish').closest('button')!;
    expect(spanishRow.querySelector('svg')).toBeInTheDocument();
  });

  it('disabled prevents selection via click', () => {
    const onSelect = vi.fn();
    render(
      withIntl(<Harness options={OPTIONS} onSelect={onSelect} disabled />),
    );
    fireEvent.click(screen.getByText('Spanish'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the no-results message when search matches nothing', () => {
    const { container } = render(withIntl(<Harness options={OPTIONS} />));
    fireEvent.change(getSearchInput(container), {
      target: { value: 'zzzz' },
    });
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('Escape closes the dropdown', () => {
    const onClose = vi.fn();
    const TestHarness: React.FC = () => {
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" />
          <LanguagePicker
            triggerRef={triggerRef}
            isOpen
            onClose={onClose}
            options={OPTIONS}
            value={null}
            onSelect={() => undefined}
          />
        </>
      );
    };
    render(withIntl(<TestHarness />));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('ArrowDown + Enter selects the first option', () => {
    const onSelect = vi.fn();
    render(withIntl(<Harness options={OPTIONS} onSelect={onSelect} />));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('en');
  });

  it('ArrowDown + Enter selects the clearOption when it is pinned at top', () => {
    const onSelect = vi.fn();
    render(
      withIntl(
        <Harness
          options={OPTIONS}
          clearOption={{ label: 'Auto-detect' }}
          onSelect={onSelect}
        />,
      ),
    );
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

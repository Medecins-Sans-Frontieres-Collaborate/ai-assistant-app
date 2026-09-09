import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import LanguageSwitcher from '@/components/Sidebar/components/LanguageSwitcher';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next-intl: the test drives the locale; translations echo their keys
// (the shared LanguagePicker only uses them for placeholder/aria text).
const mockUseLocale = vi.fn();
vi.mock('next-intl', () => ({
  useLocale: () => mockUseLocale(),
  useTranslations: () => {
    const translate = (key: string) => key;
    translate.has = () => false;
    translate.rich = (key: string) => key;
    return translate;
  },
}));

// Mock locales utility
vi.mock('@/lib/utils/app/locales', () => ({
  getSupportedLocales: () => ['en', 'fr', 'es', 'de'],
  getAutonym: (locale: string) => {
    const autonyms: Record<string, string> = {
      en: 'English',
      fr: 'Français',
      es: 'Español',
      de: 'Deutsch',
    };
    return autonyms[locale] || locale;
  },
}));

const openPicker = () => {
  fireEvent.click(screen.getByRole('button', { name: 'chat.selectLanguage' }));
};

describe('LanguageSwitcher', () => {
  let mockReload: ReturnType<typeof vi.fn>;
  let originalLocation: typeof window.location;

  beforeEach(() => {
    mockUseLocale.mockReturnValue('en');

    mockReload = vi.fn();
    originalLocation = window.location;
    delete (window as any).location;
    window.location = { ...originalLocation, reload: mockReload } as any;

    Object.defineProperty(document, 'cookie', {
      writable: true,
      value: '',
    });
  });

  afterEach(() => {
    window.location = originalLocation as any;
    mockReload.mockClear();
  });

  describe('Rendering', () => {
    it('renders a trigger showing the current locale autonym', () => {
      mockUseLocale.mockReturnValue('fr');
      render(<LanguageSwitcher />);

      expect(
        screen.getByRole('button', { name: 'chat.selectLanguage' }),
      ).toHaveTextContent('Français');
    });

    it('opens the searchable picker listing every supported locale', () => {
      render(<LanguageSwitcher />);
      openPicker();

      const listbox = screen.getByRole('listbox');
      expect(listbox).toBeInTheDocument();
      // SettingDialog's outside-click close ignores marked portals; without
      // this, clicking a language row closes Settings before it can select.
      expect(listbox).toHaveAttribute('data-settings-portal');
      // Autonyms as primary labels (trigger also shows 'English' — hence
      // getAllByText for the active locale).
      expect(screen.getAllByText('English').length).toBeGreaterThan(0);
      expect(screen.getByText('Français')).toBeInTheDocument();
      expect(screen.getByText('Español')).toBeInTheDocument();
      expect(screen.getByText('Deutsch')).toBeInTheDocument();
    });

    it('marks the current locale as selected', () => {
      mockUseLocale.mockReturnValue('es');
      render(<LanguageSwitcher />);
      openPicker();

      const selected = screen.getByRole('option', { selected: true });
      expect(selected).toHaveTextContent('Español');
    });

    it('search filters the list', () => {
      render(<LanguageSwitcher />);
      openPicker();

      fireEvent.change(screen.getByPlaceholderText('chat.searchLanguages'), {
        target: { value: 'Deu' },
      });

      expect(screen.getByText('Deutsch')).toBeInTheDocument();
      expect(screen.queryByText('Français')).toBeNull();
    });
  });

  describe('Locale Change', () => {
    it('sets the NEXT_LOCALE cookie and reloads on selection', () => {
      render(<LanguageSwitcher />);
      openPicker();

      fireEvent.click(screen.getByText('Español'));

      expect(document.cookie).toContain('NEXT_LOCALE=es');
      expect(document.cookie).toContain('path=/');
      expect(document.cookie).toContain('max-age=31536000');
      expect(document.cookie).toContain('SameSite=Lax');
      expect(mockReload).toHaveBeenCalledTimes(1);
    });

    it('re-selecting the current locale is a no-op (no reload)', () => {
      render(<LanguageSwitcher />);
      openPicker();

      fireEvent.click(screen.getByRole('option', { selected: true }));

      expect(document.cookie).not.toContain('NEXT_LOCALE');
      expect(mockReload).not.toHaveBeenCalled();
    });

    it('keyboard: ArrowDown + Enter selects the highlighted language', () => {
      render(<LanguageSwitcher />);
      openPicker();

      const listbox = screen.getByRole('listbox');
      // Options are sorted alphabetically by autonym: Deutsch is first.
      fireEvent.keyDown(listbox, { key: 'ArrowDown' });
      fireEvent.keyDown(listbox, { key: 'Enter' });

      expect(document.cookie).toContain('NEXT_LOCALE=de');
      expect(mockReload).toHaveBeenCalledTimes(1);
    });
  });
});

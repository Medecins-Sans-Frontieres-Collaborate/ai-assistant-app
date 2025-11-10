import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import LanguageSwitcher from '@/components/Sidebar/components/LanguageSwitcher';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next-intl
const mockUseLocale = vi.fn();
vi.mock('next-intl', () => ({
  useLocale: () => mockUseLocale(),
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

describe('LanguageSwitcher', () => {
  let mockReload: ReturnType<typeof vi.fn>;
  let originalLocation: typeof window.location;

  beforeEach(() => {
    mockUseLocale.mockReturnValue('en');

    // Mock window.location.reload
    mockReload = vi.fn();
    originalLocation = window.location;
    delete (window as any).location;
    window.location = { ...originalLocation, reload: mockReload } as any;

    // Mock document.cookie
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
    it('renders language selector', () => {
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox');
      expect(select).toBeInTheDocument();
    });

    it('renders all supported locales as options', () => {
      render(<LanguageSwitcher />);

      expect(screen.getByText('English')).toBeInTheDocument();
      expect(screen.getByText('Français')).toBeInTheDocument();
      expect(screen.getByText('Español')).toBeInTheDocument();
      expect(screen.getByText('Deutsch')).toBeInTheDocument();
    });

    it('displays current locale as selected', () => {
      mockUseLocale.mockReturnValue('fr');
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('fr');
    });

    it('has correct number of options', () => {
      render(<LanguageSwitcher />);

      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(4);
    });
  });

  describe('Locale Change', () => {
    it('sets NEXT_LOCALE cookie when locale is changed', () => {
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox');
      fireEvent.change(select, { target: { value: 'es' } });

      expect(document.cookie).toContain('NEXT_LOCALE=es');
    });

    it('calls window.location.reload when locale is changed', () => {
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox');
      fireEvent.change(select, { target: { value: 'es' } });

      expect(mockReload).toHaveBeenCalledTimes(1);
    });

    it('sets correct cookie attributes', () => {
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox');
      fireEvent.change(select, { target: { value: 'de' } });

      const cookie = document.cookie;
      expect(cookie).toContain('path=/');
      expect(cookie).toContain('max-age=31536000');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('updates cookie for different locales', () => {
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox');

      fireEvent.change(select, { target: { value: 'fr' } });
      expect(document.cookie).toContain('NEXT_LOCALE=fr');

      fireEvent.change(select, { target: { value: 'de' } });
      expect(document.cookie).toContain('NEXT_LOCALE=de');
    });
  });

  describe('Styling', () => {
    it('has correct select styling classes', () => {
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox');
      expect(select).toHaveClass('w-[100px]');
      expect(select).toHaveClass('cursor-pointer');
      expect(select).toHaveClass('bg-transparent');
      expect(select).toHaveClass('text-center');
    });

    it('has dark mode styling', () => {
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox');
      expect(select).toHaveClass('dark:text-neutral-200');
    });

    it('options have correct background classes', () => {
      render(<LanguageSwitcher />);

      const options = screen.getAllByRole('option');
      options.forEach((option) => {
        expect(option).toHaveClass('bg-white');
        expect(option).toHaveClass('dark:bg-black');
      });
    });

    it('has hover styling', () => {
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox');
      expect(select).toHaveClass('hover:bg-gray-500/10');
    });
  });

  describe('Different Locales', () => {
    it('works with English locale', () => {
      mockUseLocale.mockReturnValue('en');
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('en');
      expect(screen.getByText('English')).toBeInTheDocument();
    });

    it('works with French locale', () => {
      mockUseLocale.mockReturnValue('fr');
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('fr');
      expect(screen.getByText('Français')).toBeInTheDocument();
    });

    it('works with Spanish locale', () => {
      mockUseLocale.mockReturnValue('es');
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('es');
      expect(screen.getByText('Español')).toBeInTheDocument();
    });

    it('works with German locale', () => {
      mockUseLocale.mockReturnValue('de');
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('de');
      expect(screen.getByText('Deutsch')).toBeInTheDocument();
    });
  });

  describe('Option Values', () => {
    it('each option has correct value attribute', () => {
      render(<LanguageSwitcher />);

      const englishOption = screen.getByText('English') as HTMLOptionElement;
      expect(englishOption.value).toBe('en');

      const frenchOption = screen.getByText('Français') as HTMLOptionElement;
      expect(frenchOption.value).toBe('fr');

      const spanishOption = screen.getByText('Español') as HTMLOptionElement;
      expect(spanishOption.value).toBe('es');

      const germanOption = screen.getByText('Deutsch') as HTMLOptionElement;
      expect(germanOption.value).toBe('de');
    });
  });

  describe('Accessibility', () => {
    it('select is keyboard accessible', () => {
      render(<LanguageSwitcher />);

      const select = screen.getByRole('combobox');
      expect(select.tagName).toBe('SELECT');
    });
  });
});

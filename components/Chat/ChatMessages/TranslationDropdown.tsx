'use client';

import React, { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import {
  LanguageOption,
  sortLanguageOptionsByLabel,
} from '@/lib/utils/app/languagePickerHelpers';
import { getAutonym, getSupportedLocales } from '@/lib/utils/app/locales';

import { LanguagePicker } from '@/components/UI/LanguagePicker';

interface TranslationDropdownProps {
  /** Reference to the button that triggered the dropdown */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Callback to close the dropdown */
  onClose: () => void;
  /** Callback when a language is selected (null = show original) */
  onSelectLanguage: (locale: string | null) => void;
  /** Currently displayed locale (null = showing original) */
  currentLocale: string | null;
  /** Whether a translation is in progress */
  isTranslating: boolean;
  /** Set of locale codes that have been cached */
  cachedLocales: Set<string>;
}

/**
 * Dropdown for picking a target language for translation. Thin wrapper over
 * the shared `<LanguagePicker>`; keeps the caller-facing prop shape stable.
 */
export const TranslationDropdown: FC<TranslationDropdownProps> = ({
  triggerRef,
  isOpen,
  onClose,
  onSelectLanguage,
  currentLocale,
  isTranslating,
  cachedLocales,
}) => {
  const t = useTranslations();

  const options = useMemo<LanguageOption[]>(() => {
    const mapped = getSupportedLocales().map<LanguageOption>((locale) => ({
      code: locale,
      label: getAutonym(locale),
      sublabel: locale,
    }));
    return sortLanguageOptionsByLabel(mapped);
  }, []);

  const clearOption = currentLocale ? { label: t('chat.showOriginal') } : null;

  return (
    <LanguagePicker
      triggerRef={triggerRef}
      isOpen={isOpen}
      onClose={onClose}
      options={options}
      value={currentLocale}
      onSelect={onSelectLanguage}
      clearOption={clearOption}
      cachedCodes={cachedLocales}
      disabled={isTranslating}
    />
  );
};

export default TranslationDropdown;

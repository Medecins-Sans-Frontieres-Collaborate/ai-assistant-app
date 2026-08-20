'use client';

import { IconChevronDown } from '@tabler/icons-react';
import { FC, useMemo, useRef, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import {
  LanguageOption,
  sortLanguageOptionsByLabel,
} from '@/lib/utils/app/languagePickerHelpers';
import { getAutonym, getSupportedLocales } from '@/lib/utils/app/locales';

import { LanguagePicker } from '@/components/UI/LanguagePicker';

/**
 * UI-language selector — the shared searchable `<LanguagePicker>` over the
 * app's supported locales, replacing the bare `<select>` holdover so this
 * control looks and works like the transcription/translation pickers
 * (search over autonym + English name + code, keyboard navigation, portal
 * dropdown). Used in the sidebar footer and Settings → General.
 */
const LanguageSwitcher: FC = () => {
  const t = useTranslations();
  const locale = useLocale();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  const options = useMemo<LanguageOption[]>(() => {
    // English names as sublabels so users can find a language they can't
    // yet read; Intl covers every ISO 639-1 code we ship, but fall back to
    // the bare code defensively.
    let englishNames: Intl.DisplayNames | null = null;
    try {
      englishNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      englishNames = null;
    }
    return sortLanguageOptionsByLabel(
      getSupportedLocales().map((code) => {
        const autonym = getAutonym(code);
        let english: string | undefined;
        try {
          english = englishNames?.of(code) ?? undefined;
        } catch {
          english = undefined;
        }
        return {
          code,
          label: autonym,
          // Skip the sublabel when it just repeats the autonym (English).
          sublabel: english && english !== autonym ? english : code,
        };
      }),
    );
  }, []);

  const handleSelect = (code: string | null) => {
    if (!code || code === locale) return;
    // With localePrefix: 'never', we need to set a cookie and reload.
    // The next-intl middleware reads the cookie and serves the new locale.
    document.cookie = `NEXT_LOCALE=${code}; path=/; max-age=31536000; SameSite=Lax`;
    window.location.reload();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={t('chat.selectLanguage')}
        className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
      >
        <span className="truncate">{getAutonym(locale)}</span>
        <IconChevronDown
          size={14}
          className={`shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      <LanguagePicker
        triggerRef={triggerRef}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        options={options}
        value={locale}
        onSelect={handleSelect}
      />
    </>
  );
};

export default LanguageSwitcher;

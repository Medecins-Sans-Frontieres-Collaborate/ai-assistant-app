'use client';

import { ChangeEvent, FC } from 'react';

import { useLocale } from 'next-intl';

import { getAutonym, getSupportedLocales } from '@/lib/utils/app/locales';

const LanguageSwitcher: FC = () => {
  const locale = useLocale();
  const locales = getSupportedLocales();

  const handleLocaleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const newLocale = event.target.value;

    // With localePrefix: 'never', we need to set a cookie and reload
    // The next-intl middleware will read the cookie and serve the correct locale
    document.cookie = `NEXT_LOCALE=${newLocale}; path=/; max-age=31536000; SameSite=Lax`;

    // Force a full page reload to pick up the new locale
    window.location.reload();
  };

  return (
    <div className={'grid'}>
      <select
        value={locale}
        onChange={handleLocaleChange}
        className="w-[100px] cursor-pointer bg-transparent p-2 text-neutral-700 dark:text-neutral-200 text-center text-sm border-none hover:bg-gray-500/10"
      >
        {locales.map((localeOption) => (
          <option
            className={'bg-white dark:bg-black'}
            key={localeOption}
            value={localeOption}
          >
            {getAutonym(localeOption)}
          </option>
        ))}
      </select>
    </div>
  );
};

export default LanguageSwitcher;

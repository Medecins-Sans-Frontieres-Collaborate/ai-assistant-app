import { defineRouting } from 'next-intl/routing';

import { getSupportedLocales } from '@/lib/utils/app/locales';

export const locales = getSupportedLocales();
export const defaultLocale = 'en';

export const routing = defineRouting({
  locales,
  defaultLocale,
  // Never show locale prefixes in the URL - handled via cookies
  // The [locale] folder structure is still needed for routing,
  // but next-intl rewrites URLs to hide the locale from users
  localePrefix: 'never',
  // Enable automatic locale detection from browser Accept-Language header
  // Falls back to defaultLocale if browser language is not supported
  localeDetection: true,
});

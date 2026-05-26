// Locale utility functions and mappings

/**
 * Map of ISO 639-1 language codes to their autonym (name in their own language)
 */
export const localeToAutonym: Record<string, string> = {
  am: 'አማርኛ',
  ar: 'العربية',
  bn: 'বাংলা',
  ca: 'Català',
  cs: 'Čeština',
  de: 'Deutsch',
  el: 'Ελληνικά',
  en: 'English',
  es: 'Español',
  fa: 'فارسی',
  ff: 'Fulfulde',
  fi: 'Suomi',
  fr: 'Français',
  ha: 'Hausa',
  he: 'עברית',
  hi: 'हिन्दी',
  ht: 'Kreyòl Ayisyen',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  km: 'ខ្មែរ',
  ko: '한국어',
  ku: 'Kurdî',
  ln: 'Lingála',
  mg: 'Malagasy',
  my: 'မြန်မာဘာသာ',
  ne: 'नेपाली',
  nl: 'Nederlands',
  ny: 'Chichewa',
  pl: 'Polski',
  ps: 'پښتو',
  pt: 'Português',
  rn: 'Ikirundi',
  ro: 'Română',
  ru: 'Русский',
  rw: 'Kinyarwanda',
  sg: 'Sängö',
  si: 'සිංහල',
  so: 'Soomaali',
  sr: 'Српски',
  sv: 'Svenska',
  sw: 'Kiswahili',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  tg: 'Тоҷикӣ',
  th: 'ไทย',
  ti: 'ትግርኛ',
  tr: 'Türkçe',
  uk: 'Українська',
  ur: 'اردو',
  vi: 'Tiếng Việt',
  yo: 'Yorùbá',
  zh: '中文',
  zu: 'isiZulu',
};

/**
 * Get the autonym (native name) for a given locale
 * @param locale - ISO 639-1 language code
 * @returns The autonym for the locale, or the locale itself if not found
 */
export const getAutonym = (locale: string): string => {
  return localeToAutonym[locale] || locale;
};

/**
 * Map of official terms language codes to their display names
 * These are the languages for which official translations of terms documents exist
 */
const officialTermsLocales: Record<string, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
};

/**
 * Get the display name for an official terms language
 * @param locale - ISO 639-1 language code
 * @returns The display name for the locale, or the locale code if not an official terms language
 */
export const getOfficialTermsLanguageName = (locale: string): string => {
  return officialTermsLocales[locale] || locale;
};

/**
 * Get all supported locales
 * @returns Array of supported locale codes
 */
export const getSupportedLocales = (): string[] => {
  return Object.keys(localeToAutonym);
};

/**
 * Convert a model ID to a localization key
 * Model IDs contain characters (dots, dashes) that aren't valid in JSON keys,
 * so we convert them to underscores and lowercase.
 *
 * @param modelId - The model ID (e.g., 'gpt-4.1', 'DeepSeek-R1')
 * @returns A valid localization key (e.g., 'gpt_4_1', 'deepseek_r1')
 *
 * @example
 * modelIdToLocaleKey('gpt-4.1') // 'gpt_4_1'
 * modelIdToLocaleKey('DeepSeek-R1') // 'deepseek_r1'
 * modelIdToLocaleKey('claude-opus-4-5') // 'claude_opus_4_5'
 */
export const modelIdToLocaleKey = (modelId: string): string => {
  return modelId.toLowerCase().replace(/[.-]/g, '_');
};

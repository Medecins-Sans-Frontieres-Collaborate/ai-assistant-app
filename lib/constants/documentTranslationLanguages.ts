/**
 * Document Translation Languages Configuration
 *
 * Full list of languages supported by Azure Translator Document Translation.
 * Source: https://learn.microsoft.com/en-us/azure/ai-services/translator/language-support
 *
 * Languages are categorized as either officially supported (curated, verified for
 * production translation quality) or unofficially supported (accepted by Azure
 * Translator but not formally verified — users are warned in the UI to have
 * results reviewed by a fluent or native speaker).
 */

/**
 * Represents a language supported by document translation.
 */
export interface DocumentTranslationLanguage {
  /** ISO language code (e.g., 'en', 'es', 'zh-Hans') */
  code: string;

  /** English name of the language */
  englishName: string;

  /** Native name (autonym) of the language */
  nativeName: string;

  /**
   * Whether the language is officially supported and quality-verified.
   * Unofficial languages are accepted by Azure Translator but the UI surfaces
   * a warning advising review by a fluent or native speaker.
   */
  official: boolean;
}

/**
 * Languages that support bidirectional document translation (both as source and target).
 * Sorted alphabetically by English name within each section.
 */
export const DOCUMENT_TRANSLATION_LANGUAGES: DocumentTranslationLanguage[] = [
  // Officially supported languages
  {
    code: 'af',
    englishName: 'Afrikaans',
    nativeName: 'Afrikaans',
    official: true,
  },
  { code: 'sq', englishName: 'Albanian', nativeName: 'Shqip', official: true },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية', official: true },
  {
    code: 'az',
    englishName: 'Azerbaijani',
    nativeName: 'Azərbaycan',
    official: true,
  },
  { code: 'ba', englishName: 'Bashkir', nativeName: 'Башҡорт', official: true },
  { code: 'eu', englishName: 'Basque', nativeName: 'Euskara', official: true },
  {
    code: 'bs',
    englishName: 'Bosnian',
    nativeName: 'Bosanski',
    official: true,
  },
  {
    code: 'bg',
    englishName: 'Bulgarian',
    nativeName: 'Български',
    official: true,
  },
  {
    code: 'yue',
    englishName: 'Cantonese (Traditional)',
    nativeName: '粵語',
    official: true,
  },
  { code: 'ca', englishName: 'Catalan', nativeName: 'Català', official: true },
  {
    code: 'lzh',
    englishName: 'Chinese (Literary)',
    nativeName: '文言文',
    official: true,
  },
  {
    code: 'zh-Hans',
    englishName: 'Chinese (Simplified)',
    nativeName: '简体中文',
    official: true,
  },
  {
    code: 'zh-Hant',
    englishName: 'Chinese (Traditional)',
    nativeName: '繁體中文',
    official: true,
  },
  {
    code: 'hr',
    englishName: 'Croatian',
    nativeName: 'Hrvatski',
    official: true,
  },
  { code: 'cs', englishName: 'Czech', nativeName: 'Čeština', official: true },
  { code: 'da', englishName: 'Danish', nativeName: 'Dansk', official: true },
  {
    code: 'nl',
    englishName: 'Dutch',
    nativeName: 'Nederlands',
    official: true,
  },
  { code: 'en', englishName: 'English', nativeName: 'English', official: true },
  { code: 'et', englishName: 'Estonian', nativeName: 'Eesti', official: true },
  {
    code: 'fo',
    englishName: 'Faroese',
    nativeName: 'Føroyskt',
    official: true,
  },
  {
    code: 'fj',
    englishName: 'Fijian',
    nativeName: 'Vosa Vakaviti',
    official: true,
  },
  {
    code: 'fil',
    englishName: 'Filipino',
    nativeName: 'Filipino',
    official: true,
  },
  { code: 'fi', englishName: 'Finnish', nativeName: 'Suomi', official: true },
  { code: 'fr', englishName: 'French', nativeName: 'Français', official: true },
  {
    code: 'fr-ca',
    englishName: 'French (Canada)',
    nativeName: 'Français (Canada)',
    official: true,
  },
  { code: 'gl', englishName: 'Galician', nativeName: 'Galego', official: true },
  { code: 'de', englishName: 'German', nativeName: 'Deutsch', official: true },
  {
    code: 'ht',
    englishName: 'Haitian Creole',
    nativeName: 'Kreyòl Ayisyen',
    official: true,
  },
  { code: 'hi', englishName: 'Hindi', nativeName: 'हिन्दी', official: true },
  {
    code: 'mww',
    englishName: 'Hmong Daw',
    nativeName: 'Hmoob Daw',
    official: true,
  },
  {
    code: 'hu',
    englishName: 'Hungarian',
    nativeName: 'Magyar',
    official: true,
  },
  {
    code: 'is',
    englishName: 'Icelandic',
    nativeName: 'Íslenska',
    official: true,
  },
  {
    code: 'id',
    englishName: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    official: true,
  },
  {
    code: 'ia',
    englishName: 'Interlingua',
    nativeName: 'Interlingua',
    official: true,
  },
  {
    code: 'ikt',
    englishName: 'Inuinnaqtun',
    nativeName: 'Inuinnaqtun',
    official: true,
  },
  {
    code: 'iu-Latn',
    englishName: 'Inuktitut (Latin)',
    nativeName: 'Inuktitut',
    official: true,
  },
  { code: 'ga', englishName: 'Irish', nativeName: 'Gaeilge', official: true },
  {
    code: 'it',
    englishName: 'Italian',
    nativeName: 'Italiano',
    official: true,
  },
  { code: 'ja', englishName: 'Japanese', nativeName: '日本語', official: true },
  { code: 'kn', englishName: 'Kannada', nativeName: 'ಕನ್ನಡ', official: true },
  { code: 'kk', englishName: 'Kazakh', nativeName: 'Қазақ', official: true },
  { code: 'ko', englishName: 'Korean', nativeName: '한국어', official: true },
  {
    code: 'ku-latn',
    englishName: 'Kurdish (Latin)',
    nativeName: 'Kurdî',
    official: true,
  },
  { code: 'ky', englishName: 'Kyrgyz', nativeName: 'Кыргызча', official: true },
  {
    code: 'lv',
    englishName: 'Latvian',
    nativeName: 'Latviešu',
    official: true,
  },
  {
    code: 'lt',
    englishName: 'Lithuanian',
    nativeName: 'Lietuvių',
    official: true,
  },
  {
    code: 'mk',
    englishName: 'Macedonian',
    nativeName: 'Македонски',
    official: true,
  },
  {
    code: 'mg',
    englishName: 'Malagasy',
    nativeName: 'Malagasy',
    official: true,
  },
  {
    code: 'ms',
    englishName: 'Malay',
    nativeName: 'Bahasa Melayu',
    official: true,
  },
  {
    code: 'ml',
    englishName: 'Malayalam',
    nativeName: 'മലയാളം',
    official: true,
  },
  { code: 'mt', englishName: 'Maltese', nativeName: 'Malti', official: true },
  {
    code: 'mi',
    englishName: 'Maori',
    nativeName: 'Te Reo Māori',
    official: true,
  },
  { code: 'mr', englishName: 'Marathi', nativeName: 'मराठी', official: true },
  {
    code: 'mn-Cyrl',
    englishName: 'Mongolian',
    nativeName: 'Монгол',
    official: true,
  },
  { code: 'ne', englishName: 'Nepali', nativeName: 'नेपाली', official: true },
  {
    code: 'nb',
    englishName: 'Norwegian',
    nativeName: 'Norsk Bokmål',
    official: true,
  },
  { code: 'pl', englishName: 'Polish', nativeName: 'Polski', official: true },
  {
    code: 'pt',
    englishName: 'Portuguese (Brazil)',
    nativeName: 'Português (Brasil)',
    official: true,
  },
  {
    code: 'pt-pt',
    englishName: 'Portuguese (Portugal)',
    nativeName: 'Português (Portugal)',
    official: true,
  },
  { code: 'pa', englishName: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', official: true },
  {
    code: 'otq',
    englishName: 'Queretaro Otomi',
    nativeName: 'Hñähñu',
    official: true,
  },
  { code: 'ro', englishName: 'Romanian', nativeName: 'Română', official: true },
  { code: 'ru', englishName: 'Russian', nativeName: 'Русский', official: true },
  {
    code: 'sm',
    englishName: 'Samoan',
    nativeName: 'Gagana Sāmoa',
    official: true,
  },
  {
    code: 'sr-Cyrl',
    englishName: 'Serbian (Cyrillic)',
    nativeName: 'Српски',
    official: true,
  },
  {
    code: 'sr-Latn',
    englishName: 'Serbian (Latin)',
    nativeName: 'Srpski',
    official: true,
  },
  {
    code: 'sk',
    englishName: 'Slovak',
    nativeName: 'Slovenčina',
    official: true,
  },
  {
    code: 'sl',
    englishName: 'Slovenian',
    nativeName: 'Slovenščina',
    official: true,
  },
  { code: 'so', englishName: 'Somali', nativeName: 'Soomaali', official: true },
  { code: 'es', englishName: 'Spanish', nativeName: 'Español', official: true },
  {
    code: 'sw',
    englishName: 'Swahili',
    nativeName: 'Kiswahili',
    official: true,
  },
  { code: 'sv', englishName: 'Swedish', nativeName: 'Svenska', official: true },
  {
    code: 'ty',
    englishName: 'Tahitian',
    nativeName: 'Reo Tahiti',
    official: true,
  },
  { code: 'ta', englishName: 'Tamil', nativeName: 'தமிழ்', official: true },
  { code: 'tt', englishName: 'Tatar', nativeName: 'Татар', official: true },
  { code: 'te', englishName: 'Telugu', nativeName: 'తెలుగు', official: true },
  {
    code: 'to',
    englishName: 'Tongan',
    nativeName: 'Lea Fakatonga',
    official: true,
  },
  { code: 'tr', englishName: 'Turkish', nativeName: 'Türkçe', official: true },
  { code: 'tk', englishName: 'Turkmen', nativeName: 'Türkmen', official: true },
  {
    code: 'uk',
    englishName: 'Ukrainian',
    nativeName: 'Українська',
    official: true,
  },
  {
    code: 'hsb',
    englishName: 'Upper Sorbian',
    nativeName: 'Hornjoserbšćina',
    official: true,
  },
  { code: 'uz', englishName: 'Uzbek', nativeName: "O'zbek", official: true },
  {
    code: 'vi',
    englishName: 'Vietnamese',
    nativeName: 'Tiếng Việt',
    official: true,
  },
  { code: 'cy', englishName: 'Welsh', nativeName: 'Cymraeg', official: true },
  {
    code: 'yua',
    englishName: 'Yucatec Maya',
    nativeName: "Màaya T'àan",
    official: true,
  },
  { code: 'zu', englishName: 'Zulu', nativeName: 'isiZulu', official: true },

  // Unofficial languages — accepted by Azure Translator but not formally
  // verified for quality. UI surfaces a warning to have results reviewed by a
  // fluent or native speaker. Cross-check codes against the current Azure
  // Translator language list before enabling new entries here.
  { code: 'am', englishName: 'Amharic', nativeName: 'አማርኛ', official: false },
  {
    code: 'hy',
    englishName: 'Armenian',
    nativeName: 'Հայերեն',
    official: false,
  },
  {
    code: 'as',
    englishName: 'Assamese',
    nativeName: 'অসমীয়া',
    official: false,
  },
  { code: 'bn', englishName: 'Bengali', nativeName: 'বাংলা', official: false },
  { code: 'my', englishName: 'Burmese', nativeName: 'မြန်မာ', official: false },
  { code: 'prs', englishName: 'Dari', nativeName: 'دری', official: false },
  { code: 'dv', englishName: 'Divehi', nativeName: 'ދިވެހި', official: false },
  {
    code: 'ka',
    englishName: 'Georgian',
    nativeName: 'ქართული',
    official: false,
  },
  { code: 'el', englishName: 'Greek', nativeName: 'Ελληνικά', official: false },
  {
    code: 'gu',
    englishName: 'Gujarati',
    nativeName: 'ગુજરાતી',
    official: false,
  },
  { code: 'ha', englishName: 'Hausa', nativeName: 'Hausa', official: false },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', official: false },
  { code: 'ig', englishName: 'Igbo', nativeName: 'Igbo', official: false },
  { code: 'km', englishName: 'Khmer', nativeName: 'ខ្មែរ', official: false },
  {
    code: 'rw',
    englishName: 'Kinyarwanda',
    nativeName: 'Kinyarwanda',
    official: false,
  },
  {
    code: 'ku',
    englishName: 'Kurdish (Central)',
    nativeName: 'کوردیی ناوەندی',
    official: false,
  },
  { code: 'lo', englishName: 'Lao', nativeName: 'ລາວ', official: false },
  {
    code: 'mn-Mong',
    englishName: 'Mongolian (Traditional)',
    nativeName: 'ᠮᠣᠩᠭᠣᠯ',
    official: false,
  },
  {
    code: 'ny',
    englishName: 'Nyanja',
    nativeName: 'Chichewa',
    official: false,
  },
  { code: 'or', englishName: 'Odia', nativeName: 'ଓଡ଼ିଆ', official: false },
  { code: 'ps', englishName: 'Pashto', nativeName: 'پښتو', official: false },
  { code: 'fa', englishName: 'Persian', nativeName: 'فارسی', official: false },
  {
    code: 'st',
    englishName: 'Sesotho',
    nativeName: 'Sesotho',
    official: false,
  },
  { code: 'sn', englishName: 'Shona', nativeName: 'chiShona', official: false },
  { code: 'sd', englishName: 'Sindhi', nativeName: 'سنڌي', official: false },
  { code: 'si', englishName: 'Sinhala', nativeName: 'සිංහල', official: false },
  { code: 'tg', englishName: 'Tajik', nativeName: 'Тоҷикӣ', official: false },
  { code: 'th', englishName: 'Thai', nativeName: 'ไทย', official: false },
  { code: 'ti', englishName: 'Tigrinya', nativeName: 'ትግርኛ', official: false },
  {
    code: 'tn',
    englishName: 'Tswana',
    nativeName: 'Setswana',
    official: false,
  },
  { code: 'ur', englishName: 'Urdu', nativeName: 'اردو', official: false },
  {
    code: 'ug',
    englishName: 'Uyghur',
    nativeName: 'ئۇيغۇرچە',
    official: false,
  },
  { code: 'xh', englishName: 'Xhosa', nativeName: 'isiXhosa', official: false },
  { code: 'yo', englishName: 'Yoruba', nativeName: 'Yorùbá', official: false },
];

/**
 * Looks up a language by its code.
 *
 * @param code - The language code to look up
 * @returns The language object or undefined if not found
 */
export function getDocumentTranslationLanguageByCode(
  code: string,
): DocumentTranslationLanguage | undefined {
  return DOCUMENT_TRANSLATION_LANGUAGES.find(
    (lang) => lang.code.toLowerCase() === code.toLowerCase(),
  );
}

/**
 * Returns true if the code maps to an officially supported language.
 * Unknown codes return false.
 *
 * @param code - The language code to check
 */
export function isOfficiallySupportedDocumentTranslationLanguage(
  code: string,
): boolean {
  return getDocumentTranslationLanguageByCode(code)?.official ?? false;
}

/**
 * Gets the localized name of a language using the browser's Intl.DisplayNames API.
 * Falls back to empty string if the API is unavailable or the code is invalid.
 *
 * @param code - The ISO language code
 * @param locale - The locale to display the language name in
 * @returns The localized language name or empty string
 */
export function getLocalizedLanguageName(code: string, locale: string): string {
  try {
    const displayNames = new Intl.DisplayNames([locale], { type: 'language' });
    return displayNames.of(code) || '';
  } catch {
    return '';
  }
}

/**
 * Searches languages by name (English, native, localized, or ISO code).
 *
 * @param query - Search query string
 * @param locale - Optional locale for searching by localized language names
 * @returns Array of matching languages
 */
export function searchDocumentTranslationLanguages(
  query: string,
  locale?: string,
): DocumentTranslationLanguage[] {
  const lowerQuery = query.toLowerCase();
  return DOCUMENT_TRANSLATION_LANGUAGES.filter((lang) => {
    // Check English name, native name, and ISO code
    if (
      lang.englishName.toLowerCase().includes(lowerQuery) ||
      lang.nativeName.toLowerCase().includes(lowerQuery) ||
      lang.code.toLowerCase().includes(lowerQuery)
    ) {
      return true;
    }

    // Check localized name if locale is provided
    if (locale) {
      const localizedName = getLocalizedLanguageName(lang.code, locale);
      if (localizedName && localizedName.toLowerCase().includes(lowerQuery)) {
        return true;
      }
    }

    return false;
  });
}

/**
 * Gets the display name for a language (native name with English fallback).
 *
 * @param code - The language code
 * @returns Display name string
 */
export function getLanguageDisplayName(code: string): string {
  const lang = getDocumentTranslationLanguageByCode(code);
  if (!lang) return code;
  return lang.nativeName !== lang.englishName
    ? `${lang.nativeName} (${lang.englishName})`
    : lang.englishName;
}

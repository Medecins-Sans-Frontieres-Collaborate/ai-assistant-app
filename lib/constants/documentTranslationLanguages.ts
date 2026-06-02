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
import { normalizeForSearch } from '@/lib/utils/shared/string/normalizeDiacritics';

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
   * Alternate or common English names this language is also known by (e.g.
   * "Farsi" for Persian, "Mandarin" for Chinese). Used to broaden search
   * matching; not displayed in the UI.
   */
  aliases?: string[];

  /**
   * Whether the language is officially supported and quality-verified.
   * Unofficial languages are accepted by Azure Translator but the UI surfaces
   * a warning advising review by a fluent or native speaker.
   */
  officiallySupported: boolean;
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
    officiallySupported: true,
  },
  {
    code: 'sq',
    englishName: 'Albanian',
    nativeName: 'Shqip',
    officiallySupported: true,
  },
  {
    code: 'ar',
    englishName: 'Arabic',
    nativeName: 'العربية',
    officiallySupported: true,
  },
  {
    code: 'az',
    englishName: 'Azerbaijani',
    nativeName: 'Azərbaycan',
    officiallySupported: true,
  },
  {
    code: 'ba',
    englishName: 'Bashkir',
    nativeName: 'Башҡорт',
    officiallySupported: true,
  },
  {
    code: 'eu',
    englishName: 'Basque',
    nativeName: 'Euskara',
    officiallySupported: true,
  },
  {
    code: 'bs',
    englishName: 'Bosnian',
    nativeName: 'Bosanski',
    officiallySupported: true,
  },
  {
    code: 'bg',
    englishName: 'Bulgarian',
    nativeName: 'Български',
    officiallySupported: true,
  },
  {
    code: 'yue',
    englishName: 'Cantonese (Traditional)',
    nativeName: '粵語',
    officiallySupported: true,
  },
  {
    code: 'ca',
    englishName: 'Catalan',
    nativeName: 'Català',
    officiallySupported: true,
  },
  {
    code: 'lzh',
    englishName: 'Chinese (Literary)',
    aliases: ['Classical Chinese', 'Wenyan'],
    nativeName: '文言文',
    officiallySupported: true,
  },
  {
    code: 'zh-Hans',
    englishName: 'Chinese (Simplified)',
    aliases: ['Mandarin', 'Simplified Chinese', 'Putonghua'],
    nativeName: '简体中文',
    officiallySupported: true,
  },
  {
    code: 'zh-Hant',
    englishName: 'Chinese (Traditional)',
    aliases: ['Traditional Chinese', 'Mandarin'],
    nativeName: '繁體中文',
    officiallySupported: true,
  },
  {
    code: 'hr',
    englishName: 'Croatian',
    nativeName: 'Hrvatski',
    officiallySupported: true,
  },
  {
    code: 'cs',
    englishName: 'Czech',
    nativeName: 'Čeština',
    officiallySupported: true,
  },
  {
    code: 'da',
    englishName: 'Danish',
    nativeName: 'Dansk',
    officiallySupported: true,
  },
  {
    code: 'nl',
    englishName: 'Dutch',
    aliases: ['Flemish'],
    nativeName: 'Nederlands',
    officiallySupported: true,
  },
  {
    code: 'en',
    englishName: 'English',
    nativeName: 'English',
    officiallySupported: true,
  },
  {
    code: 'et',
    englishName: 'Estonian',
    nativeName: 'Eesti',
    officiallySupported: true,
  },
  {
    code: 'fo',
    englishName: 'Faroese',
    nativeName: 'Føroyskt',
    officiallySupported: true,
  },
  {
    code: 'fj',
    englishName: 'Fijian',
    nativeName: 'Vosa Vakaviti',
    officiallySupported: true,
  },
  {
    code: 'fil',
    englishName: 'Filipino',
    aliases: ['Tagalog'],
    nativeName: 'Filipino',
    officiallySupported: true,
  },
  {
    code: 'fi',
    englishName: 'Finnish',
    nativeName: 'Suomi',
    officiallySupported: true,
  },
  {
    code: 'fr',
    englishName: 'French',
    nativeName: 'Français',
    officiallySupported: true,
  },
  {
    code: 'fr-ca',
    englishName: 'French (Canada)',
    nativeName: 'Français (Canada)',
    officiallySupported: true,
  },
  {
    code: 'gl',
    englishName: 'Galician',
    nativeName: 'Galego',
    officiallySupported: true,
  },
  {
    code: 'de',
    englishName: 'German',
    nativeName: 'Deutsch',
    officiallySupported: true,
  },
  {
    code: 'ht',
    englishName: 'Haitian Creole',
    nativeName: 'Kreyòl Ayisyen',
    officiallySupported: true,
  },
  {
    code: 'hi',
    englishName: 'Hindi',
    nativeName: 'हिन्दी',
    officiallySupported: true,
  },
  {
    code: 'mww',
    englishName: 'Hmong Daw',
    nativeName: 'Hmoob Daw',
    officiallySupported: true,
  },
  {
    code: 'hu',
    englishName: 'Hungarian',
    nativeName: 'Magyar',
    officiallySupported: true,
  },
  {
    code: 'is',
    englishName: 'Icelandic',
    nativeName: 'Íslenska',
    officiallySupported: true,
  },
  {
    code: 'id',
    englishName: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    officiallySupported: true,
  },
  {
    code: 'ia',
    englishName: 'Interlingua',
    nativeName: 'Interlingua',
    officiallySupported: true,
  },
  {
    code: 'ikt',
    englishName: 'Inuinnaqtun',
    nativeName: 'Inuinnaqtun',
    officiallySupported: true,
  },
  {
    code: 'iu-Latn',
    englishName: 'Inuktitut (Latin)',
    nativeName: 'Inuktitut',
    officiallySupported: true,
  },
  {
    code: 'ga',
    englishName: 'Irish',
    nativeName: 'Gaeilge',
    officiallySupported: true,
  },
  {
    code: 'it',
    englishName: 'Italian',
    nativeName: 'Italiano',
    officiallySupported: true,
  },
  {
    code: 'ja',
    englishName: 'Japanese',
    nativeName: '日本語',
    officiallySupported: true,
  },
  {
    code: 'kn',
    englishName: 'Kannada',
    nativeName: 'ಕನ್ನಡ',
    officiallySupported: true,
  },
  {
    code: 'kk',
    englishName: 'Kazakh',
    nativeName: 'Қазақ',
    officiallySupported: true,
  },
  {
    code: 'ko',
    englishName: 'Korean',
    nativeName: '한국어',
    officiallySupported: true,
  },
  {
    code: 'ku-latn',
    englishName: 'Kurdish (Latin)',
    aliases: ['Kurmanji'],
    nativeName: 'Kurdî',
    officiallySupported: true,
  },
  {
    code: 'ky',
    englishName: 'Kyrgyz',
    nativeName: 'Кыргызча',
    officiallySupported: true,
  },
  {
    code: 'lv',
    englishName: 'Latvian',
    nativeName: 'Latviešu',
    officiallySupported: true,
  },
  {
    code: 'lt',
    englishName: 'Lithuanian',
    nativeName: 'Lietuvių',
    officiallySupported: true,
  },
  {
    code: 'mk',
    englishName: 'Macedonian',
    nativeName: 'Македонски',
    officiallySupported: true,
  },
  {
    code: 'mg',
    englishName: 'Malagasy',
    nativeName: 'Malagasy',
    officiallySupported: true,
  },
  {
    code: 'ms',
    englishName: 'Malay',
    nativeName: 'Bahasa Melayu',
    officiallySupported: true,
  },
  {
    code: 'ml',
    englishName: 'Malayalam',
    nativeName: 'മലയാളം',
    officiallySupported: true,
  },
  {
    code: 'mt',
    englishName: 'Maltese',
    nativeName: 'Malti',
    officiallySupported: true,
  },
  {
    code: 'mi',
    englishName: 'Maori',
    nativeName: 'Te Reo Māori',
    officiallySupported: true,
  },
  {
    code: 'mr',
    englishName: 'Marathi',
    nativeName: 'मराठी',
    officiallySupported: true,
  },
  {
    code: 'mn-Cyrl',
    englishName: 'Mongolian',
    nativeName: 'Монгол',
    officiallySupported: true,
  },
  {
    code: 'ne',
    englishName: 'Nepali',
    nativeName: 'नेपाली',
    officiallySupported: true,
  },
  {
    code: 'nb',
    englishName: 'Norwegian',
    aliases: ['Bokmål', 'Norwegian Bokmål'],
    nativeName: 'Norsk Bokmål',
    officiallySupported: true,
  },
  {
    code: 'pl',
    englishName: 'Polish',
    nativeName: 'Polski',
    officiallySupported: true,
  },
  {
    code: 'pt',
    englishName: 'Portuguese (Brazil)',
    aliases: ['Brazilian Portuguese'],
    nativeName: 'Português (Brasil)',
    officiallySupported: true,
  },
  {
    code: 'pt-pt',
    englishName: 'Portuguese (Portugal)',
    aliases: ['European Portuguese'],
    nativeName: 'Português (Portugal)',
    officiallySupported: true,
  },
  {
    code: 'pa',
    englishName: 'Punjabi',
    aliases: ['Panjabi'],
    nativeName: 'ਪੰਜਾਬੀ',
    officiallySupported: true,
  },
  {
    code: 'otq',
    englishName: 'Queretaro Otomi',
    nativeName: 'Hñähñu',
    officiallySupported: true,
  },
  {
    code: 'ro',
    englishName: 'Romanian',
    nativeName: 'Română',
    officiallySupported: true,
  },
  {
    code: 'ru',
    englishName: 'Russian',
    nativeName: 'Русский',
    officiallySupported: true,
  },
  {
    code: 'sm',
    englishName: 'Samoan',
    nativeName: 'Gagana Sāmoa',
    officiallySupported: true,
  },
  {
    code: 'sr-Cyrl',
    englishName: 'Serbian (Cyrillic)',
    nativeName: 'Српски',
    officiallySupported: true,
  },
  {
    code: 'sr-Latn',
    englishName: 'Serbian (Latin)',
    nativeName: 'Srpski',
    officiallySupported: true,
  },
  {
    code: 'sk',
    englishName: 'Slovak',
    nativeName: 'Slovenčina',
    officiallySupported: true,
  },
  {
    code: 'sl',
    englishName: 'Slovenian',
    nativeName: 'Slovenščina',
    officiallySupported: true,
  },
  {
    code: 'so',
    englishName: 'Somali',
    nativeName: 'Soomaali',
    officiallySupported: true,
  },
  {
    code: 'es',
    englishName: 'Spanish',
    aliases: ['Castilian'],
    nativeName: 'Español',
    officiallySupported: true,
  },
  {
    code: 'sw',
    englishName: 'Swahili',
    nativeName: 'Kiswahili',
    officiallySupported: true,
  },
  {
    code: 'sv',
    englishName: 'Swedish',
    nativeName: 'Svenska',
    officiallySupported: true,
  },
  {
    code: 'ty',
    englishName: 'Tahitian',
    nativeName: 'Reo Tahiti',
    officiallySupported: true,
  },
  {
    code: 'ta',
    englishName: 'Tamil',
    nativeName: 'தமிழ்',
    officiallySupported: true,
  },
  {
    code: 'tt',
    englishName: 'Tatar',
    nativeName: 'Татар',
    officiallySupported: true,
  },
  {
    code: 'te',
    englishName: 'Telugu',
    nativeName: 'తెలుగు',
    officiallySupported: true,
  },
  {
    code: 'to',
    englishName: 'Tongan',
    nativeName: 'Lea Fakatonga',
    officiallySupported: true,
  },
  {
    code: 'tr',
    englishName: 'Turkish',
    nativeName: 'Türkçe',
    officiallySupported: true,
  },
  {
    code: 'tk',
    englishName: 'Turkmen',
    nativeName: 'Türkmen',
    officiallySupported: true,
  },
  {
    code: 'uk',
    englishName: 'Ukrainian',
    nativeName: 'Українська',
    officiallySupported: true,
  },
  {
    code: 'hsb',
    englishName: 'Upper Sorbian',
    nativeName: 'Hornjoserbšćina',
    officiallySupported: true,
  },
  {
    code: 'uz',
    englishName: 'Uzbek',
    nativeName: "O'zbek",
    officiallySupported: true,
  },
  {
    code: 'vi',
    englishName: 'Vietnamese',
    nativeName: 'Tiếng Việt',
    officiallySupported: true,
  },
  {
    code: 'cy',
    englishName: 'Welsh',
    nativeName: 'Cymraeg',
    officiallySupported: true,
  },
  {
    code: 'yua',
    englishName: 'Yucatec Maya',
    nativeName: "Màaya T'àan",
    officiallySupported: true,
  },
  {
    code: 'zu',
    englishName: 'Zulu',
    nativeName: 'isiZulu',
    officiallySupported: true,
  },

  // Unofficial languages — accepted by Azure Translator but not formally
  // verified for quality. UI surfaces a warning to have results reviewed by a
  // fluent or native speaker. Cross-check codes against the current Azure
  // Translator language list before enabling new entries here.
  {
    code: 'am',
    englishName: 'Amharic',
    nativeName: 'አማርኛ',
    officiallySupported: false,
  },
  {
    code: 'hy',
    englishName: 'Armenian',
    nativeName: 'Հայերեն',
    officiallySupported: false,
  },
  {
    code: 'as',
    englishName: 'Assamese',
    nativeName: 'অসমীয়া',
    officiallySupported: false,
  },
  {
    code: 'bn',
    englishName: 'Bengali',
    aliases: ['Bangla'],
    nativeName: 'বাংলা',
    officiallySupported: false,
  },
  {
    code: 'my',
    englishName: 'Burmese',
    aliases: ['Myanmar'],
    nativeName: 'မြန်မာ',
    officiallySupported: false,
  },
  {
    code: 'prs',
    englishName: 'Dari',
    aliases: ['Afghan Persian'],
    nativeName: 'دری',
    officiallySupported: false,
  },
  {
    code: 'dv',
    englishName: 'Divehi',
    nativeName: 'ދިވެހި',
    officiallySupported: false,
  },
  {
    code: 'ka',
    englishName: 'Georgian',
    nativeName: 'ქართული',
    officiallySupported: false,
  },
  {
    code: 'el',
    englishName: 'Greek',
    aliases: ['Hellenic'],
    nativeName: 'Ελληνικά',
    officiallySupported: false,
  },
  {
    code: 'gu',
    englishName: 'Gujarati',
    nativeName: 'ગુજરાતી',
    officiallySupported: false,
  },
  {
    code: 'ha',
    englishName: 'Hausa',
    nativeName: 'Hausa',
    officiallySupported: false,
  },
  {
    code: 'he',
    englishName: 'Hebrew',
    nativeName: 'עברית',
    officiallySupported: false,
  },
  {
    code: 'ig',
    englishName: 'Igbo',
    nativeName: 'Igbo',
    officiallySupported: false,
  },
  {
    code: 'km',
    englishName: 'Khmer',
    aliases: ['Cambodian'],
    nativeName: 'ខ្មែរ',
    officiallySupported: false,
  },
  {
    code: 'rw',
    englishName: 'Kinyarwanda',
    nativeName: 'Kinyarwanda',
    officiallySupported: false,
  },
  {
    code: 'ku',
    englishName: 'Kurdish (Central)',
    aliases: ['Sorani'],
    nativeName: 'کوردیی ناوەندی',
    officiallySupported: false,
  },
  {
    code: 'lo',
    englishName: 'Lao',
    nativeName: 'ລາວ',
    officiallySupported: false,
  },
  {
    code: 'mn-Mong',
    englishName: 'Mongolian (Traditional)',
    nativeName: 'ᠮᠣᠩᠭᠣᠯ',
    officiallySupported: false,
  },
  {
    code: 'ny',
    englishName: 'Nyanja',
    nativeName: 'Chichewa',
    officiallySupported: false,
  },
  {
    code: 'or',
    englishName: 'Odia',
    aliases: ['Oriya'],
    nativeName: 'ଓଡ଼ିଆ',
    officiallySupported: false,
  },
  {
    code: 'ps',
    englishName: 'Pashto',
    nativeName: 'پښتو',
    officiallySupported: false,
  },
  {
    code: 'fa',
    englishName: 'Persian',
    aliases: ['Farsi'],
    nativeName: 'فارسی',
    officiallySupported: false,
  },
  {
    code: 'st',
    englishName: 'Sesotho',
    nativeName: 'Sesotho',
    officiallySupported: false,
  },
  {
    code: 'sn',
    englishName: 'Shona',
    nativeName: 'chiShona',
    officiallySupported: false,
  },
  {
    code: 'sd',
    englishName: 'Sindhi',
    nativeName: 'سنڌي',
    officiallySupported: false,
  },
  {
    code: 'si',
    englishName: 'Sinhala',
    aliases: ['Sinhalese'],
    nativeName: 'සිංහල',
    officiallySupported: false,
  },
  {
    code: 'tg',
    englishName: 'Tajik',
    nativeName: 'Тоҷикӣ',
    officiallySupported: false,
  },
  {
    code: 'th',
    englishName: 'Thai',
    nativeName: 'ไทย',
    officiallySupported: false,
  },
  {
    code: 'ti',
    englishName: 'Tigrinya',
    nativeName: 'ትግርኛ',
    officiallySupported: false,
  },
  {
    code: 'tn',
    englishName: 'Tswana',
    nativeName: 'Setswana',
    officiallySupported: false,
  },
  {
    code: 'ur',
    englishName: 'Urdu',
    nativeName: 'اردو',
    officiallySupported: false,
  },
  {
    code: 'ug',
    englishName: 'Uyghur',
    nativeName: 'ئۇيغۇرچە',
    officiallySupported: false,
  },
  {
    code: 'xh',
    englishName: 'Xhosa',
    nativeName: 'isiXhosa',
    officiallySupported: false,
  },
  {
    code: 'yo',
    englishName: 'Yoruba',
    nativeName: 'Yorùbá',
    officiallySupported: false,
  },
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
  return (
    getDocumentTranslationLanguageByCode(code)?.officiallySupported ?? false
  );
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
 * Searches languages by name (English, native, alternate/common, localized, or
 * ISO code). Matching is case- and accent-insensitive, so "espanol" matches
 * "Español" and "farsi" matches Persian's "Farsi" alias.
 *
 * @param query - Search query string
 * @param locale - Optional locale for searching by localized language names
 * @returns Array of matching languages
 */
export function searchDocumentTranslationLanguages(
  query: string,
  locale?: string,
): DocumentTranslationLanguage[] {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return DOCUMENT_TRANSLATION_LANGUAGES;

  // Build a single DisplayNames instance per call rather than one per language.
  let displayNames: Intl.DisplayNames | undefined;
  if (locale) {
    try {
      displayNames = new Intl.DisplayNames([locale], { type: 'language' });
    } catch {
      displayNames = undefined;
    }
  }

  return DOCUMENT_TRANSLATION_LANGUAGES.filter((lang) => {
    // Check English name, native name, alternate names, and ISO code.
    if (
      normalizeForSearch(lang.englishName).includes(normalizedQuery) ||
      normalizeForSearch(lang.nativeName).includes(normalizedQuery) ||
      normalizeForSearch(lang.code).includes(normalizedQuery) ||
      lang.aliases?.some((alias) =>
        normalizeForSearch(alias).includes(normalizedQuery),
      )
    ) {
      return true;
    }

    // Check the name as localized to the user's locale.
    if (displayNames) {
      const localizedName = displayNames.of(lang.code) || '';
      if (
        localizedName &&
        normalizeForSearch(localizedName).includes(normalizedQuery)
      ) {
        return true;
      }
    }

    return false;
  });
}

/**
 * Builds the secondary label shown alongside a language's autonym — the name in
 * the user's locale when available, falling back to the English name. Returns an
 * empty string when it would merely duplicate the autonym.
 *
 * @param lang - The language entry
 * @param locale - Optional UI locale to localize the name into
 * @returns The secondary label, or empty string if redundant with the autonym
 */
export function getSecondaryLanguageLabel(
  lang: DocumentTranslationLanguage,
  locale?: string,
): string {
  const localized = locale ? getLocalizedLanguageName(lang.code, locale) : '';
  const secondary = localized || lang.englishName;
  return secondary.toLowerCase() === lang.nativeName.toLowerCase()
    ? ''
    : secondary;
}

/**
 * Gets the display name for a language (autonym with a localized/English
 * secondary name in parentheses when it adds information).
 *
 * @param code - The language code
 * @param locale - Optional UI locale to localize the secondary name into
 * @returns Display name string
 */
export function getLanguageDisplayName(code: string, locale?: string): string {
  const lang = getDocumentTranslationLanguageByCode(code);
  if (!lang) return code;
  const secondary = getSecondaryLanguageLabel(lang, locale);
  return secondary ? `${lang.nativeName} (${secondary})` : lang.nativeName;
}

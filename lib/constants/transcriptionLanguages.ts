/**
 * Transcription Languages Configuration
 *
 * Centralized configuration for languages supported by Whisper transcription.
 * Includes official support status, i18n keys, and autonyms (native names).
 *
 * Official status preserves Azure's published Whisper list used by this app.
 * It is a documentation classification, not an accuracy guarantee.
 * Azure source: https://learn.microsoft.com/en-us/azure/ai-services/openai/whisper-quickstart
 * Baseline reviewed: 2026-10-15 (the current quickstart no longer lists languages).
 * Recognized codes are pinned to the original 99-language Whisper tokenizer:
 * https://github.com/openai/whisper/blob/v20230314/whisper/tokenizer.py
 * Tokenizer recognition does not guarantee Azure API acceptance or usable output.
 */

/**
 * Represents a language option for transcription.
 */
export interface TranscriptionLanguage {
  /** Whisper language token code, including `haw` and legacy `jw`; empty = auto-detect */
  code: string;
  /** i18n key for the localized language label */
  labelKey: string;
  /** Native name of the language (autonym) */
  autonym: string;
  /** Whether this language is in the app's Azure-documented support baseline */
  officiallySupported: boolean;
}

/**
 * List of languages available for Whisper transcription.
 * Sorted alphabetically by English name.
 *
 * Experimental options are model-recognized but outside the Azure baseline.
 */
export const TRANSCRIPTION_LANGUAGES: TranscriptionLanguage[] = [
  // Auto-detect option (always first)
  {
    code: '',
    labelKey: 'transcription.languages.autoDetect',
    autonym: '',
    officiallySupported: true,
  },

  // Official languages (57 total, alphabetically sorted)
  {
    code: 'af',
    labelKey: 'transcription.languages.afrikaans',
    autonym: 'Afrikaans',
    officiallySupported: true,
  },
  {
    code: 'ar',
    labelKey: 'transcription.languages.arabic',
    autonym: 'العربية',
    officiallySupported: true,
  },
  {
    code: 'hy',
    labelKey: 'transcription.languages.armenian',
    autonym: 'Հայերեն',
    officiallySupported: true,
  },
  {
    code: 'az',
    labelKey: 'transcription.languages.azerbaijani',
    autonym: 'Azərbaycan',
    officiallySupported: true,
  },
  {
    code: 'be',
    labelKey: 'transcription.languages.belarusian',
    autonym: 'Беларуская',
    officiallySupported: true,
  },
  {
    code: 'bs',
    labelKey: 'transcription.languages.bosnian',
    autonym: 'Bosanski',
    officiallySupported: true,
  },
  {
    code: 'bg',
    labelKey: 'transcription.languages.bulgarian',
    autonym: 'Български',
    officiallySupported: true,
  },
  {
    code: 'ca',
    labelKey: 'transcription.languages.catalan',
    autonym: 'Català',
    officiallySupported: true,
  },
  {
    code: 'zh',
    labelKey: 'transcription.languages.chinese',
    autonym: '中文',
    officiallySupported: true,
  },
  {
    code: 'hr',
    labelKey: 'transcription.languages.croatian',
    autonym: 'Hrvatski',
    officiallySupported: true,
  },
  {
    code: 'cs',
    labelKey: 'transcription.languages.czech',
    autonym: 'Čeština',
    officiallySupported: true,
  },
  {
    code: 'da',
    labelKey: 'transcription.languages.danish',
    autonym: 'Dansk',
    officiallySupported: true,
  },
  {
    code: 'nl',
    labelKey: 'transcription.languages.dutch',
    autonym: 'Nederlands',
    officiallySupported: true,
  },
  {
    code: 'en',
    labelKey: 'transcription.languages.english',
    autonym: 'English',
    officiallySupported: true,
  },
  {
    code: 'et',
    labelKey: 'transcription.languages.estonian',
    autonym: 'Eesti',
    officiallySupported: true,
  },
  {
    code: 'fi',
    labelKey: 'transcription.languages.finnish',
    autonym: 'Suomi',
    officiallySupported: true,
  },
  {
    code: 'fr',
    labelKey: 'transcription.languages.french',
    autonym: 'Français',
    officiallySupported: true,
  },
  {
    code: 'gl',
    labelKey: 'transcription.languages.galician',
    autonym: 'Galego',
    officiallySupported: true,
  },
  {
    code: 'de',
    labelKey: 'transcription.languages.german',
    autonym: 'Deutsch',
    officiallySupported: true,
  },
  {
    code: 'el',
    labelKey: 'transcription.languages.greek',
    autonym: 'Ελληνικά',
    officiallySupported: true,
  },
  {
    code: 'he',
    labelKey: 'transcription.languages.hebrew',
    autonym: 'עברית',
    officiallySupported: true,
  },
  {
    code: 'hi',
    labelKey: 'transcription.languages.hindi',
    autonym: 'हिन्दी',
    officiallySupported: true,
  },
  {
    code: 'hu',
    labelKey: 'transcription.languages.hungarian',
    autonym: 'Magyar',
    officiallySupported: true,
  },
  {
    code: 'is',
    labelKey: 'transcription.languages.icelandic',
    autonym: 'Íslenska',
    officiallySupported: true,
  },
  {
    code: 'id',
    labelKey: 'transcription.languages.indonesian',
    autonym: 'Bahasa Indonesia',
    officiallySupported: true,
  },
  {
    code: 'it',
    labelKey: 'transcription.languages.italian',
    autonym: 'Italiano',
    officiallySupported: true,
  },
  {
    code: 'ja',
    labelKey: 'transcription.languages.japanese',
    autonym: '日本語',
    officiallySupported: true,
  },
  {
    code: 'kn',
    labelKey: 'transcription.languages.kannada',
    autonym: 'ಕನ್ನಡ',
    officiallySupported: true,
  },
  {
    code: 'kk',
    labelKey: 'transcription.languages.kazakh',
    autonym: 'Қазақ',
    officiallySupported: true,
  },
  {
    code: 'ko',
    labelKey: 'transcription.languages.korean',
    autonym: '한국어',
    officiallySupported: true,
  },
  {
    code: 'lv',
    labelKey: 'transcription.languages.latvian',
    autonym: 'Latviešu',
    officiallySupported: true,
  },
  {
    code: 'lt',
    labelKey: 'transcription.languages.lithuanian',
    autonym: 'Lietuvių',
    officiallySupported: true,
  },
  {
    code: 'mk',
    labelKey: 'transcription.languages.macedonian',
    autonym: 'Македонски',
    officiallySupported: true,
  },
  {
    code: 'ms',
    labelKey: 'transcription.languages.malay',
    autonym: 'Bahasa Melayu',
    officiallySupported: true,
  },
  {
    code: 'mi',
    labelKey: 'transcription.languages.maori',
    autonym: 'Māori',
    officiallySupported: true,
  },
  {
    code: 'mr',
    labelKey: 'transcription.languages.marathi',
    autonym: 'मराठी',
    officiallySupported: true,
  },
  {
    code: 'ne',
    labelKey: 'transcription.languages.nepali',
    autonym: 'नेपाली',
    officiallySupported: true,
  },
  {
    code: 'no',
    labelKey: 'transcription.languages.norwegian',
    autonym: 'Norsk',
    officiallySupported: true,
  },
  {
    code: 'fa',
    labelKey: 'transcription.languages.persian',
    autonym: 'فارسی',
    officiallySupported: true,
  },
  {
    code: 'pl',
    labelKey: 'transcription.languages.polish',
    autonym: 'Polski',
    officiallySupported: true,
  },
  {
    code: 'pt',
    labelKey: 'transcription.languages.portuguese',
    autonym: 'Português',
    officiallySupported: true,
  },
  {
    code: 'ro',
    labelKey: 'transcription.languages.romanian',
    autonym: 'Română',
    officiallySupported: true,
  },
  {
    code: 'ru',
    labelKey: 'transcription.languages.russian',
    autonym: 'Русский',
    officiallySupported: true,
  },
  {
    code: 'sr',
    labelKey: 'transcription.languages.serbian',
    autonym: 'Српски',
    officiallySupported: true,
  },
  {
    code: 'sk',
    labelKey: 'transcription.languages.slovak',
    autonym: 'Slovenčina',
    officiallySupported: true,
  },
  {
    code: 'sl',
    labelKey: 'transcription.languages.slovenian',
    autonym: 'Slovenščina',
    officiallySupported: true,
  },
  {
    code: 'es',
    labelKey: 'transcription.languages.spanish',
    autonym: 'Español',
    officiallySupported: true,
  },
  {
    code: 'sw',
    labelKey: 'transcription.languages.swahili',
    autonym: 'Kiswahili',
    officiallySupported: true,
  },
  {
    code: 'sv',
    labelKey: 'transcription.languages.swedish',
    autonym: 'Svenska',
    officiallySupported: true,
  },
  {
    code: 'tl',
    labelKey: 'transcription.languages.tagalog',
    autonym: 'Tagalog',
    officiallySupported: true,
  },
  {
    code: 'ta',
    labelKey: 'transcription.languages.tamil',
    autonym: 'தமிழ்',
    officiallySupported: true,
  },
  {
    code: 'th',
    labelKey: 'transcription.languages.thai',
    autonym: 'ไทย',
    officiallySupported: true,
  },
  {
    code: 'tr',
    labelKey: 'transcription.languages.turkish',
    autonym: 'Türkçe',
    officiallySupported: true,
  },
  {
    code: 'uk',
    labelKey: 'transcription.languages.ukrainian',
    autonym: 'Українська',
    officiallySupported: true,
  },
  {
    code: 'ur',
    labelKey: 'transcription.languages.urdu',
    autonym: 'اردو',
    officiallySupported: true,
  },
  {
    code: 'vi',
    labelKey: 'transcription.languages.vietnamese',
    autonym: 'Tiếng Việt',
    officiallySupported: true,
  },
  {
    code: 'cy',
    labelKey: 'transcription.languages.welsh',
    autonym: 'Cymraeg',
    officiallySupported: true,
  },

  // Experimental languages, alphabetically sorted by English name.
  {
    code: 'sq',
    labelKey: 'transcription.languages.albanian',
    autonym: 'Shqip',
    officiallySupported: false,
  },
  {
    code: 'am',
    labelKey: 'transcription.languages.amharic',
    autonym: 'አማርኛ',
    officiallySupported: false,
  },
  {
    code: 'as',
    labelKey: 'transcription.languages.assamese',
    autonym: 'অসমীয়া',
    officiallySupported: false,
  },
  {
    code: 'ba',
    labelKey: 'transcription.languages.bashkir',
    autonym: 'Башҡортса',
    officiallySupported: false,
  },
  {
    code: 'eu',
    labelKey: 'transcription.languages.basque',
    autonym: 'Euskara',
    officiallySupported: false,
  },
  {
    code: 'bn',
    labelKey: 'transcription.languages.bengali',
    autonym: 'বাংলা',
    officiallySupported: false,
  },
  {
    code: 'br',
    labelKey: 'transcription.languages.breton',
    autonym: 'Brezhoneg',
    officiallySupported: false,
  },
  {
    code: 'my',
    labelKey: 'transcription.languages.burmese',
    autonym: 'မြန်မာ',
    officiallySupported: false,
  },
  {
    code: 'fo',
    labelKey: 'transcription.languages.faroese',
    autonym: 'Føroyskt',
    officiallySupported: false,
  },
  {
    code: 'ka',
    labelKey: 'transcription.languages.georgian',
    autonym: 'ქართული',
    officiallySupported: false,
  },
  {
    code: 'gu',
    labelKey: 'transcription.languages.gujarati',
    autonym: 'ગુજરાતી',
    officiallySupported: false,
  },
  {
    code: 'ht',
    labelKey: 'transcription.languages.haitianCreole',
    autonym: 'Kreyòl ayisyen',
    officiallySupported: false,
  },
  {
    code: 'ha',
    labelKey: 'transcription.languages.hausa',
    autonym: 'Hausa',
    officiallySupported: false,
  },
  {
    code: 'haw',
    labelKey: 'transcription.languages.hawaiian',
    autonym: 'ʻŌlelo Hawaiʻi',
    officiallySupported: false,
  },
  {
    code: 'jw',
    labelKey: 'transcription.languages.javanese',
    autonym: 'Basa Jawa',
    officiallySupported: false,
  },
  {
    code: 'km',
    labelKey: 'transcription.languages.khmer',
    autonym: 'ខ្មែរ',
    officiallySupported: false,
  },
  {
    code: 'lo',
    labelKey: 'transcription.languages.lao',
    autonym: 'ລາວ',
    officiallySupported: false,
  },
  {
    code: 'la',
    labelKey: 'transcription.languages.latin',
    autonym: 'Latina',
    officiallySupported: false,
  },
  {
    code: 'ln',
    labelKey: 'transcription.languages.lingala',
    autonym: 'Lingála',
    officiallySupported: false,
  },
  {
    code: 'lb',
    labelKey: 'transcription.languages.luxembourgish',
    autonym: 'Lëtzebuergesch',
    officiallySupported: false,
  },
  {
    code: 'mg',
    labelKey: 'transcription.languages.malagasy',
    autonym: 'Malagasy',
    officiallySupported: false,
  },
  {
    code: 'ml',
    labelKey: 'transcription.languages.malayalam',
    autonym: 'മലയാളം',
    officiallySupported: false,
  },
  {
    code: 'mt',
    labelKey: 'transcription.languages.maltese',
    autonym: 'Malti',
    officiallySupported: false,
  },
  {
    code: 'mn',
    labelKey: 'transcription.languages.mongolian',
    autonym: 'Монгол',
    officiallySupported: false,
  },
  {
    code: 'nn',
    labelKey: 'transcription.languages.norwegianNynorsk',
    autonym: 'Nynorsk',
    officiallySupported: false,
  },
  {
    code: 'oc',
    labelKey: 'transcription.languages.occitan',
    autonym: 'Occitan',
    officiallySupported: false,
  },
  {
    code: 'ps',
    labelKey: 'transcription.languages.pashto',
    autonym: 'پښتو',
    officiallySupported: false,
  },
  {
    code: 'pa',
    labelKey: 'transcription.languages.punjabi',
    autonym: 'ਪੰਜਾਬੀ',
    officiallySupported: false,
  },
  {
    code: 'sa',
    labelKey: 'transcription.languages.sanskrit',
    autonym: 'संस्कृतम्',
    officiallySupported: false,
  },
  {
    code: 'sn',
    labelKey: 'transcription.languages.shona',
    autonym: 'ChiShona',
    officiallySupported: false,
  },
  {
    code: 'sd',
    labelKey: 'transcription.languages.sindhi',
    autonym: 'سنڌي',
    officiallySupported: false,
  },
  {
    code: 'si',
    labelKey: 'transcription.languages.sinhala',
    autonym: 'සිංහල',
    officiallySupported: false,
  },
  {
    code: 'so',
    labelKey: 'transcription.languages.somali',
    autonym: 'Soomaali',
    officiallySupported: false,
  },
  {
    code: 'su',
    labelKey: 'transcription.languages.sundanese',
    autonym: 'Basa Sunda',
    officiallySupported: false,
  },
  {
    code: 'tg',
    labelKey: 'transcription.languages.tajik',
    autonym: 'Тоҷикӣ',
    officiallySupported: false,
  },
  {
    code: 'tt',
    labelKey: 'transcription.languages.tatar',
    autonym: 'Татарча',
    officiallySupported: false,
  },
  {
    code: 'te',
    labelKey: 'transcription.languages.telugu',
    autonym: 'తెలుగు',
    officiallySupported: false,
  },
  {
    code: 'bo',
    labelKey: 'transcription.languages.tibetan',
    autonym: 'བོད་སྐད་',
    officiallySupported: false,
  },
  {
    code: 'tk',
    labelKey: 'transcription.languages.turkmen',
    autonym: 'Türkmençe',
    officiallySupported: false,
  },
  {
    code: 'uz',
    labelKey: 'transcription.languages.uzbek',
    autonym: 'Oʻzbekcha',
    officiallySupported: false,
  },
  {
    code: 'yi',
    labelKey: 'transcription.languages.yiddish',
    autonym: 'ייִדיש',
    officiallySupported: false,
  },
  {
    code: 'yo',
    labelKey: 'transcription.languages.yoruba',
    autonym: 'Yorùbá',
    officiallySupported: false,
  },
];

/**
 * Helper to get a language by its code.
 *
 * @param code - Whisper language token code
 * @returns The language configuration or undefined if not found
 */
export function getTranscriptionLanguageByCode(
  code: string,
): TranscriptionLanguage | undefined {
  return TRANSCRIPTION_LANGUAGES.find((lang) => lang.code === code);
}

/**
 * Get all officially supported languages.
 *
 * @returns Array of officially supported transcription languages
 */
export function getOfficialTranscriptionLanguages(): TranscriptionLanguage[] {
  return TRANSCRIPTION_LANGUAGES.filter((lang) => lang.officiallySupported);
}

/**
 * Get all unofficially supported languages.
 *
 * @returns Array of unofficially supported transcription languages
 */
export function getUnofficialTranscriptionLanguages(): TranscriptionLanguage[] {
  return TRANSCRIPTION_LANGUAGES.filter((lang) => !lang.officiallySupported);
}

/** Snapshot of the requested language, kept separately from spoken transcript text. */
export interface TranscriptionLanguageMetadata {
  language: string;
  officiallySupported: boolean;
}

export function getTranscriptionLanguageMetadata(
  code?: string,
): TranscriptionLanguageMetadata | undefined {
  if (!code) return undefined; // Auto-detect is not a claim of official support.
  return {
    language: code,
    officiallySupported:
      getTranscriptionLanguageByCode(code)?.officiallySupported ?? false,
  };
}

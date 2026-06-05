/**
 * Transcription Languages Configuration
 *
 * Centralized configuration for languages supported by Whisper transcription.
 * Includes official support status, i18n keys, and autonyms (native names).
 *
 * Official Whisper languages are those with <50% word error rate (WER).
 * Source: https://platform.openai.com/docs/guides/speech-to-text#supported-languages
 */

/**
 * Represents a language option for transcription.
 */
export interface TranscriptionLanguage {
  /** ISO 639-1 language code (empty string for auto-detect) */
  code: string;
  /** i18n key for the localized language label */
  labelKey: string;
  /** Native name of the language (autonym) */
  autonym: string;
  /** Whether the language is officially supported by Whisper with <50% WER */
  officiallySupported: boolean;
}

/**
 * List of languages available for Whisper transcription.
 * Sorted alphabetically by English name.
 *
 * Official support is based on OpenAI's published list of languages
 * that exceeded the <50% word error rate threshold.
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
    autonym: 'Հdelays',
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

  // Unofficial languages (not in Whisper's official <50% WER list)
  {
    code: 'my',
    labelKey: 'transcription.languages.burmese',
    autonym: 'မြန်မာ',
    officiallySupported: false,
  },
];

/**
 * Helper to get a language by its code.
 *
 * @param code - ISO 639-1 language code
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

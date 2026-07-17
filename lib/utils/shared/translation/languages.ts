/**
 * Translation-target language catalog for the translation workflow.
 *
 * Deliberately independent of the app's UI locales: the UI ships in 53
 * languages, but the AI can translate into far more. This list is curated
 * for breadth with explicit coverage of languages relevant to MSF
 * operations (Pashto, Dari, Kurdish variants, Tigrinya, Rohingya, …).
 * Users can additionally add custom languages (settingsStore
 * `customLanguages`), which the picker flags as user-added.
 *
 * ids are ISO 639-1 where available, else ISO 639-3.
 */

export interface TranslationLanguage {
  id: string;
  /** English name (searchable). */
  name: string;
  /** Native name (displayed). */
  autonym: string;
}

export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
  { id: 'af', name: 'Afrikaans', autonym: 'Afrikaans' },
  { id: 'sq', name: 'Albanian', autonym: 'Shqip' },
  { id: 'am', name: 'Amharic', autonym: 'አማርኛ' },
  { id: 'ar', name: 'Arabic', autonym: 'العربية' },
  { id: 'hy', name: 'Armenian', autonym: 'Հայերեն' },
  { id: 'as', name: 'Assamese', autonym: 'অসমীয়া' },
  { id: 'az', name: 'Azerbaijani', autonym: 'Azərbaycanca' },
  { id: 'bm', name: 'Bambara', autonym: 'Bamanankan' },
  { id: 'eu', name: 'Basque', autonym: 'Euskara' },
  { id: 'be', name: 'Belarusian', autonym: 'Беларуская' },
  { id: 'bn', name: 'Bengali', autonym: 'বাংলা' },
  { id: 'bs', name: 'Bosnian', autonym: 'Bosanski' },
  { id: 'bg', name: 'Bulgarian', autonym: 'Български' },
  { id: 'my', name: 'Burmese', autonym: 'မြန်မာဘာသာ' },
  { id: 'ca', name: 'Catalan', autonym: 'Català' },
  { id: 'ceb', name: 'Cebuano', autonym: 'Sinugboanon' },
  { id: 'ny', name: 'Chichewa', autonym: 'Chichewa' },
  { id: 'zh', name: 'Chinese (Simplified)', autonym: '简体中文' },
  { id: 'zh-Hant', name: 'Chinese (Traditional)', autonym: '繁體中文' },
  { id: 'hr', name: 'Croatian', autonym: 'Hrvatski' },
  { id: 'cs', name: 'Czech', autonym: 'Čeština' },
  { id: 'da', name: 'Danish', autonym: 'Dansk' },
  { id: 'prs', name: 'Dari', autonym: 'دری' },
  { id: 'din', name: 'Dinka', autonym: 'Thuɔŋjäŋ' },
  { id: 'nl', name: 'Dutch', autonym: 'Nederlands' },
  { id: 'en', name: 'English', autonym: 'English' },
  { id: 'et', name: 'Estonian', autonym: 'Eesti' },
  { id: 'ee', name: 'Ewe', autonym: 'Eʋegbe' },
  { id: 'fi', name: 'Finnish', autonym: 'Suomi' },
  { id: 'fr', name: 'French', autonym: 'Français' },
  { id: 'ff', name: 'Fula', autonym: 'Fulfulde' },
  { id: 'ka', name: 'Georgian', autonym: 'ქართული' },
  { id: 'de', name: 'German', autonym: 'Deutsch' },
  { id: 'el', name: 'Greek', autonym: 'Ελληνικά' },
  { id: 'gu', name: 'Gujarati', autonym: 'ગુજરાતી' },
  { id: 'ht', name: 'Haitian Creole', autonym: 'Kreyòl ayisyen' },
  { id: 'ha', name: 'Hausa', autonym: 'Hausa' },
  { id: 'he', name: 'Hebrew', autonym: 'עברית' },
  { id: 'hi', name: 'Hindi', autonym: 'हिन्दी' },
  { id: 'hu', name: 'Hungarian', autonym: 'Magyar' },
  { id: 'is', name: 'Icelandic', autonym: 'Íslenska' },
  { id: 'ig', name: 'Igbo', autonym: 'Igbo' },
  { id: 'id', name: 'Indonesian', autonym: 'Bahasa Indonesia' },
  { id: 'it', name: 'Italian', autonym: 'Italiano' },
  { id: 'ja', name: 'Japanese', autonym: '日本語' },
  { id: 'jv', name: 'Javanese', autonym: 'Basa Jawa' },
  { id: 'kab', name: 'Kabyle', autonym: 'Taqbaylit' },
  { id: 'kn', name: 'Kannada', autonym: 'ಕನ್ನಡ' },
  { id: 'kr', name: 'Kanuri', autonym: 'Kanuri' },
  { id: 'kk', name: 'Kazakh', autonym: 'Қазақша' },
  { id: 'km', name: 'Khmer', autonym: 'ភាសាខ្មែរ' },
  { id: 'rw', name: 'Kinyarwanda', autonym: 'Ikinyarwanda' },
  { id: 'rn', name: 'Kirundi', autonym: 'Ikirundi' },
  { id: 'ko', name: 'Korean', autonym: '한국어' },
  { id: 'kmr', name: 'Kurdish (Kurmanji)', autonym: 'Kurmancî' },
  { id: 'ckb', name: 'Kurdish (Sorani)', autonym: 'سۆرانی' },
  { id: 'ky', name: 'Kyrgyz', autonym: 'Кыргызча' },
  { id: 'lo', name: 'Lao', autonym: 'ລາວ' },
  { id: 'lv', name: 'Latvian', autonym: 'Latviešu' },
  { id: 'ln', name: 'Lingala', autonym: 'Lingála' },
  { id: 'lt', name: 'Lithuanian', autonym: 'Lietuvių' },
  { id: 'luo', name: 'Luo', autonym: 'Dholuo' },
  { id: 'lg', name: 'Luganda', autonym: 'Luganda' },
  { id: 'mk', name: 'Macedonian', autonym: 'Македонски' },
  { id: 'mg', name: 'Malagasy', autonym: 'Malagasy' },
  { id: 'ms', name: 'Malay', autonym: 'Bahasa Melayu' },
  { id: 'ml', name: 'Malayalam', autonym: 'മലയാളം' },
  { id: 'mt', name: 'Maltese', autonym: 'Malti' },
  { id: 'mnk', name: 'Mandinka', autonym: 'Mandinka' },
  { id: 'mr', name: 'Marathi', autonym: 'मराठी' },
  { id: 'mn', name: 'Mongolian', autonym: 'Монгол' },
  { id: 'ne', name: 'Nepali', autonym: 'नेपाली' },
  { id: 'no', name: 'Norwegian', autonym: 'Norsk' },
  { id: 'or', name: 'Odia', autonym: 'ଓଡ଼ିଆ' },
  { id: 'om', name: 'Oromo', autonym: 'Afaan Oromoo' },
  { id: 'ps', name: 'Pashto', autonym: 'پښتو' },
  { id: 'fa', name: 'Persian (Farsi)', autonym: 'فارسی' },
  { id: 'pl', name: 'Polish', autonym: 'Polski' },
  { id: 'pt', name: 'Portuguese', autonym: 'Português' },
  { id: 'pt-BR', name: 'Portuguese (Brazil)', autonym: 'Português (Brasil)' },
  { id: 'pa', name: 'Punjabi', autonym: 'ਪੰਜਾਬੀ' },
  { id: 'qu', name: 'Quechua', autonym: 'Runasimi' },
  { id: 'ro', name: 'Romanian', autonym: 'Română' },
  { id: 'rhg', name: 'Rohingya', autonym: 'Ruáingga' },
  { id: 'ru', name: 'Russian', autonym: 'Русский' },
  { id: 'sg', name: 'Sango', autonym: 'Sängö' },
  { id: 'sr', name: 'Serbian', autonym: 'Српски' },
  { id: 'sn', name: 'Shona', autonym: 'ChiShona' },
  { id: 'sd', name: 'Sindhi', autonym: 'سنڌي' },
  { id: 'si', name: 'Sinhala', autonym: 'සිංහල' },
  { id: 'sk', name: 'Slovak', autonym: 'Slovenčina' },
  { id: 'sl', name: 'Slovenian', autonym: 'Slovenščina' },
  { id: 'so', name: 'Somali', autonym: 'Soomaali' },
  { id: 'es', name: 'Spanish', autonym: 'Español' },
  { id: 'sw', name: 'Swahili', autonym: 'Kiswahili' },
  { id: 'sv', name: 'Swedish', autonym: 'Svenska' },
  { id: 'tl', name: 'Tagalog (Filipino)', autonym: 'Tagalog' },
  { id: 'tg', name: 'Tajik', autonym: 'Тоҷикӣ' },
  { id: 'ta', name: 'Tamil', autonym: 'தமிழ்' },
  { id: 'te', name: 'Telugu', autonym: 'తెలుగు' },
  { id: 'th', name: 'Thai', autonym: 'ไทย' },
  { id: 'ti', name: 'Tigrinya', autonym: 'ትግርኛ' },
  { id: 'tr', name: 'Turkish', autonym: 'Türkçe' },
  { id: 'tk', name: 'Turkmen', autonym: 'Türkmençe' },
  { id: 'uk', name: 'Ukrainian', autonym: 'Українська' },
  { id: 'ur', name: 'Urdu', autonym: 'اردو' },
  { id: 'ug', name: 'Uyghur', autonym: 'ئۇيغۇرچە' },
  { id: 'uz', name: 'Uzbek', autonym: 'Oʻzbekcha' },
  { id: 'vi', name: 'Vietnamese', autonym: 'Tiếng Việt' },
  { id: 'cy', name: 'Welsh', autonym: 'Cymraeg' },
  { id: 'wo', name: 'Wolof', autonym: 'Wolof' },
  { id: 'xh', name: 'Xhosa', autonym: 'isiXhosa' },
  { id: 'yo', name: 'Yoruba', autonym: 'Yorùbá' },
  { id: 'zu', name: 'Zulu', autonym: 'isiZulu' },
] as const;

/** Display label combining English name and autonym when they differ. */
export function translationLanguageLabel(lang: TranslationLanguage): string {
  return lang.name === lang.autonym
    ? lang.name
    : `${lang.name} (${lang.autonym})`;
}

export function findTranslationLanguage(
  id: string,
): TranslationLanguage | undefined {
  return TRANSLATION_LANGUAGES.find((l) => l.id === id);
}

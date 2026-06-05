import {
  IconAlertTriangle,
  IconLanguage,
  IconLoader2,
  IconWorld,
} from '@tabler/icons-react';
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { Session } from 'next-auth';
import { useTranslations } from 'next-intl';

import { translateText } from '@/lib/services/translation/translationService';

import { getAutonym, getSupportedLocales } from '@/lib/utils/app/locales';
import {
  TermsData,
  fetchTermsData,
  saveUserAcceptance,
} from '@/lib/utils/app/user/termsAcceptance';

import { Streamdown } from 'streamdown';

interface TermsAcceptanceModalProps {
  user: Session['user'];
  onAcceptance: () => void;
}

export const TermsAcceptanceModal: FC<TermsAcceptanceModalProps> = ({
  user,
  onAcceptance,
}) => {
  const t = useTranslations();
  const userLocale = 'en'; // Default to English for terms

  const [termsData, setTermsData] = useState<TermsData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [currentLocale, setCurrentLocale] = useState<string>(userLocale);
  const [availableLocales, setAvailableLocales] = useState<string[]>(['en']);

  // Translation state
  const [translatedContent, setTranslatedContent] = useState<string | null>(
    null,
  );
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [translationLocale, setTranslationLocale] = useState<string | null>(
    null,
  );
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [showTranslationDropdown, setShowTranslationDropdown] =
    useState<boolean>(false);

  // Get all supported locales for translation (excluding official ones)
  const translationLocales = useMemo(() => {
    const allLocales = getSupportedLocales();
    // Filter out official locales (en, fr) and sort alphabetically by autonym
    return allLocales
      .filter((locale) => !availableLocales.includes(locale))
      .sort((a, b) => getAutonym(a).localeCompare(getAutonym(b)));
  }, [availableLocales]);

  // Use email (mail) as the primary identifier for terms acceptance
  // This ensures consistency with checkUserTermsAcceptance
  const userId = user?.mail || user?.id || '';

  // Debug logging for missing user data
  useEffect(() => {
    if (!userId) {
      console.error('Terms Modal: Missing user ID/email. User object:', user);
    }
  }, [userId, user]);

  // Fetch terms data
  useEffect(() => {
    const getTermsData = async () => {
      try {
        setLoading(true);
        const data = await fetchTermsData();
        setTermsData(data);

        // Determine available locales
        if (data.platformTerms) {
          const locales = Object.keys(data.platformTerms.localized);
          setAvailableLocales(locales);

          // Set initial locale - use user's locale if available, otherwise English
          const userLocaleAvailable = locales.includes(userLocale);
          setCurrentLocale(userLocaleAvailable ? userLocale : 'en');
        }

        setLoading(false);
      } catch (error) {
        console.error('Error fetching terms data:', error);
        setError(
          'Failed to load terms and conditions. Please try again later.',
        );
        setLoading(false);
      }
    };

    getTermsData();
  }, [userLocale]);

  // Handle final acceptance of all terms
  const handleAcceptAllTerms = async () => {
    if (!termsData) {
      console.error('Terms Modal: Missing terms data');
      setError('Terms data not loaded. Please refresh the page.');
      return;
    }

    if (!userId) {
      console.error('Terms Modal: Missing user ID. User object:', user);
      setError('Unable to identify user. Please sign out and sign back in.');
      return;
    }

    try {
      // Save acceptance for all documents with current locale
      Object.entries(termsData).forEach(([docType, doc]) => {
        if (doc) {
          const hash =
            doc.localized[currentLocale]?.hash || doc.localized['en'].hash;
          saveUserAcceptance(userId, docType, doc.version, hash, currentLocale);
        }
      });

      // Call the onAcceptance callback
      onAcceptance();
    } catch (error) {
      console.error('Error saving terms acceptance:', error);
      setError('Failed to save your acceptance. Please try again.');
    }
  };

  // Handle official locale change (clears any AI translation)
  const handleLocaleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setCurrentLocale(e.target.value);
    // Clear AI translation when switching to official language
    setTranslatedContent(null);
    setTranslationLocale(null);
    setTranslationError(null);
  };

  // Handle translation to a non-official language
  const handleTranslate = useCallback(
    async (targetLocale: string) => {
      if (!termsData?.platformTerms) return;

      setIsTranslating(true);
      setTranslationError(null);
      setShowTranslationDropdown(false);

      try {
        // Get the English content as source (most complete/accurate)
        const sourceContent =
          termsData.platformTerms.localized['en']?.content || '';

        const response = await translateText({
          sourceText: sourceContent,
          targetLocale: targetLocale,
        });

        if (response.success && response.data?.translatedText) {
          setTranslatedContent(response.data.translatedText);
          setTranslationLocale(targetLocale);
        } else {
          setTranslationError(t('terms.translationError'));
        }
      } catch (err) {
        console.error('Translation error:', err);
        setTranslationError(t('terms.translationError'));
      } finally {
        setIsTranslating(false);
      }
    },
    [termsData, t],
  );

  // Clear AI translation and return to official version
  const handleViewOfficialVersion = useCallback(() => {
    setTranslatedContent(null);
    setTranslationLocale(null);
    setTranslationError(null);
  }, []);

  // Get localized name for a language
  const getLanguageName = (locale: string): string => {
    const localeNames: Record<string, string> = {
      en: 'English',
      fr: 'Français',
      es: 'Español',
    };
    return localeNames[locale] || locale;
  };

  // Determine if we're showing AI translation
  const isShowingTranslation =
    translatedContent !== null && translationLocale !== null;

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black/70 z-50 p-4">
        <div className="bg-white dark:bg-surface-dark p-6 rounded-2xl shadow-xl max-w-sm w-full border border-gray-300 dark:border-gray-600">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full bg-blue-100 dark:bg-blue-900/30">
              <div className="w-6 h-6 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
            <p className="text-sm font-medium text-gray-800 dark:text-white">
              {t('Loading terms and conditions_ellipsis')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black/70 z-50 p-4">
        <div className="bg-white dark:bg-surface-dark p-6 rounded-2xl shadow-xl max-w-sm w-full border border-gray-300 dark:border-gray-600">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full bg-red-100 dark:bg-red-900/30">
              <svg
                className="w-6 h-6 text-red-600 dark:text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <p className="text-sm font-medium text-red-600 dark:text-red-400 mb-3">
              {error}
            </p>
            <button
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg shadow-sm transition-all"
              onClick={() => window.location.reload()}
            >
              {t('Retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!termsData) {
    return null;
  }

  // Get all versions for header
  const versions = Object.values(termsData)
    .map((doc) => doc?.version)
    .filter(Boolean)
    .join(', ');

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/70 z-50 p-4">
      <div className="bg-white dark:bg-surface-dark rounded-2xl shadow-xl max-w-xl w-full max-h-[80vh] flex flex-col overflow-hidden border border-gray-300 dark:border-gray-600">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-300 dark:border-gray-600">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                {t('Terms and Conditions')}
              </h2>
              <span className="text-[10px] text-gray-500 dark:text-gray-400 font-mono bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">
                v{versions}
              </span>
            </div>
            {/* Official language selector */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-sm">
                <span className="text-[10px] text-gray-500 dark:text-gray-400">
                  {t('terms.officialLanguages')}
                </span>
                <IconLanguage
                  size={14}
                  className="text-gray-600 dark:text-gray-300"
                />
                <select
                  id="language-select"
                  value={currentLocale}
                  onChange={handleLocaleChange}
                  disabled={isShowingTranslation}
                  className="bg-transparent text-gray-800 dark:text-white text-xs font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 rounded border-0 disabled:opacity-50"
                >
                  {availableLocales.map((locale) => (
                    <option
                      key={locale}
                      value={locale}
                      className="bg-white dark:bg-gray-800"
                    >
                      {getLanguageName(locale)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Translation option row */}
          <div className="mt-3 flex items-center justify-between">
            <div className="relative">
              <button
                onClick={() =>
                  setShowTranslationDropdown(!showTranslationDropdown)
                }
                disabled={isTranslating}
                className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors disabled:opacity-50"
              >
                <IconWorld size={14} />
                <span>{t('terms.translateForUnderstanding')}</span>
                {isTranslating && (
                  <IconLoader2 size={12} className="animate-spin ml-1" />
                )}
              </button>

              {/* Translation language dropdown */}
              {showTranslationDropdown && (
                <div className="absolute top-full left-0 mt-1 w-48 max-h-48 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10">
                  {translationLocales.map((locale) => (
                    <button
                      key={locale}
                      onClick={() => handleTranslate(locale)}
                      className="w-full px-3 py-2 text-left text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    >
                      {getAutonym(locale)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* View official version link (shown when viewing translation) */}
            {isShowingTranslation && (
              <button
                onClick={handleViewOfficialVersion}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('terms.viewOfficialVersion')}
              </button>
            )}
          </div>

          {/* Translation error */}
          {translationError && (
            <div className="mt-2 text-xs text-red-600 dark:text-red-400">
              {translationError}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* AI Translation disclaimer */}
          {isShowingTranslation && (
            <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-start gap-2">
                <IconAlertTriangle
                  size={16}
                  className="text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0"
                />
                <p className="text-xs text-amber-800 dark:text-amber-200">
                  {t('terms.aiTranslationNotice')}
                </p>
              </div>
            </div>
          )}

          {/* Translating indicator */}
          {isTranslating && (
            <div className="flex items-center justify-center py-8">
              <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                <IconLoader2 size={20} className="animate-spin" />
                <span className="text-sm">{t('terms.translating')}</span>
              </div>
            </div>
          )}

          {/* Show translated content or official content */}
          {!isTranslating && (
            <>
              {isShowingTranslation && translatedContent ? (
                <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-gray-900 dark:prose-headings:text-white prose-p:text-gray-700 dark:prose-p:text-gray-200 prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-strong:text-gray-900 dark:prose-strong:text-white prose-ul:text-gray-700 dark:prose-ul:text-gray-200 prose-li:text-gray-700 dark:prose-li:text-gray-200">
                  <Streamdown>
                    {translatedContent.replace(/^#\s+.*?Terms.*?\n+/i, '')}
                  </Streamdown>
                </div>
              ) : (
                Object.entries(termsData).map(([docType, doc]) => {
                  if (!doc) return null;

                  let documentContent =
                    doc.localized[currentLocale]?.content ||
                    doc.localized['en']?.content ||
                    '';

                  // Remove the main title from the markdown content
                  documentContent = documentContent.replace(
                    /^#\s+.*?Terms.*?\n+/i,
                    '',
                  );

                  return (
                    <div
                      key={docType}
                      className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-gray-900 dark:prose-headings:text-white prose-p:text-gray-700 dark:prose-p:text-gray-200 prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-strong:text-gray-900 dark:prose-strong:text-white prose-ul:text-gray-700 dark:prose-ul:text-gray-200 prose-li:text-gray-700 dark:prose-li:text-gray-200"
                    >
                      <Streamdown>{documentContent}</Streamdown>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-300 dark:border-gray-600">
          <button
            className="w-full py-2.5 px-5 rounded-lg font-medium text-sm transition-all bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg"
            onClick={handleAcceptAllTerms}
          >
            {t('Accept and Continue')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TermsAcceptanceModal;

import { IconLanguage } from '@tabler/icons-react';
import React, { FC, useEffect, useState } from 'react';

import { Session } from 'next-auth';
import { useTranslations } from 'next-intl';

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

  // Handle locale change
  const handleLocaleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setCurrentLocale(e.target.value);
  };

  // Get localized name for a language
  const getLanguageName = (locale: string): string => {
    const localeNames: Record<string, string> = {
      en: 'English',
      fr: 'Français',
      es: 'Español',
    };
    return localeNames[locale] || locale;
  };

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black/70 z-50 backdrop-blur-sm p-4">
        <div className="bg-white dark:bg-[#1f1f1f] p-6 rounded-2xl shadow-2xl max-w-sm w-full border border-gray-300 dark:border-gray-600">
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
      <div className="fixed inset-0 flex items-center justify-center bg-black/70 z-50 backdrop-blur-sm p-4">
        <div className="bg-white dark:bg-[#1f1f1f] p-6 rounded-2xl shadow-2xl max-w-sm w-full border border-gray-300 dark:border-gray-600">
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
              className="px-4 py-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white text-sm font-medium rounded-lg shadow-md hover:shadow-lg transition-all"
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
    <div className="fixed inset-0 flex items-center justify-center bg-black/70 z-50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-[#1f1f1f] rounded-2xl shadow-2xl max-w-xl w-full max-h-[80vh] flex flex-col overflow-hidden border border-gray-300 dark:border-gray-600">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-300 dark:border-gray-600 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
              {t('Terms and Conditions')}
            </h2>
            <span className="text-[10px] text-gray-500 dark:text-gray-400 font-mono bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">
              v{versions}
            </span>
          </div>
          {/* Language selector */}
          <div className="flex items-center gap-2 text-sm">
            <IconLanguage
              size={16}
              className="text-gray-600 dark:text-gray-300"
            />
            <select
              id="language-select"
              value={currentLocale}
              onChange={handleLocaleChange}
              className="bg-transparent text-gray-800 dark:text-white text-xs font-medium cursor-pointer focus:outline-none border-0"
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {Object.entries(termsData).map(([docType, doc]) => {
            if (!doc) return null;

            let documentContent =
              doc.localized[currentLocale]?.content ||
              doc.localized['en']?.content ||
              '';

            // Remove the main title from the markdown content
            // This removes lines like "# ai.msf.org Terms of Use"
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
          })}
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

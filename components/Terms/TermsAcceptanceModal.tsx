import {
  IconAlertTriangle,
  IconChevronDown,
  IconLanguage,
  IconLoader2,
  IconSearch,
  IconWorld,
  IconX,
} from '@tabler/icons-react';
import React, {
  FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { Session } from 'next-auth';
import { useLocale, useTranslations } from 'next-intl';

import { translateText } from '@/lib/services/translation/translationService';

import {
  getAutonym,
  getOfficialTermsLanguageName,
  getSupportedLocales,
} from '@/lib/utils/app/locales';
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
  const userLocale = useLocale();

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
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    left: 0,
    showAbove: false,
  });

  // Refs for dropdown positioning and focus management
  const translationButtonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionsListRef = useRef<HTMLDivElement>(null);

  // Get all supported locales for translation (excluding official ones)
  const translationLocales = useMemo(() => {
    const allLocales = getSupportedLocales();
    // Filter out official locales (en, fr, es) and sort alphabetically by autonym
    return allLocales
      .filter((locale) => !availableLocales.includes(locale))
      .sort((a, b) => getAutonym(a).localeCompare(getAutonym(b)));
  }, [availableLocales]);

  // Filter translation locales based on search query
  const filteredTranslationLocales = useMemo(() => {
    if (!searchQuery.trim()) return translationLocales;

    const query = searchQuery.toLowerCase();
    return translationLocales.filter((locale) => {
      const autonym = getAutonym(locale).toLowerCase();
      return autonym.includes(query) || locale.includes(query);
    });
  }, [translationLocales, searchQuery]);

  // Use email (mail) as the primary identifier for terms acceptance
  // This ensures consistency with checkUserTermsAcceptance
  const userId = user?.mail || user?.id || '';

  // Debug logging for missing user data
  useEffect(() => {
    if (!userId) {
      console.error('Terms Modal: Missing user ID/email. User object:', user);
    }
  }, [userId, user]);

  // Calculate dropdown position when opened
  useEffect(() => {
    if (showTranslationDropdown && translationButtonRef.current) {
      const buttonRect = translationButtonRef.current.getBoundingClientRect();
      const dropdownWidth = 256; // w-64 = 16rem = 256px
      const dropdownHeight = 240; // max-h-48 (192px) + search input padding (~48px)

      // Check if dropdown should flip above button
      const spaceBelow = window.innerHeight - buttonRect.bottom - 8;
      const spaceAbove = buttonRect.top - 8;
      const showAbove = spaceBelow < dropdownHeight && spaceAbove > spaceBelow;

      // Position below or above the button
      let left = buttonRect.left;
      const top = showAbove
        ? buttonRect.top - dropdownHeight - 4
        : buttonRect.bottom + 4;

      // Ensure dropdown doesn't go off-screen to the right
      if (left + dropdownWidth > window.innerWidth - 8) {
        left = window.innerWidth - dropdownWidth - 8;
      }

      // Ensure dropdown doesn't go off-screen to the left
      if (left < 8) {
        left = 8;
      }

      setDropdownPosition({ top, left, showAbove });
    }
  }, [showTranslationDropdown]);

  // Focus search input when dropdown opens and reset state when closed
  useEffect(() => {
    if (showTranslationDropdown) {
      // Use requestAnimationFrame to ensure DOM is ready
      const rafId = requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
      return () => cancelAnimationFrame(rafId);
    } else {
      // Reset state when dropdown closes
      setSearchQuery('');
      setSelectedIndex(-1);
    }
  }, [showTranslationDropdown]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (selectedIndex >= 0 && optionsListRef.current) {
      const optionElement = optionsListRef.current.querySelector(
        `[data-option-index="${selectedIndex}"]`,
      );
      optionElement?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!showTranslationDropdown) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        translationButtonRef.current &&
        !translationButtonRef.current.contains(event.target as Node)
      ) {
        setShowTranslationDropdown(false);
      }
    };

    // Add small delay to prevent immediate closing
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showTranslationDropdown]);

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

  // Keyboard navigation for dropdown
  const handleDropdownKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const items = filteredTranslationLocales.length;
      if (items === 0) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % items);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + items) % items);
          break;
        case 'Enter':
          event.preventDefault();
          if (selectedIndex >= 0 && filteredTranslationLocales[selectedIndex]) {
            handleTranslate(filteredTranslationLocales[selectedIndex]);
          }
          break;
        case 'Escape':
          setShowTranslationDropdown(false);
          break;
      }
    },
    [filteredTranslationLocales, selectedIndex, handleTranslate],
  );

  // Clear AI translation and return to official version
  const handleViewOfficialVersion = useCallback(() => {
    setTranslatedContent(null);
    setTranslationLocale(null);
    setTranslationError(null);
  }, []);

  // Determine if we're showing AI translation
  const isShowingTranslation =
    translatedContent !== null && translationLocale !== null;

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
                  className="bg-transparent text-gray-800 dark:text-white text-xs font-medium cursor-pointer focus:outline-none border-0 disabled:opacity-50"
                >
                  {availableLocales.map((locale) => (
                    <option
                      key={locale}
                      value={locale}
                      className="bg-white dark:bg-gray-800"
                    >
                      {getOfficialTermsLanguageName(locale)}
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
                ref={translationButtonRef}
                onClick={() =>
                  setShowTranslationDropdown(!showTranslationDropdown)
                }
                disabled={isTranslating}
                aria-haspopup="listbox"
                aria-expanded={showTranslationDropdown}
                aria-controls="terms-translation-listbox"
                aria-busy={isTranslating}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 hover:border-gray-300 dark:hover:border-gray-500 transition-colors disabled:opacity-50"
              >
                <IconWorld size={14} />
                <span>{t('terms.translateForUnderstanding')}</span>
                {isTranslating ? (
                  <IconLoader2 size={12} className="animate-spin" />
                ) : (
                  <IconChevronDown
                    size={14}
                    className={`transition-transform ${showTranslationDropdown ? 'rotate-180' : ''}`}
                  />
                )}
              </button>

              {/* Searchable Translation Dropdown (Portal) */}
              {showTranslationDropdown &&
                createPortal(
                  <div
                    ref={dropdownRef}
                    id="terms-translation-listbox"
                    className="fixed z-[100] w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden"
                    style={{
                      top: `${dropdownPosition.top}px`,
                      left: `${dropdownPosition.left}px`,
                    }}
                    role="listbox"
                    aria-label={t('chat.selectLanguage')}
                    aria-activedescendant={
                      selectedIndex >= 0 &&
                      filteredTranslationLocales[selectedIndex]
                        ? `terms-lang-${filteredTranslationLocales[selectedIndex]}`
                        : undefined
                    }
                  >
                    {/* Search input */}
                    <div className="p-2 border-b border-gray-200 dark:border-gray-700">
                      <div className="relative">
                        <IconSearch
                          size={14}
                          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
                        />
                        <input
                          ref={searchInputRef}
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={handleDropdownKeyDown}
                          placeholder={t('chat.searchLanguages')}
                          aria-label={t('chat.searchLanguages')}
                          className="w-full pl-8 pr-8 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 border-0 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-white placeholder-gray-500"
                        />
                        {searchQuery && (
                          <button
                            onClick={() => setSearchQuery('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                          >
                            <IconX size={12} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Language list */}
                    <div
                      ref={optionsListRef}
                      className="max-h-48 overflow-y-auto"
                    >
                      {filteredTranslationLocales.map((locale, index) => {
                        const isHighlighted = selectedIndex === index;

                        return (
                          <button
                            key={locale}
                            id={`terms-lang-${locale}`}
                            data-option-index={index}
                            onClick={() => handleTranslate(locale)}
                            disabled={isTranslating}
                            className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                              isHighlighted
                                ? 'bg-gray-100 dark:bg-gray-700'
                                : ''
                            }`}
                            role="option"
                            aria-selected={isHighlighted}
                          >
                            <span className="flex items-center gap-2">
                              <span className="font-medium text-gray-900 dark:text-white">
                                {getAutonym(locale)}
                              </span>
                              <span className="text-gray-500 dark:text-gray-400 text-[10px]">
                                {locale}
                              </span>
                            </span>
                          </button>
                        );
                      })}

                      {/* No results */}
                      {filteredTranslationLocales.length === 0 && (
                        <div
                          className="px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400"
                          aria-live="polite"
                        >
                          {t('common.noResults')}
                        </div>
                      )}
                    </div>
                  </div>,
                  document.body,
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
                    {translatedContent.replace(/^#\s+.+\n+/, '')}
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
                  documentContent = documentContent.replace(/^#\s+.+\n+/, '');

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

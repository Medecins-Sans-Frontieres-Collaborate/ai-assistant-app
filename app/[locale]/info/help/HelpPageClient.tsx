'use client';

import {
  IconArrowLeft,
  IconBook,
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconFileText,
  IconHelp,
  IconLanguage,
  IconMail,
  IconSearch,
  IconShield,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { FaGithub } from 'react-icons/fa';

import Image from 'next/image';

import { EXTERNAL_LINKS } from '@/lib/constants/externalLinks';
import { Link } from '@/lib/navigation';

type SectionType = 'faq' | 'privacy' | 'contact' | null;

interface FAQItem {
  question: string;
  answer: string;
}

interface PrivacyItem {
  id: string;
  question: string;
  answer: string;
  [key: string]: any;
}

interface ContactTranslations {
  submitRequest: {
    title: string;
    subtitle: string;
    description: string;
    buttonText: string;
  };
  otherWays: {
    title: string;
  };
  emailSupport: {
    title: string;
    description: string;
  };
  additionalResources: {
    title: string;
  };
  aiAcceleratorPortal: {
    title: string;
    description: string;
  };
  githubRepository: {
    title: string;
    description: string;
  };
}

interface HelpPageClientProps {
  isUSUser: boolean;
  supportEmail: string;
  faqTranslations: Record<string, FAQItem[]>;
  privacyTranslations: Record<string, PrivacyItem[]>;
  contactTranslations: Record<string, ContactTranslations>;
  uiTranslations: Record<string, any>;
  initialLocale: string;
  availableLocales: string[];
}

export function HelpPageClient({
  supportEmail,
  faqTranslations,
  privacyTranslations,
  contactTranslations,
  uiTranslations,
  initialLocale,
  availableLocales,
}: HelpPageClientProps) {
  const [expandedSection, setExpandedSection] = useState<SectionType>('faq');
  const [searchQuery, setSearchQuery] = useState('');
  const [openFaqItems, setOpenFaqItems] = useState<Set<number>>(new Set());
  const [openPrivacyItems, setOpenPrivacyItems] = useState<Set<string>>(
    new Set(),
  );
  const [currentLocale, setCurrentLocale] = useState<string>(initialLocale);

  const faqs = faqTranslations[currentLocale] || faqTranslations['en'] || [];
  const privacyItems =
    privacyTranslations[currentLocale] || privacyTranslations['en'] || [];
  const contactText =
    contactTranslations[currentLocale] || contactTranslations['en'];
  const t = uiTranslations[currentLocale] || uiTranslations['en'];

  // Debug log on mount
  useEffect(() => {
    console.log('[FAQ Client] Mounted with:', {
      initialLocale,
      currentLocale,
      availableTranslations: Object.keys(faqTranslations),
      currentFaqCount: faqs.length,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only log on mount

  // Get localized language names
  const getLanguageName = (locale: string): string => {
    const localeNames: Record<string, string> = {
      en: 'English',
      es: 'Español',
      fr: 'Français',
      de: 'Deutsch',
      it: 'Italiano',
      pt: 'Português',
      ar: 'العربية',
      nl: 'Nederlands',
      ru: 'Русский',
      zh: '中文',
      ja: '日本語',
      hi: 'हिन्दी',
      sw: 'Kiswahili',
    };
    return localeNames[locale] || locale;
  };

  // Handle locale change
  const handleLocaleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLocale = e.target.value;
    console.log('[FAQ] Changing locale from', currentLocale, 'to', newLocale);
    console.log('[FAQ] Available translations:', Object.keys(faqTranslations));
    console.log(
      '[FAQ] New FAQs count:',
      faqTranslations[newLocale]?.length || 0,
    );
    setCurrentLocale(newLocale);
    setSearchQuery(''); // Clear search when changing language
  };

  // Helper function to render text with clickable links
  const renderTextWithLinks = (text: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);

    return parts.map((part, index) => {
      if (part.match(urlRegex)) {
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline break-all"
          >
            {part}
          </a>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  // Filter FAQs based on search
  const filteredFaqs =
    searchQuery && expandedSection === 'faq'
      ? faqs.filter(
          (faq) =>
            faq.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
            faq.answer.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : faqs;

  // Filter Privacy items based on search
  const filteredPrivacy =
    searchQuery && expandedSection === 'privacy'
      ? privacyItems.filter(
          (item) =>
            item.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
            item.answer.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : privacyItems;

  const toggleFaqItem = (index: number) => {
    setOpenFaqItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const togglePrivacyItem = (id: string) => {
    setOpenPrivacyItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSection = (section: SectionType) => {
    if (expandedSection === section) {
      setExpandedSection(null);
      setSearchQuery('');
    } else {
      setExpandedSection(section);
      setSearchQuery('');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 mb-4 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <IconArrowLeft size={18} />
            {t.backToChat}
          </Link>

          <div className="flex items-center justify-between gap-4 mb-2">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-xl">
                <IconBook
                  size={32}
                  className="text-blue-600 dark:text-blue-400"
                />
              </div>
              <div>
                <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white">
                  {t.helpCenterTitle}
                </h1>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  {t.helpCenterSubtitle}
                </p>
              </div>
            </div>

            {/* Language selector */}
            <div className="flex items-center gap-2 text-sm">
              <IconLanguage
                size={20}
                className="text-gray-600 dark:text-gray-300"
              />
              <select
                value={currentLocale}
                onChange={handleLocaleChange}
                className="bg-white dark:bg-gray-800 text-gray-800 dark:text-white text-sm font-medium cursor-pointer focus:outline-none border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5"
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
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-4 md:px-8 py-8">
        {/* Section Tiles */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {/* FAQ Tile */}
          <button
            onClick={() => toggleSection('faq')}
            className={`group relative p-6 rounded-xl border-2 transition-all text-left ${
              expandedSection === 'faq'
                ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20 shadow-lg scale-[1.02]'
                : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md'
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <div
                className={`p-3 rounded-lg transition-colors ${
                  expandedSection === 'faq'
                    ? 'bg-blue-600 dark:bg-blue-700'
                    : 'bg-blue-100 dark:bg-blue-900/30 group-hover:bg-blue-200 dark:group-hover:bg-blue-900/50'
                }`}
              >
                <IconHelp
                  size={24}
                  className={
                    expandedSection === 'faq'
                      ? 'text-white'
                      : 'text-blue-600 dark:text-blue-400'
                  }
                />
              </div>
              <IconChevronRight
                size={20}
                className={`text-gray-400 transition-transform ${
                  expandedSection === 'faq' ? 'rotate-90' : ''
                }`}
              />
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              {t.faqCardTitle}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              {t.faqCardDescription}
            </p>
            <div className="flex items-center gap-2 text-xs font-medium text-blue-600 dark:text-blue-400">
              <span>
                {faqs.length} {t.faqArticlesCount}
              </span>
            </div>
          </button>

          {/* Privacy Tile */}
          <button
            onClick={() => toggleSection('privacy')}
            className={`group relative p-6 rounded-xl border-2 transition-all text-left ${
              expandedSection === 'privacy'
                ? 'border-green-500 dark:border-green-400 bg-green-50 dark:bg-green-900/20 shadow-lg scale-[1.02]'
                : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-green-300 dark:hover:border-green-600 hover:shadow-md'
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <div
                className={`p-3 rounded-lg transition-colors ${
                  expandedSection === 'privacy'
                    ? 'bg-green-600 dark:bg-green-700'
                    : 'bg-green-100 dark:bg-green-900/30 group-hover:bg-green-200 dark:group-hover:bg-green-900/50'
                }`}
              >
                <IconShield
                  size={24}
                  className={
                    expandedSection === 'privacy'
                      ? 'text-white'
                      : 'text-green-600 dark:text-green-400'
                  }
                />
              </div>
              <IconChevronRight
                size={20}
                className={`text-gray-400 transition-transform ${
                  expandedSection === 'privacy' ? 'rotate-90' : ''
                }`}
              />
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              {t.privacyCardTitle}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              {t.privacyCardDescription}
            </p>
            <div className="flex items-center gap-2 text-xs font-medium text-green-600 dark:text-green-400">
              <span>
                {privacyItems.length} {t.privacyTopicsCount}
              </span>
            </div>
          </button>

          {/* Contact & Support Tile */}
          <button
            onClick={() => toggleSection('contact')}
            className={`group relative p-6 rounded-xl border-2 transition-all text-left ${
              expandedSection === 'contact'
                ? 'border-purple-500 dark:border-purple-400 bg-purple-50 dark:bg-purple-900/20 shadow-lg scale-[1.02]'
                : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-purple-300 dark:hover:border-purple-600 hover:shadow-md'
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <div
                className={`p-3 rounded-lg transition-colors ${
                  expandedSection === 'contact'
                    ? 'bg-purple-600 dark:bg-purple-700'
                    : 'bg-purple-100 dark:bg-purple-900/30 group-hover:bg-purple-200 dark:group-hover:bg-purple-900/50'
                }`}
              >
                <IconMail
                  size={24}
                  className={
                    expandedSection === 'contact'
                      ? 'text-white'
                      : 'text-purple-600 dark:text-purple-400'
                  }
                />
              </div>
              <IconChevronRight
                size={20}
                className={`text-gray-400 transition-transform ${
                  expandedSection === 'contact' ? 'rotate-90' : ''
                }`}
              />
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              {t.contactCardTitle}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              {t.contactCardDescription}
            </p>
            <div className="flex items-center gap-2 text-xs font-medium text-purple-600 dark:text-purple-400">
              <span>{t.contactAvailableLabel}</span>
            </div>
          </button>
        </div>

        {/* Expanded Content */}
        {expandedSection && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-lg p-6 animate-fade-in">
            {/* Search Bar (for FAQ and Privacy) */}
            {(expandedSection === 'faq' || expandedSection === 'privacy') && (
              <div className="mb-6">
                <div className="relative">
                  <IconSearch
                    size={20}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"
                  />
                  <input
                    type="text"
                    placeholder={
                      expandedSection === 'faq'
                        ? t.searchFaqsPlaceholder
                        : t.searchPrivacyTopicsPlaceholder
                    }
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-12 pr-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-transparent"
                  />
                </div>
              </div>
            )}

            {/* FAQ Content */}
            {expandedSection === 'faq' && (
              <div className="space-y-3">
                {filteredFaqs.length === 0 ? (
                  <div className="text-center py-12">
                    <IconSearch
                      size={48}
                      className="mx-auto mb-4 text-gray-400 dark:text-gray-500"
                    />
                    <p className="text-gray-600 dark:text-gray-400 font-medium">
                      {t.noFaqsMatch}
                    </p>
                    <p className="text-sm text-gray-500 dark:text-gray-500 mt-2">
                      {t.tryDifferentSearch}
                    </p>
                  </div>
                ) : (
                  filteredFaqs.map((faq, index) => {
                    const isOpen = openFaqItems.has(index);
                    return (
                      <div
                        key={index}
                        className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
                      >
                        <button
                          onClick={() => toggleFaqItem(index)}
                          className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors"
                        >
                          <span className="text-sm font-semibold text-gray-900 dark:text-white">
                            {faq.question}
                          </span>
                          <IconChevronDown
                            size={20}
                            className={`text-gray-400 flex-shrink-0 transition-transform ${
                              isOpen ? 'rotate-180' : ''
                            }`}
                          />
                        </button>
                        {isOpen && (
                          <div className="px-4 pb-4 pt-2 text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-line border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
                            {renderTextWithLinks(faq.answer)}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Privacy Content */}
            {expandedSection === 'privacy' && (
              <div className="space-y-4">
                {/* Privacy Notice Banner */}
                <div className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-900/30 rounded-lg border border-green-200 dark:border-green-800 p-5 mb-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-green-600 dark:bg-green-700 rounded-lg">
                      <IconShield className="text-white" size={24} />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-base font-bold text-gray-900 dark:text-white mb-2">
                        {t.privacyBannerTitle}
                      </h3>
                      <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
                        {t.privacyBannerDescription}
                      </p>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-green-600 dark:text-green-400 font-bold">
                            ✓
                          </span>
                          <span className="text-gray-700 dark:text-gray-300">
                            {t.localStorageOnly}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-green-600 dark:text-green-400 font-bold">
                            ✓
                          </span>
                          <span className="text-gray-700 dark:text-gray-300">
                            {t.msfControlled}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-red-600 dark:text-red-400 font-bold">
                            ✗
                          </span>
                          <span className="text-gray-700 dark:text-gray-300">
                            {t.noPersonalData}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-red-600 dark:text-red-400 font-bold">
                            ✗
                          </span>
                          <span className="text-gray-700 dark:text-gray-300">
                            {t.noSensitiveOps}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Privacy Items */}
                <div className="space-y-3">
                  {filteredPrivacy.length === 0 ? (
                    <div className="text-center py-12">
                      <IconSearch
                        size={48}
                        className="mx-auto mb-4 text-gray-400 dark:text-gray-500"
                      />
                      <p className="text-gray-600 dark:text-gray-400 font-medium">
                        {t.noPrivacyTopicsMatch}
                      </p>
                      <p className="text-sm text-gray-500 dark:text-gray-500 mt-2">
                        {t.tryDifferentSearch}
                      </p>
                    </div>
                  ) : (
                    filteredPrivacy.map((item) => {
                      const isOpen = openPrivacyItems.has(item.id);
                      return (
                        <div
                          key={item.id}
                          className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden hover:border-green-300 dark:hover:border-green-600 transition-colors"
                        >
                          <button
                            onClick={() => togglePrivacyItem(item.id)}
                            className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors"
                          >
                            <span className="text-sm font-semibold text-gray-900 dark:text-white">
                              {item.question}
                            </span>
                            <IconChevronDown
                              size={20}
                              className={`text-gray-400 flex-shrink-0 transition-transform ${
                                isOpen ? 'rotate-180' : ''
                              }`}
                            />
                          </button>
                          {isOpen && (
                            <div className="px-4 pb-4 pt-2 text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-line border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
                              {renderTextWithLinks(item.answer)}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* Contact Content */}
            {expandedSection === 'contact' && (
              <div className="space-y-8">
                {/* Submit a Request */}
                <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-950/40 dark:to-purple-900/40 border-2 border-purple-200 dark:border-purple-800/50 p-5 shadow-lg">
                  {/* Background Pattern */}
                  <div className="absolute inset-0 opacity-5 dark:opacity-10">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(139,92,246,0.3),transparent)]" />
                  </div>

                  <div className="relative">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="p-2 bg-purple-600 dark:bg-purple-700 rounded-lg shadow-md">
                        <IconFileText size={24} className="text-white" />
                      </div>
                      <div>
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                          {contactText.submitRequest.title}
                        </h3>
                        <p className="text-purple-700 dark:text-purple-300 text-sm">
                          {contactText.submitRequest.subtitle}
                        </p>
                      </div>
                    </div>

                    <p className="text-sm text-gray-700 dark:text-gray-300 mb-4 leading-relaxed">
                      {contactText.submitRequest.description}
                    </p>

                    <a
                      href={EXTERNAL_LINKS.SUPPORT_FORM}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-purple-600 hover:bg-purple-700 dark:bg-purple-600 dark:hover:bg-purple-700 text-white font-semibold text-sm rounded-lg shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] transition-all duration-200"
                    >
                      <IconExternalLink size={18} />
                      {contactText.submitRequest.buttonText}
                    </a>
                  </div>
                </div>

                {/* Quick Contact Options */}
                <div>
                  <div className="flex items-center gap-2 mb-5">
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                      {contactText.otherWays.title}
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 gap-4">
                    {/* Email Support */}
                    <a
                      href={`mailto:${supportEmail}`}
                      className="group relative overflow-hidden border-2 border-gray-200 dark:border-gray-700 rounded-xl p-4 hover:border-purple-400 dark:hover:border-purple-500 hover:shadow-lg transition-all bg-white dark:bg-gray-900/50"
                    >
                      <div className="flex items-center gap-4">
                        <div className="flex-shrink-0 p-2.5 bg-gradient-to-br from-purple-100 to-purple-200 dark:from-purple-900/40 dark:to-purple-800/40 rounded-lg group-hover:scale-110 transition-transform">
                          <IconMail
                            size={24}
                            className="text-purple-600 dark:text-purple-400"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="text-base font-bold text-gray-900 dark:text-white mb-1">
                            {contactText.emailSupport.title}
                          </h4>
                          <p className="text-sm text-gray-600 dark:text-gray-400 mb-1.5">
                            {contactText.emailSupport.description}
                          </p>
                          <span className="inline-flex items-center gap-2 text-sm font-semibold text-purple-600 dark:text-purple-400">
                            {supportEmail}
                            <IconExternalLink size={14} />
                          </span>
                        </div>
                      </div>
                    </a>
                  </div>
                </div>

                {/* Additional Resources */}
                <div>
                  <div className="flex items-center gap-2 mb-5">
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                      {contactText.additionalResources.title}
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Project Portal */}
                    <a
                      href={EXTERNAL_LINKS.SHAREPOINT_PORTAL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative overflow-hidden border-2 border-gray-200 dark:border-gray-700 rounded-xl p-6 hover:border-teal-400 dark:hover:border-teal-500 hover:shadow-lg transition-all bg-white dark:bg-gray-900/50"
                    >
                      <div className="flex items-start gap-4">
                        <div className="flex-shrink-0 p-3 bg-gradient-to-br from-teal-100 to-teal-200 dark:from-teal-900/40 dark:to-teal-800/40 rounded-lg group-hover:scale-110 transition-transform">
                          <Image
                            src="/sharepoint-logo.svg"
                            alt="SharePoint"
                            width={32}
                            height={32}
                            className="w-8 h-8"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <h4 className="text-base font-bold text-gray-900 dark:text-white">
                              {contactText.aiAcceleratorPortal.title}
                            </h4>
                            <IconExternalLink
                              size={16}
                              className="text-gray-400 group-hover:text-teal-600 dark:group-hover:text-teal-400 transition-colors"
                            />
                          </div>
                          <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                            {contactText.aiAcceleratorPortal.description}
                          </p>
                        </div>
                      </div>
                    </a>

                    {/* GitHub Repository */}
                    <a
                      href={EXTERNAL_LINKS.GITHUB_REPOSITORY}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative overflow-hidden border-2 border-gray-200 dark:border-gray-700 rounded-xl p-6 hover:border-gray-800 dark:hover:border-gray-400 hover:shadow-lg transition-all bg-white dark:bg-gray-900/50"
                    >
                      <div className="flex items-start gap-4">
                        <div className="flex-shrink-0 p-3 bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-700 rounded-lg group-hover:scale-110 transition-transform">
                          <FaGithub
                            size={32}
                            className="text-gray-900 dark:text-white"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <h4 className="text-base font-bold text-gray-900 dark:text-white">
                              {contactText.githubRepository.title}
                            </h4>
                            <IconExternalLink
                              size={16}
                              className="text-gray-400 group-hover:text-gray-900 dark:group-hover:text-white transition-colors"
                            />
                          </div>
                          <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                            {contactText.githubRepository.description}
                          </p>
                        </div>
                      </div>
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

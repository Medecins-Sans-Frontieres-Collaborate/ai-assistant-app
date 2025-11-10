import {
  IconBook,
  IconChevronRight,
  IconExternalLink,
  IconHelp,
  IconMail,
  IconQuestionMark,
} from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import { FC, useEffect, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';

import { FEEDBACK_EMAIL, US_FEEDBACK_EMAIL } from '@/types/contact';

export const HelpSupportSection: FC = () => {
  const t = useTranslations();
  const locale = useLocale();
  const { data: session } = useSession();
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);
  const [topFaqs, setTopFaqs] = useState<
    Array<{ question: string; answer: string }>
  >([]);

  const supportEmail =
    session?.user?.region === 'US' ? US_FEEDBACK_EMAIL : FEEDBACK_EMAIL;

  // Load FAQs based on current locale
  useEffect(() => {
    const loadFaqs = async () => {
      try {
        // Try to load the locale-specific FAQ file
        const faqData = await import(`@/lib/data/faq.${locale}.json`);
        const faqs = faqData.default?.faq || faqData.faq;
        setTopFaqs(faqs.slice(0, 4));
      } catch (error) {
        // Fallback to English if locale file doesn't exist
        try {
          const faqData = await import('@/lib/data/faq.en.json');
          const faqs = faqData.default?.faq || faqData.faq;
          setTopFaqs(faqs.slice(0, 4));
        } catch {
          console.error('Failed to load FAQ data');
        }
      }
    };
    loadFaqs();
  }, [locale]);

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

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <IconHelp size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('settings.Help & Support')}
        </h2>
      </div>

      <div className="space-y-6">
        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Help Center Card */}
          <Link
            href="/info/help"
            className="group border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:border-blue-500 dark:hover:border-blue-400 transition-all hover:shadow-md"
          >
            <div className="flex items-start gap-3">
              <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg group-hover:bg-blue-200 dark:group-hover:bg-blue-900/50 transition-colors">
                <IconBook
                  size={20}
                  className="text-blue-600 dark:text-blue-400"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                    {t('settings.Help Center')}
                  </h3>
                  <IconExternalLink
                    size={14}
                    className="text-gray-400 dark:text-gray-500 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors"
                  />
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {t('settings.FAQs, privacy policy, and guides')}
                </p>
              </div>
            </div>
          </Link>

          {/* Contact Support Card */}
          <a
            href={`mailto:${supportEmail}`}
            className="group border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:border-blue-500 dark:hover:border-blue-400 transition-all hover:shadow-md"
          >
            <div className="flex items-start gap-3">
              <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg group-hover:bg-green-200 dark:group-hover:bg-green-900/50 transition-colors">
                <IconMail
                  size={20}
                  className="text-green-600 dark:text-green-400"
                />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
                  {t('settings.Contact Support')}
                </h3>
                <p className="text-xs text-gray-600 dark:text-gray-400 truncate">
                  {supportEmail}
                </p>
              </div>
            </div>
          </a>
        </div>

        {/* Popular Questions */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h3 className="text-md font-bold mb-4 text-black dark:text-white border-b border-gray-200 dark:border-gray-700 pb-2 flex items-center gap-2">
            <IconQuestionMark size={18} />
            {t('settings.Popular Questions')}
          </h3>

          <div className="space-y-2">
            {topFaqs.map((faq, index) => (
              <div
                key={index}
                className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
              >
                <button
                  onClick={() =>
                    setExpandedFaq(expandedFaq === index ? null : index)
                  }
                  className="w-full flex items-center justify-between gap-3 p-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    {faq.question}
                  </span>
                  <IconChevronRight
                    size={16}
                    className={`text-gray-400 flex-shrink-0 transition-transform ${
                      expandedFaq === index ? 'rotate-90' : ''
                    }`}
                  />
                </button>

                {expandedFaq === index && (
                  <div className="px-3 pb-3 pt-0">
                    <div className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-line">
                      {renderTextWithLinks(faq.answer)}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <Link
            href="/info/help"
            className="mt-4 flex items-center justify-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            {t('settings.View all FAQs')}
            <IconExternalLink size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
};

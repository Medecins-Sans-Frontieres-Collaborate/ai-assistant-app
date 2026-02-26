import { detectOrganizationFromEmail } from '@/lib/utils/shared/organization';

import { MSFOrganization } from '@/types/organization';

import { HelpPageClient } from './HelpPageClient';

import { auth } from '@/auth';
// Import FAQ translations statically at build time
import messagesAm from '@/messages/am.json';
import messagesAr from '@/messages/ar.json';
import messagesBn from '@/messages/bn.json';
import messagesCa from '@/messages/ca.json';
import messagesCs from '@/messages/cs.json';
import messagesDe from '@/messages/de.json';
import messagesEn from '@/messages/en.json';
import messagesEs from '@/messages/es.json';
import messagesFa from '@/messages/fa.json';
import messagesFi from '@/messages/fi.json';
import messagesFr from '@/messages/fr.json';
import messagesHe from '@/messages/he.json';
import messagesHi from '@/messages/hi.json';
import messagesId from '@/messages/id.json';
import messagesIt from '@/messages/it.json';
import messagesJa from '@/messages/ja.json';
import messagesKo from '@/messages/ko.json';
import messagesMy from '@/messages/my.json';
import messagesNl from '@/messages/nl.json';
import messagesPl from '@/messages/pl.json';
import messagesPt from '@/messages/pt.json';
import messagesRo from '@/messages/ro.json';
import messagesRu from '@/messages/ru.json';
import messagesSi from '@/messages/si.json';
import messagesSv from '@/messages/sv.json';
import messagesSw from '@/messages/sw.json';
import messagesTe from '@/messages/te.json';
import messagesTh from '@/messages/th.json';
import messagesTr from '@/messages/tr.json';
import messagesUk from '@/messages/uk.json';
import messagesUr from '@/messages/ur.json';
import messagesVi from '@/messages/vi.json';
import messagesZh from '@/messages/zh.json';

interface PageProps {
  params: Promise<{
    locale: string;
  }>;
}

interface FAQItem {
  question: string;
  answer: string;
}

interface HelpSection {
  items: FAQItem[];
}

interface MessagesHelp {
  faq?: HelpSection;
  privacy?: HelpSection;
}

interface Messages {
  help?: MessagesHelp;
  [key: string]: any;
}

// Define all available FAQ locales (all 33 supported languages)
const AVAILABLE_FAQ_LOCALES = [
  'am',
  'en',
  'es',
  'ar',
  'bn',
  'ca',
  'cs',
  'de',
  'fa',
  'fi',
  'fr',
  'he',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'my',
  'nl',
  'pl',
  'pt',
  'ro',
  'ru',
  'si',
  'sv',
  'sw',
  'te',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh',
] as const;

// Map of all message files by locale
const allMessages: Record<string, Messages> = {
  am: messagesAm,
  ar: messagesAr,
  bn: messagesBn,
  ca: messagesCa,
  cs: messagesCs,
  de: messagesDe,
  en: messagesEn,
  es: messagesEs,
  fa: messagesFa,
  fi: messagesFi,
  fr: messagesFr,
  he: messagesHe,
  hi: messagesHi,
  id: messagesId,
  it: messagesIt,
  ja: messagesJa,
  ko: messagesKo,
  my: messagesMy,
  nl: messagesNl,
  pl: messagesPl,
  pt: messagesPt,
  ro: messagesRo,
  ru: messagesRu,
  si: messagesSi,
  sv: messagesSv,
  sw: messagesSw,
  te: messagesTe,
  th: messagesTh,
  tr: messagesTr,
  uk: messagesUk,
  ur: messagesUr,
  vi: messagesVi,
  zh: messagesZh,
};

// Helper function to safely extract help items from message files
const extractHelpItems = (
  section: 'faq' | 'privacy',
): Record<string, FAQItem[]> => {
  return Object.fromEntries(
    AVAILABLE_FAQ_LOCALES.map((locale) => [
      locale,
      allMessages[locale]?.help?.[section]?.items || [],
    ]),
  );
};

// Pre-bundle all FAQ and Privacy translations from locale message files
const faqTranslations = extractHelpItems('faq');
const privacyTranslations = extractHelpItems('privacy');

export default async function HelpPage({ params }: PageProps) {
  const session = await auth();
  const { locale } = await params;

  // Detect organization from user's email for server-side rendering
  const detectedOrg = detectOrganizationFromEmail(session?.user?.mail);

  // Determine initial locale - use user's locale if available, otherwise English
  const initialLocale = AVAILABLE_FAQ_LOCALES.includes(locale as any)
    ? locale
    : 'en';

  return (
    <HelpPageClient
      session={session}
      detectedOrganization={detectedOrg.organization as MSFOrganization}
      faqTranslations={faqTranslations}
      privacyTranslations={privacyTranslations}
      initialLocale={initialLocale}
      availableLocales={[...AVAILABLE_FAQ_LOCALES]}
    />
  );
}

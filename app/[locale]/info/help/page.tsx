import { HelpPageClient } from './HelpPageClient';

import { auth } from '@/auth';
import helpCenterAr from '@/lib/data/helpCenter.ar.json';
import helpCenterDe from '@/lib/data/helpCenter.de.json';
// Import unified helpCenter files statically at build time
import helpCenterEn from '@/lib/data/helpCenter.en.json';
import helpCenterEs from '@/lib/data/helpCenter.es.json';
import helpCenterFr from '@/lib/data/helpCenter.fr.json';
import helpCenterHi from '@/lib/data/helpCenter.hi.json';
import helpCenterIt from '@/lib/data/helpCenter.it.json';
import helpCenterJa from '@/lib/data/helpCenter.ja.json';
import helpCenterNl from '@/lib/data/helpCenter.nl.json';
import helpCenterPt from '@/lib/data/helpCenter.pt.json';
import helpCenterRu from '@/lib/data/helpCenter.ru.json';
import helpCenterSw from '@/lib/data/helpCenter.sw.json';
import helpCenterZh from '@/lib/data/helpCenter.zh.json';
import messagesAr from '@/messages/ar.json';
import messagesDe from '@/messages/de.json';
// Import UI translations
import messagesEn from '@/messages/en.json';
import messagesEs from '@/messages/es.json';
import messagesFr from '@/messages/fr.json';
import messagesHi from '@/messages/hi.json';
import messagesIt from '@/messages/it.json';
import messagesJa from '@/messages/ja.json';
import messagesNl from '@/messages/nl.json';
import messagesPt from '@/messages/pt.json';
import messagesRu from '@/messages/ru.json';
import messagesSw from '@/messages/sw.json';
import messagesZh from '@/messages/zh.json';

interface PageProps {
  params: Promise<{
    locale: string;
  }>;
}

// Define available FAQ locales
const AVAILABLE_FAQ_LOCALES = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'ar',
  'nl',
  'ru',
  'zh',
  'ja',
  'hi',
  'sw',
] as const;

// Pre-bundle all FAQ translations
const faqTranslations: Record<string, any> = {
  en: helpCenterEn.faq,
  es: helpCenterEs.faq,
  fr: helpCenterFr.faq,
  de: helpCenterDe.faq,
  it: helpCenterIt.faq,
  pt: helpCenterPt.faq,
  ar: helpCenterAr.faq,
  nl: helpCenterNl.faq,
  ru: helpCenterRu.faq,
  zh: helpCenterZh.faq,
  ja: helpCenterJa.faq,
  hi: helpCenterHi.faq,
  sw: helpCenterSw.faq,
};

const privacyTranslations: Record<string, any> = {
  en: helpCenterEn.privacyPolicy.items,
  es: helpCenterEs.privacyPolicy.items,
  fr: helpCenterFr.privacyPolicy.items,
  de: helpCenterDe.privacyPolicy.items,
  it: helpCenterIt.privacyPolicy.items,
  pt: helpCenterPt.privacyPolicy.items,
  ar: helpCenterAr.privacyPolicy.items,
  nl: helpCenterNl.privacyPolicy.items,
  ru: helpCenterRu.privacyPolicy.items,
  zh: helpCenterZh.privacyPolicy.items,
  ja: helpCenterJa.privacyPolicy.items,
  hi: helpCenterHi.privacyPolicy.items,
  sw: helpCenterSw.privacyPolicy.items,
};

const contactTranslations: Record<string, any> = {
  en: helpCenterEn.contact,
  es: helpCenterEs.contact,
  fr: helpCenterFr.contact,
  de: helpCenterDe.contact,
  it: helpCenterIt.contact,
  pt: helpCenterPt.contact,
  ar: helpCenterAr.contact,
  nl: helpCenterNl.contact,
  ru: helpCenterRu.contact,
  zh: helpCenterZh.contact,
  ja: helpCenterJa.contact,
  hi: helpCenterHi.contact,
  sw: helpCenterSw.contact,
};

const uiTranslations: Record<string, any> = {
  en: messagesEn.help,
  es: messagesEs.help,
  fr: messagesFr.help,
  de: messagesDe.help,
  it: messagesIt.help,
  pt: messagesPt.help,
  ar: messagesAr.help,
  nl: messagesNl.help,
  ru: messagesRu.help,
  zh: messagesZh.help,
  ja: messagesJa.help,
  hi: messagesHi.help,
  sw: messagesSw.help,
};

export default async function HelpPage({ params }: PageProps) {
  const session = await auth();
  const { locale } = await params;
  const isUSUser = session?.user?.region === 'US';
  const supportEmail = isUSUser
    ? 'ai@newyork.msf.org'
    : 'ai.team@amsterdam.msf.org';

  // Determine initial locale - use user's locale if available, otherwise English
  const initialLocale = AVAILABLE_FAQ_LOCALES.includes(locale as any)
    ? locale
    : 'en';

  return (
    <HelpPageClient
      isUSUser={isUSUser}
      supportEmail={supportEmail}
      faqTranslations={faqTranslations}
      privacyTranslations={privacyTranslations}
      contactTranslations={contactTranslations}
      uiTranslations={uiTranslations}
      initialLocale={initialLocale}
      availableLocales={[...AVAILABLE_FAQ_LOCALES]}
    />
  );
}

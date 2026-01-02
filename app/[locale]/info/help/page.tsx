import { HelpPageClient } from './HelpPageClient';

import { auth } from '@/auth';
import helpCenterAr from '@/lib/data/helpCenter.ar.json';
import helpCenterDe from '@/lib/data/helpCenter.de.json';
// Import unified helpCenter files statically at build time
import helpCenterEn from '@/lib/data/helpCenter.en.json';
import helpCenterEs from '@/lib/data/helpCenter.es.json';
import helpCenterFr from '@/lib/data/helpCenter.fr.json';
import helpCenterIt from '@/lib/data/helpCenter.it.json';
import helpCenterNl from '@/lib/data/helpCenter.nl.json';
import helpCenterPt from '@/lib/data/helpCenter.pt.json';
import messagesAr from '@/messages/ar.json';
import messagesDe from '@/messages/de.json';
// Import UI translations
import messagesEn from '@/messages/en.json';
import messagesEs from '@/messages/es.json';
import messagesFr from '@/messages/fr.json';
import messagesIt from '@/messages/it.json';
import messagesNl from '@/messages/nl.json';
import messagesPt from '@/messages/pt.json';

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

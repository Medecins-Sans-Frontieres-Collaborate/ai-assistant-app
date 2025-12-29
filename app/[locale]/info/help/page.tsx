import { HelpPageClient } from './HelpPageClient';

import { auth } from '@/auth';
import contactEn from '@/lib/data/contact.en.json';
import contactEs from '@/lib/data/contact.es.json';
import contactFr from '@/lib/data/contact.fr.json';
// Import FAQ translations statically at build time
import faqEn from '@/lib/data/faq.en.json';
import faqEs from '@/lib/data/faq.es.json';
import faqFr from '@/lib/data/faq.fr.json';
import privacyEn from '@/lib/data/privacyPolicy.en.json';
import privacyEs from '@/lib/data/privacyPolicy.es.json';
import privacyFr from '@/lib/data/privacyPolicy.fr.json';
import messagesEn from '@/messages/en.json';
import messagesEs from '@/messages/es.json';
import messagesFr from '@/messages/fr.json';

interface PageProps {
  params: Promise<{
    locale: string;
  }>;
}

// Define available FAQ locales
const AVAILABLE_FAQ_LOCALES = ['en', 'fr', 'es'] as const;

// Pre-bundle all FAQ translations
const faqTranslations: Record<string, any> = {
  en: faqEn.faq || faqEn,
  fr: faqFr.faq || faqFr,
  es: faqEs.faq || faqEs,
};

const privacyTranslations: Record<string, any> = {
  en: privacyEn.items || privacyEn,
  fr: privacyFr.items || privacyFr,
  es: privacyEs.items || privacyEs,
};

const contactTranslations: Record<string, any> = {
  en: contactEn.contact || contactEn,
  fr: contactFr.contact || contactFr,
  es: contactEs.contact || contactEs,
};

const uiTranslations: Record<string, any> = {
  en: messagesEn.help,
  fr: messagesFr.help,
  es: messagesEs.help,
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

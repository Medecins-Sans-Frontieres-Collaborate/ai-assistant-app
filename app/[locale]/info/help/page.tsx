import { HelpPageClient } from './HelpPageClient';

import { auth } from '@/auth';
// Import FAQ translations statically at build time
import faqEn from '@/lib/data/faq.en.json';
import faqEs from '@/lib/data/faq.es.json';
import faqFr from '@/lib/data/faq.fr.json';

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
      initialLocale={initialLocale}
      availableLocales={[...AVAILABLE_FAQ_LOCALES]}
    />
  );
}

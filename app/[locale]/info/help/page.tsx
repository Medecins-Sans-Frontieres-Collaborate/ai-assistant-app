import { HelpPageClient } from './HelpPageClient';

import { auth } from '@/auth';
// Import unified helpCenter files statically at build time
import helpCenterAm from '@/lib/data/helpCenter.am.json';
import helpCenterAr from '@/lib/data/helpCenter.ar.json';
import helpCenterBn from '@/lib/data/helpCenter.bn.json';
import helpCenterDe from '@/lib/data/helpCenter.de.json';
import helpCenterEn from '@/lib/data/helpCenter.en.json';
import helpCenterEs from '@/lib/data/helpCenter.es.json';
import helpCenterFa from '@/lib/data/helpCenter.fa.json';
import helpCenterFr from '@/lib/data/helpCenter.fr.json';
import helpCenterHi from '@/lib/data/helpCenter.hi.json';
import helpCenterId from '@/lib/data/helpCenter.id.json';
import helpCenterIt from '@/lib/data/helpCenter.it.json';
import helpCenterJa from '@/lib/data/helpCenter.ja.json';
import helpCenterKo from '@/lib/data/helpCenter.ko.json';
import helpCenterNl from '@/lib/data/helpCenter.nl.json';
import helpCenterPt from '@/lib/data/helpCenter.pt.json';
import helpCenterRu from '@/lib/data/helpCenter.ru.json';
import helpCenterSw from '@/lib/data/helpCenter.sw.json';
import helpCenterTh from '@/lib/data/helpCenter.th.json';
import helpCenterTr from '@/lib/data/helpCenter.tr.json';
import helpCenterUk from '@/lib/data/helpCenter.uk.json';
import helpCenterUr from '@/lib/data/helpCenter.ur.json';
import helpCenterVi from '@/lib/data/helpCenter.vi.json';
import helpCenterZh from '@/lib/data/helpCenter.zh.json';
// Import UI translations
import messagesAm from '@/messages/am.json';
import messagesAr from '@/messages/ar.json';
import messagesBn from '@/messages/bn.json';
import messagesDe from '@/messages/de.json';
import messagesEn from '@/messages/en.json';
import messagesEs from '@/messages/es.json';
import messagesFa from '@/messages/fa.json';
import messagesFr from '@/messages/fr.json';
import messagesHi from '@/messages/hi.json';
import messagesId from '@/messages/id.json';
import messagesIt from '@/messages/it.json';
import messagesJa from '@/messages/ja.json';
import messagesKo from '@/messages/ko.json';
import messagesNl from '@/messages/nl.json';
import messagesPt from '@/messages/pt.json';
import messagesRu from '@/messages/ru.json';
import messagesSw from '@/messages/sw.json';
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

// Define available FAQ locales
const AVAILABLE_FAQ_LOCALES = [
  'am',
  'ar',
  'bn',
  'de',
  'en',
  'es',
  'fa',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'nl',
  'pt',
  'ru',
  'sw',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh',
] as const;

// Pre-bundle all FAQ translations
const faqTranslations: Record<string, any> = {
  am: helpCenterAm.faq,
  ar: helpCenterAr.faq,
  bn: helpCenterBn.faq,
  de: helpCenterDe.faq,
  en: helpCenterEn.faq,
  es: helpCenterEs.faq,
  fa: helpCenterFa.faq,
  fr: helpCenterFr.faq,
  hi: helpCenterHi.faq,
  id: helpCenterId.faq,
  it: helpCenterIt.faq,
  ja: helpCenterJa.faq,
  ko: helpCenterKo.faq,
  nl: helpCenterNl.faq,
  pt: helpCenterPt.faq,
  ru: helpCenterRu.faq,
  sw: helpCenterSw.faq,
  th: helpCenterTh.faq,
  tr: helpCenterTr.faq,
  uk: helpCenterUk.faq,
  ur: helpCenterUr.faq,
  vi: helpCenterVi.faq,
  zh: helpCenterZh.faq,
};

const privacyTranslations: Record<string, any> = {
  am: helpCenterAm.privacyPolicy.items,
  ar: helpCenterAr.privacyPolicy.items,
  bn: helpCenterBn.privacyPolicy.items,
  de: helpCenterDe.privacyPolicy.items,
  en: helpCenterEn.privacyPolicy.items,
  es: helpCenterEs.privacyPolicy.items,
  fa: helpCenterFa.privacyPolicy.items,
  fr: helpCenterFr.privacyPolicy.items,
  hi: helpCenterHi.privacyPolicy.items,
  id: helpCenterId.privacyPolicy.items,
  it: helpCenterIt.privacyPolicy.items,
  ja: helpCenterJa.privacyPolicy.items,
  ko: helpCenterKo.privacyPolicy.items,
  nl: helpCenterNl.privacyPolicy.items,
  pt: helpCenterPt.privacyPolicy.items,
  ru: helpCenterRu.privacyPolicy.items,
  sw: helpCenterSw.privacyPolicy.items,
  th: helpCenterTh.privacyPolicy.items,
  tr: helpCenterTr.privacyPolicy.items,
  uk: helpCenterUk.privacyPolicy.items,
  ur: helpCenterUr.privacyPolicy.items,
  vi: helpCenterVi.privacyPolicy.items,
  zh: helpCenterZh.privacyPolicy.items,
};

const contactTranslations: Record<string, any> = {
  am: helpCenterAm.contact,
  ar: helpCenterAr.contact,
  bn: helpCenterBn.contact,
  de: helpCenterDe.contact,
  en: helpCenterEn.contact,
  es: helpCenterEs.contact,
  fa: helpCenterFa.contact,
  fr: helpCenterFr.contact,
  hi: helpCenterHi.contact,
  id: helpCenterId.contact,
  it: helpCenterIt.contact,
  ja: helpCenterJa.contact,
  ko: helpCenterKo.contact,
  nl: helpCenterNl.contact,
  pt: helpCenterPt.contact,
  ru: helpCenterRu.contact,
  sw: helpCenterSw.contact,
  th: helpCenterTh.contact,
  tr: helpCenterTr.contact,
  uk: helpCenterUk.contact,
  ur: helpCenterUr.contact,
  vi: helpCenterVi.contact,
  zh: helpCenterZh.contact,
};

const uiTranslations: Record<string, any> = {
  am: messagesAm.help,
  ar: messagesAr.help,
  bn: messagesBn.help,
  de: messagesDe.help,
  en: messagesEn.help,
  es: messagesEs.help,
  fa: messagesFa.help,
  fr: messagesFr.help,
  hi: messagesHi.help,
  id: messagesId.help,
  it: messagesIt.help,
  ja: messagesJa.help,
  ko: messagesKo.help,
  nl: messagesNl.help,
  pt: messagesPt.help,
  ru: messagesRu.help,
  sw: messagesSw.help,
  th: messagesTh.help,
  tr: messagesTr.help,
  uk: messagesUk.help,
  ur: messagesUr.help,
  vi: messagesVi.help,
  zh: messagesZh.help,
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

'use client';

import {
  IconArrowLeft,
  IconBolt,
  IconCheck,
  IconCirclePlus,
  IconDeviceMobile,
  IconLanguage,
  IconSparkles,
  IconVolume,
  IconWorld,
} from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { AzureAIIcon } from '@/components/Icons/providers/AzureAIIcon';

import { Link } from '@/lib/navigation';

export default function WelcomeV2Page() {
  const t = useTranslations();
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 pb-20">
      {/* Back Button */}
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 mb-6"
      >
        <IconArrowLeft size={16} />
        {t('welcomeV2.backToChat')}
      </Link>

      {/* Header */}
      <div className="mb-12 text-center">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="p-3 bg-gradient-to-br from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 rounded-2xl border border-blue-200 dark:border-blue-800 shadow-lg">
            <IconSparkles
              size={40}
              className="text-blue-600 dark:text-blue-400"
            />
          </div>
        </div>
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
          {t('welcomeV2.title')}
        </h1>
        <p className="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
          {t('welcomeV2.subtitle')}
        </p>
      </div>

      {/* What's New */}
      <div className="space-y-8">
        {/* Web Search Mode */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="p-2.5 bg-blue-100 dark:bg-blue-900/30 rounded-xl shrink-0">
              <IconWorld
                size={28}
                className="text-blue-600 dark:text-blue-400"
              />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-xl text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.webSearch.title')}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('welcomeV2.webSearch.description')}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.webSearch.quickAccess')}
              </p>
              <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                <IconCirclePlus size={16} />
                <span>{t('welcomeV2.webSearch.quickAccessInstructions')}</span>
              </div>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.webSearch.setAsDefault')}
              </p>
              <p className="text-gray-600 dark:text-gray-400 mb-2">
                {t('welcomeV2.webSearch.setAsDefaultInstructions')}
              </p>
              <ul className="space-y-2 ml-4">
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {t('welcomeV2.webSearch.privacyFocused')}
                    </span>
                    <span className="text-gray-600 dark:text-gray-400">
                      {' '}
                      - {t('welcomeV2.webSearch.privacyFocusedDescription')}
                    </span>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {t('welcomeV2.webSearch.azureAIFoundry')}
                    </span>
                    <span className="text-gray-600 dark:text-gray-400">
                      {' '}
                      - {t('welcomeV2.webSearch.azureAIFoundryDescription')}
                    </span>
                  </div>
                </li>
              </ul>
            </div>

            <Link
              href="/info/search-mode"
              className="inline-block text-blue-600 dark:text-blue-400 hover:underline"
            >
              {t('welcomeV2.webSearch.learnMore')}
            </Link>
          </div>
        </div>

        {/* Tones */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="p-2.5 bg-purple-100 dark:bg-purple-900/30 rounded-xl shrink-0">
              <IconVolume
                size={28}
                className="text-purple-600 dark:text-purple-400"
              />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-xl text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.tones.title')}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('welcomeV2.tones.description')}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.tones.createTones')}
              </p>
              <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                <IconBolt size={16} />
                <span>{t('welcomeV2.tones.createTonesInstructions')}</span>
              </div>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.tones.useTones')}
              </p>
              <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 mb-3">
                <IconVolume size={16} className="text-purple-500" />
                <span>{t('welcomeV2.tones.useTonesInstructions')}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2 border-2 border-purple-500 bg-purple-50 dark:bg-purple-900/20 rounded">
                  <div className="font-medium text-gray-900 dark:text-white">
                    {t('Professional')}
                  </div>
                  <div className="text-gray-600 dark:text-gray-400">
                    {t('welcomeV2.tones.exampleProfessionalDesc')}
                  </div>
                </div>
                <div className="p-2 border border-gray-200 dark:border-gray-700 rounded">
                  <div className="font-medium text-gray-900 dark:text-white">
                    {t('Casual')}
                  </div>
                  <div className="text-gray-600 dark:text-gray-400">
                    {t('welcomeV2.tones.exampleCasualDesc')}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* AI Assist */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="p-2.5 bg-pink-100 dark:bg-pink-900/30 rounded-xl shrink-0">
              <IconSparkles
                size={28}
                className="text-pink-600 dark:text-pink-400"
              />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-xl text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.aiAssist.title')}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('welcomeV2.aiAssist.description')}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
              <span>1.</span>
              <IconBolt size={16} />
              <span>{t('welcomeV2.aiAssist.step1')}</span>
            </div>

            <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
              <span>
                2. {t('welcomeV2.aiAssist.step2Prefix')}{' '}
                <strong className="text-gray-900 dark:text-white">
                  {t('Prompts')}
                </strong>{' '}
                {t('or')}{' '}
                <strong className="text-gray-900 dark:text-white">
                  {t('Tones')}
                </strong>{' '}
                {t('welcomeV2.aiAssist.step2Suffix')}
              </span>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <IconSparkles
                  size={16}
                  className="text-pink-600 dark:text-pink-400"
                />
                3. {t('welcomeV2.aiAssist.step3')}
              </p>
              <ul className="space-y-2 ml-4">
                <li className="flex items-start gap-2 text-gray-600 dark:text-gray-400">
                  <span className="text-pink-500 mt-1">✨</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {t('welcomeV2.aiAssist.getSuggestions')}
                    </span>
                    <span> - {t('welcomeV2.aiAssist.getSuggestionsDesc')}</span>
                  </div>
                </li>
                <li className="flex items-start gap-2 text-gray-600 dark:text-gray-400">
                  <span className="text-pink-500 mt-1">✨</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {t('welcomeV2.aiAssist.buildFromFiles')}
                    </span>
                    <span> - {t('welcomeV2.aiAssist.buildFromFilesDesc')}</span>
                  </div>
                </li>
                <li className="flex items-start gap-2 text-gray-600 dark:text-gray-400">
                  <span className="text-pink-500 mt-1">✨</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {t('welcomeV2.aiAssist.testBeforeSaving')}
                    </span>
                    <span>
                      {' '}
                      - {t('welcomeV2.aiAssist.testBeforeSavingDesc')}
                    </span>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Custom Agents - ADVANCED FEATURE */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="p-2.5 bg-gradient-to-br from-blue-100 to-purple-100 dark:from-blue-900/30 dark:to-purple-900/30 rounded-xl shrink-0">
              <AzureAIIcon className="w-7 h-7" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="font-bold text-xl text-gray-900 dark:text-white">
                  {t('welcomeV2.customAgents.title')}
                </h3>
                <span className="px-2 py-0.5 text-xs font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 rounded-md border border-amber-300 dark:border-amber-700">
                  {t('welcomeV2.customAgents.advancedBadge')}
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('welcomeV2.customAgents.description')}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
                <span className="text-lg">⚠️</span>
                <div>
                  <p className="font-semibold mb-1">
                    {t('welcomeV2.customAgents.advancedFeature')}
                  </p>
                  <p className="text-xs">
                    {t('welcomeV2.customAgents.advancedFeatureDesc')}
                  </p>
                </div>
              </div>
            </div>

            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.customAgents.howToAccess')}
              </p>
              <p className="text-gray-600 dark:text-gray-400">
                {t('welcomeV2.customAgents.howToAccessInstructions')}
              </p>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.customAgents.whatYouCanDo')}
              </p>
              <ul className="space-y-1.5 ml-4 text-gray-600 dark:text-gray-400">
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <span>{t('welcomeV2.customAgents.configureAgents')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <span>{t('welcomeV2.customAgents.importExport')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <span>{t('welcomeV2.customAgents.selectFromDropdown')}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Translation */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="p-2.5 bg-green-100 dark:bg-green-900/30 rounded-xl shrink-0">
              <IconLanguage
                size={28}
                className="text-green-600 dark:text-green-400"
              />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-xl text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.audioTranslation.title')}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('welcomeV2.audioTranslation.description')}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.audioTranslation.howToUse')}
              </p>
              <ol className="space-y-1.5 ml-4 text-gray-600 dark:text-gray-400">
                <li>1. {t('welcomeV2.audioTranslation.step1')}</li>
                <li>2. {t('welcomeV2.audioTranslation.step2')}</li>
                <li>3. {t('welcomeV2.audioTranslation.step3')}</li>
              </ol>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.audioTranslation.availableLanguages')}
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  { key: 'languageSpanish' },
                  { key: 'languageFrench' },
                  { key: 'languageArabic' },
                  { key: 'languageChinese' },
                  { key: 'languageSwahili' },
                  { key: 'languagePortuguese' },
                ].map((lang) => (
                  <span
                    key={lang.key}
                    className="px-2.5 py-1 text-xs bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-md border border-green-200 dark:border-green-800"
                  >
                    {t(lang.key)}
                  </span>
                ))}
                <span className="px-2.5 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-md">
                  {t('welcomeV2.audioTranslation.moreLanguages')}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Language Support */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="p-2.5 bg-emerald-100 dark:bg-emerald-900/30 rounded-xl shrink-0">
              <IconLanguage
                size={28}
                className="text-emerald-600 dark:text-emerald-400"
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="font-bold text-xl text-gray-900 dark:text-white">
                  {t('welcomeV2.languageSupport.title')}
                </h3>
                <span className="px-2 py-0.5 text-xs font-semibold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 rounded-md border border-emerald-300 dark:border-emerald-700">
                  +21
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('welcomeV2.languageSupport.description')}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2">
              {[
                'Soomaali',
                'ትግርኛ',
                'پښتو',
                'Hausa',
                'Lingála',
                'Kurdî',
                'Kreyòl Ayisyen',
                'தமிழ்',
                'ខ្មែរ',
                'Sängö',
              ].map((lang) => (
                <span
                  key={lang}
                  className="px-2.5 py-1 text-xs bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 rounded-md border border-emerald-200 dark:border-emerald-800"
                >
                  {lang}
                </span>
              ))}
              <span className="px-2.5 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-md">
                {t('welcomeV2.languageSupport.andMore')}
              </span>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-2">
              <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                <IconCheck
                  size={16}
                  className="text-emerald-600 dark:text-emerald-400 flex-shrink-0"
                />
                <span>{t('welcomeV2.languageSupport.autoDetect')}</span>
              </div>
              <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                <IconCheck
                  size={16}
                  className="text-emerald-600 dark:text-emerald-400 flex-shrink-0"
                />
                <span>{t('welcomeV2.languageSupport.manualSwitch')}</span>
              </div>
            </div>
          </div>
        </div>

        {/* PWA */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="p-2.5 bg-purple-100 dark:bg-purple-900/30 rounded-xl shrink-0">
              <IconDeviceMobile
                size={28}
                className="text-purple-600 dark:text-purple-400"
              />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-xl text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.pwa.title')}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('welcomeV2.pwa.description')}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div className="mb-3 p-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
              <p className="text-xs text-blue-800 dark:text-blue-200 font-semibold">
                💡 {t('welcomeV2.pwa.installTip')}
              </p>
            </div>
            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.pwa.howToInstall')}
              </p>
              <ol className="space-y-1.5 ml-4 text-gray-600 dark:text-gray-400">
                <li>1. {t('welcomeV2.pwa.step1')}</li>
                <li>2. {t('welcomeV2.pwa.step2')}</li>
                <li>3. {t('welcomeV2.pwa.step3')}</li>
                <li>4. {t('welcomeV2.pwa.step4')}</li>
                <li>5. {t('welcomeV2.pwa.step5')}</li>
              </ol>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                {t('welcomeV2.pwa.benefits')}
              </p>
              <ul className="space-y-1.5 ml-4">
                <li className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <IconCheck
                    size={16}
                    className="text-purple-600 dark:text-purple-400 flex-shrink-0"
                  />
                  <span>{t('welcomeV2.pwa.benefit1')}</span>
                </li>
                <li className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <IconCheck
                    size={16}
                    className="text-purple-600 dark:text-purple-400 flex-shrink-0"
                  />
                  <span>{t('welcomeV2.pwa.benefit2')}</span>
                </li>
                <li className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <IconCheck
                    size={16}
                    className="text-purple-600 dark:text-purple-400 flex-shrink-0"
                  />
                  <span>{t('welcomeV2.pwa.benefit3')}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

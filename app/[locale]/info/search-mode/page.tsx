'use client';

import {
  IconArrowLeft,
  IconInfoCircle,
  IconShield,
  IconWorld,
} from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { CollapsibleDiagram } from './CollapsibleDiagram';

import { Link } from '@/lib/navigation';

export default function SearchModeInfoPage() {
  const t = useTranslations();
  // Mermaid diagram for No Search Mode
  const noSearchModeDiagram = `
    flowchart TB
      Start([👤 You send a message])

      subgraph Browser["💾 YOUR BROWSER"]
        LocalStorage[Full conversation<br/>stored locally]
      end

      subgraph OurServer["🔄 AI ASSISTANT SERVER"]
        Backend[Receive & route message]
        FormatResponse[Format response]
      end

      subgraph AzureOpenAI["🤖 AZURE OPENAI"]
        Model[GPT Model<br/>Generate response<br/>Stateless - no memory]
      end

      Start --> LocalStorage
      LocalStorage --> Backend
      Backend --> Model
      Model --> FormatResponse
      FormatResponse --> LocalStorage

      style Browser fill:#d4edda,stroke:#28a745,stroke-width:3px
      style OurServer fill:#e3f2fd,stroke:#1976d2,stroke-width:3px
      style AzureOpenAI fill:#f3e5f5,stroke:#7b1fa2,stroke-width:3px
  `;

  // Mermaid diagram for Privacy-Focused Mode
  const privacyModeDiagram = `
    flowchart TB
      Start([👤 You send a message])

      subgraph Browser["💾 YOUR BROWSER"]
        LocalStorage[Full conversation<br/>stored locally]
      end

      subgraph OurServer["🔄 AI ASSISTANT SERVER"]
        Backend1[Receive message]
        Decision{Search needed?}
        CreateQuery[Create search query<br/>only query, not conversation]
        ProcessResults[Process search results]
        FormatResponse[Format response]
      end

      subgraph AzureFoundry["☁️ AZURE AI FOUNDRY"]
        StoreQuery[(💾 Database<br/>Stores search query<br/>+ thread ID)]
        WebSearch[🌐 Execute web search]
      end

      subgraph AzureOpenAI["🤖 AZURE OPENAI"]
        MiniModel[⚡ Mini Fast Model<br/>Check: need web search?<br/>Stateless - no memory]
        MainModel[GPT Model<br/>Generate response<br/>Stateless - no memory]
      end

      Start --> LocalStorage
      LocalStorage --> Backend1
      Backend1 --> MiniModel
      MiniModel --> Decision

      Decision -->|Yes| CreateQuery
      CreateQuery --> StoreQuery
      StoreQuery --> WebSearch
      WebSearch --> ProcessResults
      ProcessResults --> MainModel

      Decision -->|No| MainModel

      MainModel --> FormatResponse
      FormatResponse --> LocalStorage

      style Browser fill:#d4edda,stroke:#28a745,stroke-width:3px
      style OurServer fill:#e3f2fd,stroke:#1976d2,stroke-width:3px
      style AzureFoundry fill:#fff3cd,stroke:#ffc107,stroke-width:3px
      style AzureOpenAI fill:#f3e5f5,stroke:#7b1fa2,stroke-width:3px
  `;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 pb-20">
      {/* Back Button */}
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 mb-6"
      >
        <IconArrowLeft size={16} />
        {t('searchMode.backToChat')}
      </Link>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <IconWorld size={32} className="text-blue-600 dark:text-blue-400" />
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            {t('searchMode.title')}
          </h1>
        </div>
        <p className="text-lg text-gray-600 dark:text-gray-400">
          {t('searchMode.subtitle')}
        </p>
      </div>

      {/* Comparison Chart - Moved to Top */}
      <div className="mb-8">
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          {t('searchMode.quickComparison')}
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse bg-white dark:bg-gray-800 rounded-lg overflow-hidden">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-700">
                <th className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white"></th>
                <th className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm font-semibold text-gray-900 dark:text-white">
                  {t('searchMode.noSearch')}
                </th>
                <th className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm font-semibold text-gray-900 dark:text-white">
                  <div className="flex items-center justify-center gap-2">
                    <IconShield
                      size={16}
                      className="text-green-600 dark:text-green-400"
                    />
                    {t('searchMode.privacyFocused')}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-medium text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700/50">
                  {t('searchMode.responseSpeed')}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-green-600 dark:text-green-400 font-semibold">
                  {t('searchMode.fastest')}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-amber-600 dark:text-amber-400">
                  {t('searchMode.slowerMultiStep')}
                </td>
              </tr>
              <tr>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-medium text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700/50">
                  {t('searchMode.fullConversationStored')}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-green-600 dark:text-green-400 font-semibold">
                  {t('common.no')}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-green-600 dark:text-green-400 font-semibold">
                  {t('common.no')}
                </td>
              </tr>
              <tr>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-medium text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700/50">
                  {t('searchMode.whatsStoredInAzure')}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                  {t('searchMode.nothingStateless')}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                  {t('searchMode.searchQueriesOnly')}
                </td>
              </tr>
              <tr>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-medium text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700/50">
                  {t('searchMode.modelAvailability')}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-gray-700 dark:text-gray-300">
                  {t('searchMode.allModels')}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-gray-700 dark:text-gray-300">
                  {t('searchMode.allModels')}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* No Search Mode */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <IconWorld size={28} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
            {t('searchMode.searchTurnedOff')}
          </h2>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 mb-4">
          <p className="text-gray-700 dark:text-gray-300 mb-4">
            {t('searchMode.noSearchDescription')}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            {t('searchMode.viewDetailsBelow')}
          </p>
        </div>

        {/* Collapsible Diagram */}
        <CollapsibleDiagram
          title={t('searchMode.viewTechnicalFlowDiagram')}
          diagram={noSearchModeDiagram}
          legend={t('searchMode.legendNoSearch')}
        />
      </div>

      {/* Privacy-Focused Mode */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <IconShield
            size={28}
            className="text-green-600 dark:text-green-400"
          />
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
            {t('searchMode.privacyFocusedMode')}
          </h2>
          <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 rounded">
            {t('searchMode.default')}
          </span>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 mb-4">
          <p className="text-gray-700 dark:text-gray-300 mb-4">
            {t('searchMode.privacyDescription')}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            {t('searchMode.viewDetailsBelow')}
          </p>
        </div>

        {/* Collapsible Diagram */}
        <CollapsibleDiagram
          title={t('searchMode.viewTechnicalFlowDiagram')}
          diagram={privacyModeDiagram}
          legend={t('searchMode.legendPrivacy')}
        />
      </div>

      {/* Background Info - Moved to Bottom */}
      <div className="mb-8 p-6 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
        <div className="flex items-start gap-3">
          <IconInfoCircle
            size={24}
            className="text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5"
          />
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-2">
              {t('searchMode.whyTheseOptions')}
            </h3>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
              {t('searchMode.whyTheseOptionsText1')}{' '}
              <a
                href="https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('searchMode.azureDeprecatedBingApi')}
              </a>
            </p>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('searchMode.whyTheseOptionsText2')}
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <p className="mb-2">
          <strong>{t('searchMode.note')}</strong> {t('searchMode.footerNote')}
        </p>
      </div>
    </div>
  );
}

import {
  IconAlertCircle,
  IconArrowLeft,
  IconInfoCircle,
  IconShield,
  IconWorld,
} from '@tabler/icons-react';

import { AzureAIIcon } from '@/components/Icons/providers';

import { CollapsibleDiagram } from './CollapsibleDiagram';

import { Link } from '@/lib/navigation';

export default function SearchModeInfoPage() {
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

  // Mermaid diagram for Azure AI Foundry Mode
  const foundryModeDiagram = `
    flowchart TB
      Start([👤 You send a message])

      subgraph Browser["💾 YOUR BROWSER"]
        LocalStorage[Full conversation<br/>stored locally]
      end

      subgraph OurServer["🔄 AI ASSISTANT SERVER"]
        Backend[Route to Foundry Agent]
        ReceiveResponse[Receive streaming response]
      end

      subgraph AzureFoundry["☁️ AZURE AI FOUNDRY AGENT"]
        ThreadStorage[(🗄️ Database<br/>⚠️ Full conversation storage<br/>via thread ID)]
        RecallContext[📚 Recall full conversation<br/>from database]
        CheckSearch{Need web search?}
        WebSearch[🌐 Execute web search]
        Generate[🤖 Generate response<br/>with GPT-4.1]
        SaveResponse[(💾 Save response<br/>to database)]
      end

      Start --> LocalStorage
      LocalStorage --> Backend
      Backend --> ThreadStorage
      ThreadStorage --> RecallContext
      RecallContext --> CheckSearch

      CheckSearch -->|Yes| WebSearch
      WebSearch --> Generate

      CheckSearch -->|No| Generate

      Generate --> SaveResponse
      SaveResponse --> ReceiveResponse
      ReceiveResponse --> LocalStorage

      style Browser fill:#d4edda,stroke:#28a745,stroke-width:3px
      style OurServer fill:#e3f2fd,stroke:#1976d2,stroke-width:3px
      style AzureFoundry fill:#f8d7da,stroke:#dc3545,stroke-width:3px
  `;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 pb-20">
      {/* Back Button */}
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 mb-6"
      >
        <IconArrowLeft size={16} />
        Back to Chat
      </Link>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <IconWorld size={32} className="text-blue-600 dark:text-blue-400" />
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Search Mode Explained
          </h1>
        </div>
        <p className="text-lg text-gray-600 dark:text-gray-400">
          Understanding your search options and where your data is stored
        </p>
      </div>

      {/* Comparison Chart - Moved to Top */}
      <div className="mb-8">
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Quick Comparison
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse bg-white dark:bg-gray-800 rounded-lg overflow-hidden">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-700">
                <th className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white"></th>
                <th className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm font-semibold text-gray-900 dark:text-white">
                  No Search
                </th>
                <th className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm font-semibold text-gray-900 dark:text-white">
                  <div className="flex items-center justify-center gap-2">
                    <IconShield
                      size={16}
                      className="text-green-600 dark:text-green-400"
                    />
                    Privacy-Focused
                  </div>
                </th>
                <th className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm font-semibold text-gray-900 dark:text-white">
                  <div className="flex items-center justify-center gap-2">
                    <AzureAIIcon className="w-4 h-4" />
                    Azure AI Foundry
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-medium text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700/50">
                  Response Speed
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-green-600 dark:text-green-400 font-semibold">
                  Fastest
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-amber-600 dark:text-amber-400">
                  Slower (multi-step)
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-green-600 dark:text-green-400">
                  Faster (direct)
                </td>
              </tr>
              <tr>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-medium text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700/50">
                  Full Conversation Stored in Cloud
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-green-600 dark:text-green-400 font-semibold">
                  No
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-green-600 dark:text-green-400 font-semibold">
                  No
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-red-600 dark:text-red-400 font-semibold">
                  Yes
                </td>
              </tr>
              <tr>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-medium text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700/50">
                  What's Stored in Azure
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                  Nothing (stateless only)
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                  Search queries only
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                  Full conversation history
                </td>
              </tr>
              <tr>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-medium text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700/50">
                  Model Availability
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-gray-700 dark:text-gray-300">
                  All models
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-gray-700 dark:text-gray-300">
                  All models
                </td>
                <td className="border border-gray-300 dark:border-gray-600 px-4 py-3 text-center text-sm text-gray-700 dark:text-gray-300">
                  GPT-4.1 only
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
            Search Turned Off
          </h2>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 mb-4">
          <p className="text-gray-700 dark:text-gray-300 mb-4">
            Fastest responses with no web search capability. Your full
            conversation stays in your browser - nothing is stored in the cloud.
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            For more details, view the technical workflow below.
          </p>
        </div>

        {/* Collapsible Diagram */}
        <CollapsibleDiagram
          title="View Technical Flow Diagram"
          diagram={noSearchModeDiagram}
          legend="🟢 Your Browser (local storage) | 🔵 AI Assistant Server | 🟣 Azure OpenAI (stateless)"
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
            Privacy-Focused Mode
          </h2>
          <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 rounded">
            Default
          </span>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 mb-4">
          <p className="text-gray-700 dark:text-gray-300 mb-4">
            Uses web search when needed but is slower because more steps are
            involved. Only search queries are stored in Azure - your full
            conversation stays in your browser.
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            For more details, view the technical workflow below.
          </p>
        </div>

        {/* Collapsible Diagram */}
        <CollapsibleDiagram
          title="View Technical Flow Diagram"
          diagram={privacyModeDiagram}
          legend="🟢 Your Browser (local storage) | 🔵 AI Assistant Server | 🟡 Azure AI Foundry (search queries only) | 🟣 Azure OpenAI (stateless)"
        />
      </div>

      {/* Azure AI Foundry Mode */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <AzureAIIcon className="w-7 h-7" />
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Azure AI Foundry Mode
          </h2>
          <span className="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded">
            GPT-4.1 only
          </span>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 mb-4">
          <p className="text-gray-700 dark:text-gray-300 mb-4">
            Faster responses with web search capability built-in. Your full
            conversation is stored in Azure AI Foundry's database, not just in
            your browser.
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            For more details, view the technical workflow below.
          </p>
        </div>

        {/* Collapsible Diagram */}
        <CollapsibleDiagram
          title="View Technical Flow Diagram"
          diagram={foundryModeDiagram}
          legend="🟢 Your Browser (local storage) | 🔵 AI Assistant Server | 🔴 Azure AI Foundry Agent (stores full conversation)"
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
              Why These Options?
            </h3>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
              These are the available search implementations after{' '}
              <a
                href="https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Azure deprecated their Bing Search API
              </a>
              , which the AI Assistant originally relied on.
            </p>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              The team is actively exploring more privacy-focused search
              alternatives. Both current options use Azure AI Foundry's search
              capabilities but differ in how much conversation data is shared.
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <p className="mb-2">
          <strong>Note:</strong> Both modes store your conversation locally in
          your browser. You can switch modes anytime in the model settings.
        </p>
      </div>
    </div>
  );
}

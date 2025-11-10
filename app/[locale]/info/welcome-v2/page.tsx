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

import { AzureAIIcon } from '@/components/Icons/providers/AzureAIIcon';

import { Link } from '@/lib/navigation';

export default function WelcomeV2Page() {
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
          Welcome to AI Assistant V2
        </h1>
        <p className="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
          A complete redesign with powerful new features
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
                Web Search Mode
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Give AI access to real-time web search with privacy-focused
                options
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                Quick access:
              </p>
              <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                <IconCirclePlus size={16} />
                <span>
                  Click the + button next to chat input → Select "Web Search"
                </span>
              </div>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                Set as default:
              </p>
              <p className="text-gray-600 dark:text-gray-400 mb-2">
                Open model settings and enable Web Search Mode toggle. Choose
                between:
              </p>
              <ul className="space-y-2 ml-4">
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      Privacy-Focused (default)
                    </span>
                    <span className="text-gray-600 dark:text-gray-400">
                      {' '}
                      - Only search query sent externally
                    </span>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      Azure AI Foundry Mode
                    </span>
                    <span className="text-gray-600 dark:text-gray-400">
                      {' '}
                      - Faster, but full conversation stored externally
                    </span>
                  </div>
                </li>
              </ul>
            </div>

            <Link
              href="/info/search-mode"
              className="inline-block text-blue-600 dark:text-blue-400 hover:underline"
            >
              Learn more about search modes →
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
                Tones (Voice Profiles)
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Control AI writing style, formality, and personality
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                1. Create tones:
              </p>
              <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                <IconBolt size={16} />
                <span>Quick Actions in sidebar → Tones tab</span>
              </div>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                2. Use tones:
              </p>
              <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 mb-3">
                <IconVolume size={16} className="text-purple-500" />
                <span>Click tone dropdown next to chat input</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2 border-2 border-purple-500 bg-purple-50 dark:bg-purple-900/20 rounded">
                  <div className="font-medium text-gray-900 dark:text-white">
                    Professional
                  </div>
                  <div className="text-gray-600 dark:text-gray-400">
                    Formal, business tone
                  </div>
                </div>
                <div className="p-2 border border-gray-200 dark:border-gray-700 rounded">
                  <div className="font-medium text-gray-900 dark:text-white">
                    Casual
                  </div>
                  <div className="text-gray-600 dark:text-gray-400">
                    Friendly, conversational
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
                AI Assist for Prompts & Tones
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Let AI help you create better prompts and tones faster
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
              <span>1.</span>
              <IconBolt size={16} />
              <span>Open Quick Actions in sidebar</span>
            </div>

            <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
              <span>
                2. Navigate to{' '}
                <strong className="text-gray-900 dark:text-white">
                  Prompts
                </strong>{' '}
                or{' '}
                <strong className="text-gray-900 dark:text-white">Tones</strong>{' '}
                tab
              </span>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <IconSparkles
                  size={16}
                  className="text-pink-600 dark:text-pink-400"
                />
                3. Look for the AI Assistant panel
              </p>
              <ul className="space-y-2 ml-4">
                <li className="flex items-start gap-2 text-gray-600 dark:text-gray-400">
                  <span className="text-pink-500 mt-1">✨</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      Get suggestions
                    </span>
                    <span>
                      {' '}
                      - AI analyzes your draft and offers improvements
                    </span>
                  </div>
                </li>
                <li className="flex items-start gap-2 text-gray-600 dark:text-gray-400">
                  <span className="text-pink-500 mt-1">✨</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      Build from files
                    </span>
                    <span> - Upload documents to generate prompts/tones</span>
                  </div>
                </li>
                <li className="flex items-start gap-2 text-gray-600 dark:text-gray-400">
                  <span className="text-pink-500 mt-1">✨</span>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      Test before saving
                    </span>
                    <span> - Try out prompts/tones in a live chat preview</span>
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
                  Custom Agents
                </h3>
                <span className="px-2 py-0.5 text-xs font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 rounded-md border border-amber-300 dark:border-amber-700">
                  ADVANCED
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Specialized AI agents with enhanced capabilities like web search
                and code interpretation
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
                <span className="text-lg">⚠️</span>
                <div>
                  <p className="font-semibold mb-1">Advanced Feature</p>
                  <p className="text-xs">
                    Custom Agents run on Azure AI Foundry with specialized
                    tools. Requires coordination with the AI Assistant technical
                    team to create agent IDs.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                How to access:
              </p>
              <p className="text-gray-600 dark:text-gray-400">
                Settings → Models → <strong>Agents</strong> tab
              </p>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                What you can do:
              </p>
              <ul className="space-y-1.5 ml-4 text-gray-600 dark:text-gray-400">
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <span>Configure agents with specialized capabilities</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <span>Import/export agent configurations</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-500 mt-1">•</span>
                  <span>Select custom agents from model dropdown</span>
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
                Audio Transcription with Translation
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Automatically translate audio transcripts to 13+ languages
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                How to use:
              </p>
              <ol className="space-y-1.5 ml-4 text-gray-600 dark:text-gray-400">
                <li>1. Upload an audio or video file</li>
                <li>
                  2. Click the language dropdown in transcription interface
                </li>
                <li>3. Select your target language</li>
              </ol>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                Available languages:
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  'Spanish',
                  'French',
                  'Arabic',
                  'Chinese',
                  'Swahili',
                  'Portuguese',
                ].map((lang) => (
                  <span
                    key={lang}
                    className="px-2.5 py-1 text-xs bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-md border border-green-200 dark:border-green-800"
                  >
                    {lang}
                  </span>
                ))}
                <span className="px-2.5 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-md">
                  +7 more
                </span>
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
                Install as Mobile App
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Progressive Web App with native experience
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div className="mb-3 p-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
              <p className="text-xs text-blue-800 dark:text-blue-200 font-semibold">
                💡 Tip: Install after signing in to preserve your authentication
                and have the best experience.
              </p>
            </div>
            <div>
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                How to install:
              </p>
              <ol className="space-y-1.5 ml-4 text-gray-600 dark:text-gray-400">
                <li>1. Sign in to your account</li>
                <li>2. Open Settings → Mobile App for detailed instructions</li>
                <li>3. On mobile: Tap browser menu (⋮ or ⚙️)</li>
                <li>4. Look for "Add to Home Screen" or "Install App"</li>
                <li>5. Follow prompts to install</li>
              </ol>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-gray-900 dark:text-white mb-2">
                Benefits:
              </p>
              <ul className="space-y-1.5 ml-4">
                <li className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <IconCheck
                    size={16}
                    className="text-purple-600 dark:text-purple-400 flex-shrink-0"
                  />
                  <span>Launch like a native app from home screen</span>
                </li>
                <li className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <IconCheck
                    size={16}
                    className="text-purple-600 dark:text-purple-400 flex-shrink-0"
                  />
                  <span>Full-screen without browser UI</span>
                </li>
                <li className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <IconCheck
                    size={16}
                    className="text-purple-600 dark:text-purple-400 flex-shrink-0"
                  />
                  <span>Offline access to saved conversations</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

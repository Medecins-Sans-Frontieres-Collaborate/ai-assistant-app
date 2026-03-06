import {
  IconAdjustments,
  IconChevronDown,
  IconFiles,
  IconInfoCircle,
  IconMessage,
  IconUser,
  IconVolume,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { Session } from 'next-auth';
import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import { getUserDisplayName } from '@/lib/utils/app/user/displayName';

import { Settings } from '@/types/settings';

import { SystemPrompt } from '../SystemPrompt';
import { TTSSettingsPanel } from '../TTS/TTSSettingsPanel';
import { TemperatureSlider } from '../Temperature';

interface ChatSettingsSectionProps {
  state: Settings;
  dispatch: React.Dispatch<{
    field: keyof Settings;
    value: any;
  }>;
  homeState: any; // Type should be refined based on actual HomeContext state
  user?: Session['user'];
  onSave: () => void;
  onClose: () => void;
}

export const ChatSettingsSection: FC<ChatSettingsSectionProps> = ({
  state,
  dispatch,
  homeState,
  user,
  onSave,
  onClose,
}) => {
  const t = useTranslations();
  const [isModelResponseExpanded, setIsModelResponseExpanded] = useState(true);
  const [isAdvancedExpanded, setIsAdvancedExpanded] = useState(false);
  const [isAboutYouExpanded, setIsAboutYouExpanded] = useState(false);
  const [isTTSExpanded, setIsTTSExpanded] = useState(false);
  const [isActiveFilesExpanded, setIsActiveFilesExpanded] = useState(false);
  const {
    displayNamePreference,
    customDisplayName,
    ttsSettings,
    setTTSSettings,
    reasoningEffort,
    setReasoningEffort,
    verbosity,
    setVerbosity,
    autoPinActiveFiles,
    setAutoPinActiveFiles,
  } = useSettings();

  // Compute derived name from General Settings for placeholder
  const derivedDisplayName = getUserDisplayName(
    user,
    displayNamePreference,
    customDisplayName,
  );

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <IconMessage size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('settings.Chat Settings')}
        </h2>
      </div>

      <div className="space-y-8">
        {/* Model Response Settings Section - Collapsible */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setIsModelResponseExpanded(!isModelResponseExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <IconAdjustments
                size={18}
                className="text-gray-500 dark:text-gray-400"
              />
              <h3 className="text-sm font-bold text-black dark:text-white">
                {t('settings.Model Response Settings')}
              </h3>
            </div>
            <IconChevronDown
              size={18}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${
                isModelResponseExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>

          {isModelResponseExpanded && (
            <div className="px-4 pb-4 border-t border-gray-200 dark:border-gray-700 pt-4 space-y-6">
              {/* Info box */}
              <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 text-xs">
                <div className="flex items-start">
                  <IconInfoCircle
                    size={16}
                    className="me-2 mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-400"
                  />
                  <div className="text-blue-700 dark:text-blue-300">
                    {t('settings.Model Response Settings Description')}
                  </div>
                </div>
              </div>

              {/* Temperature Setting */}
              <div>
                <div className="text-sm font-bold mb-3 text-black dark:text-neutral-200">
                  {t('Default') + ' ' + t('Temperature') + '*'}
                </div>
                <TemperatureSlider
                  temperature={state.temperature}
                  onChangeTemperature={(temperature) =>
                    dispatch({ field: 'temperature', value: temperature })
                  }
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  {t(
                    'Higher values produce more creative and varied responses, lower values are more focused and deterministic',
                  )}
                </p>
              </div>

              {/* Reasoning Effort Setting */}
              <div>
                <div className="text-sm font-bold mb-2 text-black dark:text-neutral-200">
                  {t('settings.Default Reasoning Effort')}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(['low', 'medium', 'high'] as const).map((level) => (
                    <button
                      key={level}
                      onClick={() =>
                        setReasoningEffort(
                          reasoningEffort === level ? undefined : level,
                        )
                      }
                      className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                        reasoningEffort === level
                          ? 'bg-blue-600 text-white shadow-md'
                          : 'bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                      }`}
                    >
                      {t(`modelSelect.advancedOptions.${level}`)}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  {t('settings.reasoningEffortDescription')}
                </p>
              </div>

              {/* Verbosity Setting */}
              <div>
                <div className="text-sm font-bold mb-2 text-black dark:text-neutral-200">
                  {t('settings.Default Verbosity')}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(['low', 'medium', 'high'] as const).map((level) => (
                    <button
                      key={level}
                      onClick={() =>
                        setVerbosity(verbosity === level ? undefined : level)
                      }
                      className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                        verbosity === level
                          ? 'bg-blue-600 text-white shadow-md'
                          : 'bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                      }`}
                    >
                      {t(`modelSelect.advancedOptions.${level}`)}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  {t('settings.verbosityDescription')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Advanced Settings Section - Collapsible */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setIsAdvancedExpanded(!isAdvancedExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <h3 className="text-sm font-bold text-black dark:text-white">
              {t('settings.Advanced Settings')}
            </h3>
            <IconChevronDown
              size={18}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${
                isAdvancedExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>

          {isAdvancedExpanded && (
            <div className="px-4 pb-3 border-t border-gray-200 dark:border-gray-700">
              {/* Custom Instructions */}
              <div className="mt-3">
                <div className="text-sm font-bold mb-3 text-black dark:text-neutral-200">
                  {t('settings.Custom Instructions') + '*'}
                </div>
                <SystemPrompt
                  prompts={homeState.prompts}
                  systemPrompt={state.systemPrompt}
                  user={user}
                  onChangePrompt={(prompt) =>
                    dispatch({
                      field: 'systemPrompt',
                      value: prompt,
                    })
                  }
                />
              </div>

              {/* Streaming Speed Setting */}
              <div className="mt-4">
                <div className="text-sm font-bold mb-2 text-black dark:text-neutral-200">
                  {t('settings.Streaming Speed')}
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-black dark:text-neutral-200">
                    <input
                      type="radio"
                      name="streamingSpeed"
                      className="accent-neutral-600 dark:accent-neutral-400"
                      checked={state.streamingSpeed?.delayMs === 12}
                      onChange={() =>
                        dispatch({
                          field: 'streamingSpeed',
                          value: { charsPerBatch: 2, delayMs: 12 },
                        })
                      }
                    />
                    {t('settings.Slow')}
                  </label>
                  <label className="flex items-center gap-2 text-sm text-black dark:text-neutral-200">
                    <input
                      type="radio"
                      name="streamingSpeed"
                      className="accent-neutral-600 dark:accent-neutral-400"
                      checked={
                        state.streamingSpeed?.delayMs === 8 ||
                        !state.streamingSpeed
                      }
                      onChange={() =>
                        dispatch({
                          field: 'streamingSpeed',
                          value: { charsPerBatch: 3, delayMs: 8 },
                        })
                      }
                    />
                    {t('settings.Normal')}
                  </label>
                  <label className="flex items-center gap-2 text-sm text-black dark:text-neutral-200">
                    <input
                      type="radio"
                      name="streamingSpeed"
                      className="accent-neutral-600 dark:accent-neutral-400"
                      checked={state.streamingSpeed?.delayMs === 4}
                      onChange={() =>
                        dispatch({
                          field: 'streamingSpeed',
                          value: { charsPerBatch: 5, delayMs: 4 },
                        })
                      }
                    />
                    {t('settings.Fast')}
                  </label>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t(
                    'settings.Controls how smoothly text appears during AI responses',
                  )}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Text-to-Speech Section - Collapsible */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setIsTTSExpanded(!isTTSExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <IconVolume
                size={18}
                className="text-gray-500 dark:text-gray-400"
              />
              <h3 className="text-sm font-bold text-black dark:text-white">
                {t('settings.tts.title')}
              </h3>
            </div>
            <IconChevronDown
              size={18}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${
                isTTSExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>

          {isTTSExpanded && (
            <div className="px-4 pb-4 border-t border-gray-200 dark:border-gray-700 pt-4">
              <TTSSettingsPanel
                settings={ttsSettings}
                onChange={setTTSSettings}
              />
            </div>
          )}
        </div>

        {/* Active Files Section - Collapsible */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setIsActiveFilesExpanded(!isActiveFilesExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <IconFiles
                size={18}
                className="text-gray-500 dark:text-gray-400"
              />
              <h3 className="text-sm font-bold text-black dark:text-white">
                {t('activeFiles.title')}
              </h3>
            </div>
            <IconChevronDown
              size={18}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${
                isActiveFilesExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>

          {isActiveFilesExpanded && (
            <div className="px-4 pb-4 border-t border-gray-200 dark:border-gray-700">
              {/* Auto-pin toggle */}
              <label className="flex items-center gap-3 mt-4 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-neutral-600 dark:accent-neutral-400"
                  checked={autoPinActiveFiles}
                  onChange={(e) => setAutoPinActiveFiles(e.target.checked)}
                />
                <span className="text-sm text-black dark:text-neutral-200">
                  {t('settings.activeFiles.autoPinUploads')}
                </span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-7">
                {t('settings.activeFiles.autoPinUploadsDescription')}
              </p>
            </div>
          )}
        </div>

        {/* About You Section - Collapsible */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setIsAboutYouExpanded(!isAboutYouExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <IconUser
                size={18}
                className="text-gray-500 dark:text-gray-400"
              />
              <h3 className="text-sm font-bold text-black dark:text-white">
                {t('settings.aboutYou.title')}
              </h3>
            </div>
            <IconChevronDown
              size={18}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${
                isAboutYouExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>

          {isAboutYouExpanded && (
            <div className="px-4 pb-4 border-t border-gray-200 dark:border-gray-700">
              {/* Toggle: Include user info */}
              <label className="flex items-center gap-3 mt-4 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-neutral-600 dark:accent-neutral-400"
                  checked={state.includeUserInfoInPrompt || false}
                  onChange={(e) =>
                    dispatch({
                      field: 'includeUserInfoInPrompt',
                      value: e.target.checked,
                    })
                  }
                />
                <span className="text-sm text-black dark:text-neutral-200">
                  {t('settings.aboutYou.shareBasicInfo')}
                </span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-7">
                {t('settings.aboutYou.shareBasicInfoDescription')}
              </p>

              {/* Conditional fields when enabled */}
              {state.includeUserInfoInPrompt && (
                <div className="mt-4 space-y-4 ml-7">
                  {/* Preferred Name */}
                  <div>
                    <label className="text-sm font-medium text-black dark:text-neutral-200">
                      {t('settings.aboutYou.preferredName')}
                    </label>
                    <input
                      type="text"
                      value={state.preferredName || ''}
                      onChange={(e) =>
                        dispatch({
                          field: 'preferredName',
                          value: e.target.value,
                        })
                      }
                      placeholder={
                        derivedDisplayName ||
                        t('settings.aboutYou.preferredNamePlaceholder')
                      }
                      maxLength={100}
                      className="mt-1 w-full rounded-lg border border-neutral-200 bg-transparent px-4 py-2 text-neutral-900 focus:outline-none dark:border-neutral-600 dark:text-neutral-100"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t('settings.aboutYou.preferredNameDescriptionWithSync')}
                    </p>
                  </div>

                  {/* Additional Context */}
                  <div>
                    <label className="text-sm font-medium text-black dark:text-neutral-200">
                      {t('settings.aboutYou.additionalContext')}
                    </label>
                    <textarea
                      value={state.userContext || ''}
                      onChange={(e) =>
                        dispatch({
                          field: 'userContext',
                          value: e.target.value,
                        })
                      }
                      placeholder={t(
                        'settings.aboutYou.additionalContextPlaceholder',
                      )}
                      maxLength={2000}
                      rows={4}
                      className="mt-1 w-full rounded-lg border border-neutral-200 bg-transparent px-4 py-2 text-neutral-900 focus:outline-none dark:border-neutral-600 dark:text-neutral-100 resize-none"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t('settings.aboutYou.additionalContextDescription')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <hr className="border-gray-300 dark:border-neutral-700" />
        <span className="block text-[12px] text-black/50 dark:text-white/50">
          {t(
            '*Note that these default settings only apply to new conversations once saved',
          )}
        </span>

        <div className="flex justify-end">
          <button
            type="button"
            className="w-[120px] p-2 border rounded-lg shadow border-neutral-500 text-neutral-900 hover:bg-neutral-100 focus:outline-none dark:border-neutral-800 dark:border-opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-300"
            onClick={() => {
              onSave();
              onClose();
            }}
          >
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  );
};

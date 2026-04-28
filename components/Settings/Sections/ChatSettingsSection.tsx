import {
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconFiles,
  IconMessage,
  IconSparkles,
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

const STREAMING_PRESETS = {
  slow: { charsPerBatch: 2, delayMs: 12 },
  normal: { charsPerBatch: 3, delayMs: 8 },
  fast: { charsPerBatch: 5, delayMs: 4 },
} as const;

type StreamingPreset = keyof typeof STREAMING_PRESETS;

function streamingPresetFromState(
  speed: Settings['streamingSpeed'],
): StreamingPreset {
  if (speed?.delayMs === 12) return 'slow';
  if (speed?.delayMs === 4) return 'fast';
  return 'normal';
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
  const [isTTSExpanded, setIsTTSExpanded] = useState(false);
  const [isActiveFilesExpanded, setIsActiveFilesExpanded] = useState(false);
  const [isConfirmationsExpanded, setIsConfirmationsExpanded] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
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
    autoInjectPinnedImages,
    setAutoInjectPinnedImages,
    confirmStopFromButton,
    confirmStopFromKeyboard,
    setConfirmStopFromButton,
    setConfirmStopFromKeyboard,
  } = useSettings();

  const derivedDisplayName = getUserDisplayName(
    user,
    displayNamePreference,
    customDisplayName,
  );

  const handleSave = () => {
    onSave();
    setJustSaved(true);
    // Brief positive feedback before the modal closes, so the user sees that
    // their changes were accepted instead of the panel vanishing silently.
    window.setTimeout(() => {
      setJustSaved(false);
      onClose();
    }, 900);
  };

  const streamingPreset = streamingPresetFromState(state.streamingSpeed);

  type TristateLevel = 'low' | 'medium' | 'high';
  const TRISTATE_LEVELS: readonly TristateLevel[] = ['low', 'medium', 'high'];

  const renderTristatePills = (
    value: TristateLevel | undefined,
    onSelect: (next: TristateLevel | undefined) => void,
  ) => (
    <div className="grid grid-cols-3 gap-2">
      {TRISTATE_LEVELS.map((level) => {
        const isActive = value === level;
        return (
          <button
            key={level}
            type="button"
            onClick={() => onSelect(isActive ? undefined : level)}
            aria-pressed={isActive}
            className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
              isActive
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {level === 'low'
              ? t('modelSelect.advancedOptions.low')
              : level === 'medium'
                ? t('modelSelect.advancedOptions.medium')
                : t('modelSelect.advancedOptions.high')}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <IconMessage size={24} className="text-black dark:text-white" />
        <h2 className="text-2xl font-bold text-black dark:text-white">
          {t('settings.Chat Settings')}
        </h2>
      </div>

      <div className="space-y-8">
        {/* Custom Instructions — promoted to top, no accordion shell */}
        <section>
          <h3 className="text-base font-semibold mb-2 text-black dark:text-white">
            {t('settings.Custom Instructions')}
          </h3>
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
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
            {t('settings.appliesToNewConversations')}
          </p>
        </section>

        {/* About You — no accordion shell */}
        <section>
          <h3 className="flex items-center gap-2 text-base font-semibold mb-3 text-black dark:text-white">
            <IconUser size={18} className="text-gray-500 dark:text-gray-400" />
            {t('settings.aboutYou.title')}
          </h3>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-gray-700 dark:accent-gray-300"
              checked={state.includeUserInfoInPrompt || false}
              onChange={(e) =>
                dispatch({
                  field: 'includeUserInfoInPrompt',
                  value: e.target.checked,
                })
              }
            />
            <span className="text-sm text-black dark:text-gray-100">
              {t('settings.aboutYou.shareBasicInfo')}
            </span>
          </label>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-7">
            {t('settings.aboutYou.shareBasicInfoDescription')}
          </p>

          {state.includeUserInfoInPrompt && (
            <div className="mt-4 space-y-4 ml-7">
              {/* Preferred Name */}
              <div>
                <div className="flex items-baseline justify-between">
                  <label
                    htmlFor="chat-settings-preferred-name"
                    className="text-sm font-medium text-black dark:text-gray-100"
                  >
                    {t('settings.aboutYou.preferredName')}
                  </label>
                  <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                    {t('settings.characterCount', {
                      current: (state.preferredName || '').length,
                      max: 100,
                    })}
                  </span>
                </div>
                <input
                  id="chat-settings-preferred-name"
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
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2 text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-gray-600 dark:text-gray-100"
                />
                {!state.preferredName && derivedDisplayName ? (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    {t('settings.preferredNameInheritedFromGeneral')}
                  </p>
                ) : (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    {t('settings.aboutYou.preferredNameDescriptionWithSync')}
                  </p>
                )}
              </div>

              {/* Additional Context */}
              <div>
                <div className="flex items-baseline justify-between">
                  <label
                    htmlFor="chat-settings-user-context"
                    className="text-sm font-medium text-black dark:text-gray-100"
                  >
                    {t('settings.aboutYou.additionalContext')}
                  </label>
                  <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                    {t('settings.characterCount', {
                      current: (state.userContext || '').length,
                      max: 2000,
                    })}
                  </span>
                </div>
                <textarea
                  id="chat-settings-user-context"
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
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2 text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-gray-600 dark:text-gray-100 resize-none"
                />
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {t('settings.aboutYou.additionalContextDescription')}
                </p>
              </div>
            </div>
          )}
        </section>

        <hr className="border-gray-200 dark:border-gray-700" />

        {/* Model Response — collapsible, open by default */}
        <section className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setIsModelResponseExpanded(!isModelResponseExpanded)}
            aria-expanded={isModelResponseExpanded}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <IconSparkles
                size={18}
                className="text-gray-500 dark:text-gray-400"
              />
              <h3 className="text-base font-semibold text-black dark:text-white">
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
            <div className="px-4 pb-5 border-t border-gray-200 dark:border-gray-700 pt-5 space-y-6">
              {/* Temperature */}
              <div>
                <div className="text-sm font-semibold mb-3 text-black dark:text-gray-100">
                  {t('Default Temperature')}
                </div>
                <TemperatureSlider
                  temperature={state.temperature}
                  onChangeTemperature={(temperature) =>
                    dispatch({ field: 'temperature', value: temperature })
                  }
                />
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                  {t(
                    'Higher values produce more creative and varied responses, lower values are more focused and deterministic',
                  )}
                </p>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {t('settings.appliesToNewConversations')}
                </p>
              </div>

              {/* Reasoning Effort */}
              <div>
                <div className="text-sm font-semibold mb-2 text-black dark:text-gray-100">
                  {t('settings.Default Reasoning Effort')}
                </div>
                {renderTristatePills(
                  reasoningEffort === 'low' ||
                    reasoningEffort === 'medium' ||
                    reasoningEffort === 'high'
                    ? reasoningEffort
                    : undefined,
                  setReasoningEffort,
                )}
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                  {reasoningEffort
                    ? t('settings.reasoningEffortDescription')
                    : `${t('settings.useModelDefault')} ${t('settings.reasoningEffortDescription')}`}
                </p>
              </div>

              {/* Verbosity */}
              <div>
                <div className="text-sm font-semibold mb-2 text-black dark:text-gray-100">
                  {t('settings.Default Verbosity')}
                </div>
                {renderTristatePills(verbosity, setVerbosity)}
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                  {verbosity
                    ? t('settings.verbosityDescription')
                    : `${t('settings.useModelDefault')} ${t('settings.verbosityDescription')}`}
                </p>
              </div>

              {/* Streaming Speed — consolidated here as a pill grid */}
              <div>
                <div className="text-sm font-semibold mb-2 text-black dark:text-gray-100">
                  {t('settings.Streaming Speed')}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(['slow', 'normal', 'fast'] as const).map((preset) => {
                    const isActive = streamingPreset === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() =>
                          dispatch({
                            field: 'streamingSpeed',
                            value: STREAMING_PRESETS[preset],
                          })
                        }
                        aria-pressed={isActive}
                        className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                          isActive
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'
                        }`}
                      >
                        {t(
                          `settings.${preset === 'slow' ? 'Slow' : preset === 'normal' ? 'Normal' : 'Fast'}`,
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                  {t(
                    'settings.Controls how smoothly text appears during AI responses',
                  )}
                </p>
              </div>
            </div>
          )}
        </section>

        <hr className="border-gray-200 dark:border-gray-700" />

        {/* Text-to-Speech */}
        <section className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setIsTTSExpanded(!isTTSExpanded)}
            aria-expanded={isTTSExpanded}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <IconVolume
                size={18}
                className="text-gray-500 dark:text-gray-400"
              />
              <h3 className="text-base font-semibold text-black dark:text-white">
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
        </section>

        {/* Active Files */}
        <section className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setIsActiveFilesExpanded(!isActiveFilesExpanded)}
            aria-expanded={isActiveFilesExpanded}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <IconFiles
                size={18}
                className="text-gray-500 dark:text-gray-400"
              />
              <h3 className="text-base font-semibold text-black dark:text-white">
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
            <div className="px-4 pb-4 border-t border-gray-200 dark:border-gray-700 pt-2">
              <label className="flex items-center gap-3 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-gray-700 dark:accent-gray-300"
                  checked={autoPinActiveFiles}
                  onChange={(e) => setAutoPinActiveFiles(e.target.checked)}
                />
                <span className="text-sm text-black dark:text-gray-100">
                  {t('settings.activeFiles.autoPinUploads')}
                </span>
              </label>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-7">
                {t('settings.activeFiles.autoPinUploadsDescription')}
              </p>

              <label className="flex items-center gap-3 mt-4 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-gray-700 dark:accent-gray-300"
                  checked={autoInjectPinnedImages}
                  onChange={(e) => setAutoInjectPinnedImages(e.target.checked)}
                />
                <span className="text-sm text-black dark:text-gray-100">
                  {t('settings.activeFiles.autoInjectPinnedImages')}
                </span>
              </label>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-7">
                {t('settings.activeFiles.autoInjectPinnedImagesDescription')}
              </p>
            </div>
          )}
        </section>

        {/* Confirmations */}
        <section className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setIsConfirmationsExpanded(!isConfirmationsExpanded)}
            aria-expanded={isConfirmationsExpanded}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <IconAlertCircle
                size={18}
                className="text-gray-500 dark:text-gray-400"
              />
              <h3 className="text-base font-semibold text-black dark:text-white">
                {t('settings.confirmations.title')}
              </h3>
            </div>
            <IconChevronDown
              size={18}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${
                isConfirmationsExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>
          {isConfirmationsExpanded && (
            <div className="px-4 pb-4 border-t border-gray-200 dark:border-gray-700 pt-2">
              <label className="flex items-center gap-3 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-gray-700 dark:accent-gray-300"
                  checked={confirmStopFromButton}
                  onChange={(e) => setConfirmStopFromButton(e.target.checked)}
                />
                <span className="text-sm text-black dark:text-gray-100">
                  {t('settings.confirmations.confirmStopFromButton')}
                </span>
              </label>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-7">
                {t('settings.confirmations.confirmStopFromButtonDescription')}
              </p>

              <label className="flex items-center gap-3 mt-4 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-gray-700 dark:accent-gray-300"
                  checked={confirmStopFromKeyboard}
                  onChange={(e) => setConfirmStopFromKeyboard(e.target.checked)}
                />
                <span className="text-sm text-black dark:text-gray-100">
                  {t('settings.confirmations.confirmStopFromKeyboard')}
                </span>
              </label>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-7">
                {t('settings.confirmations.confirmStopFromKeyboardDescription')}
              </p>
            </div>
          )}
        </section>

        <div className="flex items-center justify-end gap-3 pt-2">
          {justSaved && (
            <span
              className="flex items-center gap-1 text-sm text-green-700 dark:text-green-400"
              role="status"
              aria-live="polite"
            >
              <IconCheck size={16} />
              {t('settings.savedConfirmation')}
            </span>
          )}
          <button
            type="button"
            disabled={justSaved}
            className="min-w-[120px] rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 disabled:opacity-60 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white dark:focus-visible:ring-gray-100"
            onClick={handleSave}
          >
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  );
};

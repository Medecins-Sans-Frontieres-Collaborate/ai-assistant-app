import {
  IconAdjustments,
  IconChevronDown,
  IconMessage,
  IconRefresh,
  IconSparkles,
  IconUser,
  IconVolume,
  IconX,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { Session } from 'next-auth';
import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import { getUserDisplayName } from '@/lib/utils/app/user/displayName';

import { DEFAULT_STREAMING_SPEED, Settings } from '@/types/settings';
import { DEFAULT_TTS_SETTINGS } from '@/types/tts';

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
  onClose: () => void;
}

const STREAMING_PRESETS = {
  slow: { charsPerBatch: 2, delayMs: 12 },
  normal: { charsPerBatch: 3, delayMs: 8 },
  fast: { charsPerBatch: 5, delayMs: 4 },
} as const;

type StreamingPreset = keyof typeof STREAMING_PRESETS;
type TristateLevel = 'low' | 'medium' | 'high';

function streamingPresetFromState(
  speed: Settings['streamingSpeed'],
): StreamingPreset {
  if (speed?.delayMs === 12) return 'slow';
  if (speed?.delayMs === 4) return 'fast';
  return 'normal';
}

// Shared active/inactive treatments. All tristate controls share the same
// active style (neutral-dark) so blue stays reserved for emphasis per the
// Quiet Surface Rule. Shape (gapped pills vs. connected segmented) carries
// the "different control type" signal instead of color.
const PILL_BASE =
  'min-h-11 px-3 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600';
const PILL_ACTIVE =
  'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900';
const PILL_INACTIVE =
  'bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

const SEGMENT_BASE =
  'flex-1 min-h-11 px-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600';
const SEGMENT_ACTIVE =
  'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900';
const SEGMENT_INACTIVE =
  'bg-transparent text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800';

export const ChatSettingsSection: FC<ChatSettingsSectionProps> = ({
  state,
  dispatch,
  homeState,
  user,
}) => {
  const t = useTranslations();
  const [isResponseExpanded, setIsResponseExpanded] = useState(false);
  const [isVoiceExpanded, setIsVoiceExpanded] = useState(false);
  const [isBehaviorExpanded, setIsBehaviorExpanded] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
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

  const streamingPreset = streamingPresetFromState(state.streamingSpeed);
  const reasoningPillValue: TristateLevel | undefined =
    reasoningEffort === 'low' ||
    reasoningEffort === 'medium' ||
    reasoningEffort === 'high'
      ? reasoningEffort
      : undefined;

  const handleResetAll = () => {
    setShowResetConfirm(false);
    dispatch({ field: 'temperature', value: 0.5 });
    dispatch({
      field: 'systemPrompt',
      value: process.env.NEXT_PUBLIC_DEFAULT_SYSTEM_PROMPT || '',
    });
    dispatch({ field: 'streamingSpeed', value: DEFAULT_STREAMING_SPEED });
    dispatch({ field: 'includeUserInfoInPrompt', value: false });
    dispatch({ field: 'preferredName', value: '' });
    dispatch({ field: 'userContext', value: '' });
    setReasoningEffort(undefined);
    setVerbosity(undefined);
    setAutoPinActiveFiles(true);
    setAutoInjectPinnedImages(true);
    setConfirmStopFromButton(true);
    setConfirmStopFromKeyboard(true);
    setTTSSettings(DEFAULT_TTS_SETTINGS);
  };

  const renderTristatePills = (
    value: TristateLevel | undefined,
    onSelect: (next: TristateLevel | undefined) => void,
  ) => (
    <div className="grid grid-cols-3 gap-2">
      {(['low', 'medium', 'high'] as const).map((level) => {
        const isActive = value === level;
        return (
          <button
            key={level}
            type="button"
            onClick={() => onSelect(isActive ? undefined : level)}
            aria-pressed={isActive}
            className={`${PILL_BASE} ${isActive ? PILL_ACTIVE : PILL_INACTIVE}`}
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

  const renderSegmented = (
    value: TristateLevel | undefined,
    onSelect: (next: TristateLevel | undefined) => void,
  ) => (
    <div
      role="radiogroup"
      className="inline-flex w-full overflow-hidden rounded-lg border border-gray-300 dark:border-gray-700"
    >
      {(['low', 'medium', 'high'] as const).map((level, index) => {
        const isActive = value === level;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onSelect(isActive ? undefined : level)}
            className={`${SEGMENT_BASE} ${
              index > 0 ? 'border-l border-gray-300 dark:border-gray-700' : ''
            } ${isActive ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`}
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
      <div className="flex items-center gap-2 mb-1">
        <IconMessage
          size={24}
          className="text-black dark:text-white"
          aria-hidden="true"
        />
        <h2 className="text-2xl font-bold text-black dark:text-white">
          {t('settings.Chat Settings')}
        </h2>
      </div>
      <p className="mb-6 text-xs text-gray-500 dark:text-gray-400">
        {t('settings.autosaveNote')}
      </p>

      <div className="space-y-8">
        {/* Custom Instructions, top, no shell */}
        <section>
          <h3 className="text-base font-semibold mb-2 text-black dark:text-white">
            {t('settings.Custom Instructions')}
          </h3>
          <SystemPrompt
            prompts={homeState.prompts}
            systemPrompt={state.systemPrompt}
            user={user}
            onChangePrompt={(prompt) =>
              dispatch({ field: 'systemPrompt', value: prompt })
            }
          />
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
            {t('settings.appliesToNewConversations')}
          </p>
        </section>

        {/* About You, no shell */}
        <section>
          <h3 className="flex items-center gap-2 text-base font-semibold mb-3 text-black dark:text-white">
            <IconUser
              size={18}
              className="text-gray-500 dark:text-gray-400"
              aria-hidden="true"
            />
            {t('settings.aboutYou.title')}
          </h3>

          <label className="flex items-center gap-3 min-h-11 cursor-pointer">
            <input
              type="checkbox"
              className="w-5 h-5 accent-gray-700 dark:accent-gray-300"
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
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-8">
            {t('settings.aboutYou.shareBasicInfoDescription')}
          </p>

          {state.includeUserInfoInPrompt && (
            <div className="mt-4 space-y-4 ml-8">
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
                <div className="relative mt-1">
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
                    className="w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2 pr-12 text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-gray-600 dark:text-gray-100"
                  />
                  {(state.preferredName || '').length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        dispatch({ field: 'preferredName', value: '' })
                      }
                      aria-label={t('settings.clearField')}
                      title={t('settings.clearField')}
                      className="absolute inset-y-0 right-0 inline-flex h-11 w-11 items-center justify-center rounded-md text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-gray-400 dark:hover:text-gray-100"
                    >
                      <IconX size={16} aria-hidden="true" />
                    </button>
                  )}
                </div>
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
                <div className="relative mt-1">
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
                    className="w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2 pr-12 text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-gray-600 dark:text-gray-100 resize-none"
                  />
                  {(state.userContext || '').length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        dispatch({ field: 'userContext', value: '' })
                      }
                      aria-label={t('settings.clearField')}
                      title={t('settings.clearField')}
                      className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-md text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-gray-400 dark:hover:text-gray-100"
                    >
                      <IconX size={16} aria-hidden="true" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {t('settings.aboutYou.additionalContextDescription')}
                </p>
              </div>
            </div>
          )}
        </section>

        <hr className="border-gray-200 dark:border-gray-700" />

        {/* Response: model output parameters. Three controls: Temperature
            (slider), Reasoning Effort (gapped pills), Verbosity (connected
            segmented). Active state is neutral-dark across both pill types
            so Signal Blue stays reserved for emphasis. */}
        <section>
          <button
            type="button"
            onClick={() => setIsResponseExpanded(!isResponseExpanded)}
            aria-expanded={isResponseExpanded}
            className="w-full flex items-center justify-between min-h-11 py-2 hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-md"
          >
            <div className="flex items-center gap-2">
              <IconSparkles
                size={18}
                className="text-gray-500 dark:text-gray-400"
                aria-hidden="true"
              />
              <h3 className="text-base font-semibold text-black dark:text-white">
                {t('settings.responseSection')}
              </h3>
            </div>
            <IconChevronDown
              size={18}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${
                isResponseExpanded ? 'rotate-180' : ''
              }`}
              aria-hidden="true"
            />
          </button>
          {isResponseExpanded && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-5 mt-1 space-y-6">
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

              <div>
                <div className="text-sm font-semibold mb-2 text-black dark:text-gray-100">
                  {t('settings.Default Reasoning Effort')}
                </div>
                {renderTristatePills(reasoningPillValue, setReasoningEffort)}
                {!reasoningPillValue && (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                    {t('settings.useModelDefault')}
                  </p>
                )}
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {t('settings.reasoningEffortDescription')}
                </p>
              </div>

              <div>
                <div className="text-sm font-semibold mb-2 text-black dark:text-gray-100">
                  {t('settings.Default Verbosity')}
                </div>
                {renderSegmented(verbosity, setVerbosity)}
                {!verbosity && (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                    {t('settings.useModelDefault')}
                  </p>
                )}
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {t('settings.verbosityDescription')}
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Voice: TTS only. Heavy enough internally to warrant its own
            top-level section. */}
        <section>
          <button
            type="button"
            onClick={() => setIsVoiceExpanded(!isVoiceExpanded)}
            aria-expanded={isVoiceExpanded}
            className="w-full flex items-center justify-between min-h-11 py-2 hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-md"
          >
            <div className="flex items-center gap-2">
              <IconVolume
                size={18}
                className="text-gray-500 dark:text-gray-400"
                aria-hidden="true"
              />
              <h3 className="text-base font-semibold text-black dark:text-white">
                {t('settings.voiceSection')}
              </h3>
            </div>
            <IconChevronDown
              size={18}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${
                isVoiceExpanded ? 'rotate-180' : ''
              }`}
              aria-hidden="true"
            />
          </button>
          {isVoiceExpanded && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-1">
              <TTSSettingsPanel
                settings={ttsSettings}
                onChange={setTTSSettings}
              />
            </div>
          )}
        </section>

        {/* Behavior: app-defaults that aren't directly about model output.
            Streaming Speed (UI delivery rhythm), Active Files (file context
            handling), Confirmations (stop-generation guards). Internal
            sub-headings keep the sub-areas distinct without spawning more
            top-level accordions. */}
        <section>
          <button
            type="button"
            onClick={() => setIsBehaviorExpanded(!isBehaviorExpanded)}
            aria-expanded={isBehaviorExpanded}
            className="w-full flex items-center justify-between min-h-11 py-2 hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-md"
          >
            <div className="flex items-center gap-2">
              <IconAdjustments
                size={18}
                className="text-gray-500 dark:text-gray-400"
                aria-hidden="true"
              />
              <h3 className="text-base font-semibold text-black dark:text-white">
                {t('settings.behaviorSection')}
              </h3>
            </div>
            <IconChevronDown
              size={18}
              className={`text-gray-500 dark:text-gray-400 transition-transform ${
                isBehaviorExpanded ? 'rotate-180' : ''
              }`}
              aria-hidden="true"
            />
          </button>
          {isBehaviorExpanded && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-5 mt-1 space-y-6">
              {/* Streaming Speed sub-area */}
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
                        className={`${PILL_BASE} ${
                          isActive ? PILL_ACTIVE : PILL_INACTIVE
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

              {/* Active Files sub-area */}
              <div>
                <div className="text-sm font-semibold mb-2 text-black dark:text-gray-100">
                  {t('activeFiles.title')}
                </div>
                <label className="flex items-center gap-3 min-h-11 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-5 h-5 accent-gray-700 dark:accent-gray-300"
                    checked={autoPinActiveFiles}
                    onChange={(e) => setAutoPinActiveFiles(e.target.checked)}
                  />
                  <span className="text-sm text-black dark:text-gray-100">
                    {t('settings.activeFiles.autoPinUploads')}
                  </span>
                </label>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-8">
                  {t('settings.activeFiles.autoPinUploadsDescription')}
                </p>

                <label className="flex items-center gap-3 min-h-11 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-5 h-5 accent-gray-700 dark:accent-gray-300"
                    checked={autoInjectPinnedImages}
                    onChange={(e) =>
                      setAutoInjectPinnedImages(e.target.checked)
                    }
                  />
                  <span className="text-sm text-black dark:text-gray-100">
                    {t('settings.activeFiles.autoInjectPinnedImages')}
                  </span>
                </label>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-8">
                  {t('settings.activeFiles.autoInjectPinnedImagesDescription')}
                </p>
              </div>

              {/* Confirmations sub-area */}
              <div>
                <div className="text-sm font-semibold mb-2 text-black dark:text-gray-100">
                  {t('settings.confirmations.title')}
                </div>
                <label className="flex items-center gap-3 min-h-11 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-5 h-5 accent-gray-700 dark:accent-gray-300"
                    checked={confirmStopFromButton}
                    onChange={(e) => setConfirmStopFromButton(e.target.checked)}
                  />
                  <span className="text-sm text-black dark:text-gray-100">
                    {t('settings.confirmations.confirmStopFromButton')}
                  </span>
                </label>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-8">
                  {t('settings.confirmations.confirmStopFromButtonDescription')}
                </p>

                <label className="flex items-center gap-3 min-h-11 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-5 h-5 accent-gray-700 dark:accent-gray-300"
                    checked={confirmStopFromKeyboard}
                    onChange={(e) =>
                      setConfirmStopFromKeyboard(e.target.checked)
                    }
                  />
                  <span className="text-sm text-black dark:text-gray-100">
                    {t('settings.confirmations.confirmStopFromKeyboard')}
                  </span>
                </label>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 ml-8">
                  {t(
                    'settings.confirmations.confirmStopFromKeyboardDescription',
                  )}
                </p>
              </div>
            </div>
          )}
        </section>

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="inline-flex items-center gap-2 min-h-11 rounded-lg px-3 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
          >
            <IconRefresh size={16} aria-hidden="true" />
            {t('settings.resetChatSettings')}
          </button>
        </div>
      </div>

      {showResetConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-950/60">
          <div
            className="mx-4 w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-[#1c1c1c]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-chat-settings-title"
          >
            <h3
              id="reset-chat-settings-title"
              className="mb-2 text-lg font-semibold text-black dark:text-white"
            >
              {t('settings.resetChatSettingsConfirmTitle')}
            </h3>
            <p className="mb-5 text-sm text-gray-700 dark:text-gray-300">
              {t('settings.resetChatSettingsConfirmMessage')}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="min-h-11 rounded-lg px-4 text-sm font-medium text-gray-800 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-gray-100 dark:hover:bg-gray-800"
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                onClick={handleResetAll}
                className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 dark:bg-red-700 dark:hover:bg-red-600"
              >
                {t('Reset')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

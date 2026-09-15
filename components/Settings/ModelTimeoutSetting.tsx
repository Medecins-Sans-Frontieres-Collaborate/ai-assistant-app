import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useTimeoutDurationLabel } from '@/client/hooks/chat/useTimeoutDurationLabel';

import {
  MAX_MODEL_TIMEOUT_SECONDS,
  MIN_MODEL_TIMEOUT_SECONDS,
  MODEL_TIMEOUT_PRESETS,
  ModelTimeoutPresetKey,
  clampModelTimeoutSeconds,
  modelTimeoutPresetFor,
} from '@/lib/utils/shared/chat/modelTimeout';

import { useSettingsStore } from '@/client/stores/settingsStore';

const PRESET_LABEL_KEYS: Record<ModelTimeoutPresetKey, string> = {
  standard: 'presetStandard',
  patient: 'presetPatient',
  maximum: 'presetMaximum',
};

/**
 * Store-driven control for the model start timeout and the "prefer my
 * selected model" switch (issue #130). Self-contained like
 * `PasteAttachmentSetting` — the legacy ChatSettings reducer/save plumbing
 * is not extended for new settings.
 *
 * Presets and the custom field are two views of one stored value: picking
 * a preset writes its seconds, and a stored value that matches no preset
 * shows as Custom with the field open. The field is free-typed (a string)
 * and only commits a clamped number on blur, so it never fights the user
 * mid-edit.
 */
export const ModelTimeoutSetting: FC = () => {
  const t = useTranslations('settings.modelTimeout');
  const durationLabel = useTimeoutDurationLabel();
  const modelTimeoutSeconds = useSettingsStore((s) => s.modelTimeoutSeconds);
  const setModelTimeoutSeconds = useSettingsStore(
    (s) => s.setModelTimeoutSeconds,
  );
  const preferSelectedModel = useSettingsStore((s) => s.preferSelectedModel);
  const setPreferSelectedModel = useSettingsStore(
    (s) => s.setPreferSelectedModel,
  );

  const preset = modelTimeoutPresetFor(modelTimeoutSeconds);
  // "Custom" stays selected after the user picks it even while the typed
  // value still happens to equal a preset.
  const [customChosen, setCustomChosen] = useState(preset === 'custom');
  const showCustom = customChosen || preset === 'custom';

  const [draft, setDraft] = useState(String(modelTimeoutSeconds));
  // Re-sync the field when the stored value changes underneath us (another
  // tab, a settings reset, the error card's "always wait" action).
  const [syncedSeconds, setSyncedSeconds] = useState(modelTimeoutSeconds);
  if (modelTimeoutSeconds !== syncedSeconds) {
    setSyncedSeconds(modelTimeoutSeconds);
    setDraft(String(modelTimeoutSeconds));
    if (modelTimeoutPresetFor(modelTimeoutSeconds) !== 'custom') {
      setCustomChosen(false);
    }
  }

  const commitDraft = () => {
    const next = clampModelTimeoutSeconds(draft);
    setDraft(String(next));
    setModelTimeoutSeconds(next);
  };

  return (
    <div>
      <h4 className="mb-1 text-sm font-bold text-black dark:text-gray-200">
        {t('title')}
      </h4>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {t('description')}
      </p>
      <div
        className="flex flex-wrap items-center gap-4"
        role="radiogroup"
        aria-label={t('title')}
      >
        {MODEL_TIMEOUT_PRESETS.map((p) => (
          <label
            key={p.key}
            className="flex items-center gap-2 text-sm text-black dark:text-gray-200"
          >
            <input
              type="radio"
              name="modelTimeout"
              className="accent-gray-600 dark:accent-gray-400"
              checked={!showCustom && preset === p.key}
              onChange={() => {
                setCustomChosen(false);
                setModelTimeoutSeconds(p.seconds);
              }}
            />
            {t(PRESET_LABEL_KEYS[p.key])}
            <span className="text-gray-500 dark:text-gray-400">
              ({durationLabel(p.seconds)})
            </span>
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm text-black dark:text-gray-200">
          <input
            type="radio"
            name="modelTimeout"
            className="accent-gray-600 dark:accent-gray-400"
            checked={showCustom}
            onChange={() => setCustomChosen(true)}
          />
          {t('presetCustom')}
        </label>
      </div>

      {showCustom && (
        <div className="mt-3">
          <label className="flex flex-wrap items-center gap-2 text-sm text-black dark:text-gray-200">
            {t('customLabel')}
            <input
              type="number"
              min={MIN_MODEL_TIMEOUT_SECONDS}
              max={MAX_MODEL_TIMEOUT_SECONDS}
              step={10}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className="w-24 rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
            />
            <span className="text-gray-500 dark:text-gray-400">
              {t('customUnit')}
            </span>
          </label>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('customHint', {
              min: MIN_MODEL_TIMEOUT_SECONDS,
              max: MAX_MODEL_TIMEOUT_SECONDS,
            })}
          </p>
        </div>
      )}

      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
          checked={preferSelectedModel}
          onChange={(e) => setPreferSelectedModel(e.target.checked)}
        />
        <span>
          <span className="block text-sm text-black dark:text-gray-200">
            {t('preferModelTitle')}
          </span>
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            {t('preferModelDescription')}
          </span>
        </span>
      </label>
    </div>
  );
};

import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS,
  EMISSIONS_CHIP_AUTOHIDE_MAX_MS,
  EMISSIONS_CHIP_AUTOHIDE_MIN_MS,
  EMISSIONS_CHIP_VISIBILITY_OPTIONS,
  EmissionsChipVisibility,
  clampEmissionsChipAutoHideMs,
} from '@/lib/utils/shared/emissions';

import { useSettingsStore } from '@/client/stores/settingsStore';

const MIN_SECONDS = EMISSIONS_CHIP_AUTOHIDE_MIN_MS / 1000;
const MAX_SECONDS = EMISSIONS_CHIP_AUTOHIDE_MAX_MS / 1000;

/**
 * Store-driven control for the floating emissions chip. Deliberately
 * self-contained (reads settingsStore directly), matching
 * `AutoFetchLinksToggle` and `PasteAttachmentSetting` — the legacy ChatSettings
 * reducer/save plumbing is not extended for new settings.
 *
 * Three radios rather than two checkboxes because the modes are mutually
 * exclusive: "hidden but auto-fading" is not a state that means anything.
 */
export const EmissionsChipSetting: FC = () => {
  const t = useTranslations('usageImpact');
  const visibility = useSettingsStore((s) => s.emissionsChipVisibility);
  const setVisibility = useSettingsStore((s) => s.setEmissionsChipVisibility);
  const autoHideMs = useSettingsStore((s) => s.emissionsChipAutoHideMs);
  const setAutoHideMs = useSettingsStore((s) => s.setEmissionsChipAutoHideMs);

  // Free-typed, so it holds a string: clamping every keystroke would fight the
  // user mid-edit ("1" becoming "1000" before they finish). The store only
  // sees a clamped number, on blur. Same approach as PasteAttachmentSetting.
  const [draft, setDraft] = useState(
    String((autoHideMs || EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS) / 1000),
  );

  // Re-sync when the stored value changes underneath us (another tab, a
  // settings reset). Adjusting during render rather than in an effect so the
  // field never paints the previous value first.
  const [syncedMs, setSyncedMs] = useState(autoHideMs);
  if (autoHideMs !== syncedMs) {
    setSyncedMs(autoHideMs);
    setDraft(String(autoHideMs / 1000));
  }

  const commitDraft = () => {
    const parsed = Number(draft);
    const next = clampEmissionsChipAutoHideMs(
      Number.isFinite(parsed) && parsed > 0
        ? parsed * 1000
        : EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS,
    );
    setDraft(String(next / 1000));
    setAutoHideMs(next);
  };

  const optionLabel: Record<EmissionsChipVisibility, string> = {
    always: t('chipAlways'),
    auto: t('chipAuto'),
    hidden: t('chipHidden'),
  };
  const optionHint: Record<EmissionsChipVisibility, string> = {
    always: t('chipAlwaysHint'),
    auto: t('chipAutoHint'),
    hidden: t('chipHiddenHint'),
  };

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium text-black dark:text-white">
        {t('chipTitle')}
      </h4>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {t('chipDescription')}
      </p>

      <div className="space-y-2">
        {EMISSIONS_CHIP_VISIBILITY_OPTIONS.map((mode) => (
          <label
            key={mode}
            className="flex cursor-pointer items-start gap-3"
            data-testid={`emissions-chip-${mode}`}
          >
            <input
              type="radio"
              name="emissions-chip-visibility"
              className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
              checked={visibility === mode}
              onChange={() => setVisibility(mode)}
            />
            <span>
              <span className="block text-sm text-black dark:text-gray-200">
                {optionLabel[mode]}
              </span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                {optionHint[mode]}
              </span>
            </span>
          </label>
        ))}
      </div>

      {visibility === 'auto' && (
        <div className="mt-3 ms-7">
          <label className="flex flex-wrap items-center gap-2 text-sm text-black dark:text-gray-200">
            {t('chipAutoHideLabel')}
            <input
              type="number"
              min={MIN_SECONDS}
              max={MAX_SECONDS}
              step={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
            />
            <span className="text-gray-500 dark:text-gray-400">
              {t('chipAutoHideUnit')}
            </span>
          </label>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('chipAutoHideHint', { min: MIN_SECONDS, max: MAX_SECONDS })}
          </p>
        </div>
      )}
    </div>
  );
};

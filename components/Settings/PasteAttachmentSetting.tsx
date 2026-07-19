import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  DEFAULT_PASTE_ATTACHMENT_CHARS,
  PASTE_ATTACHMENT_MAX_CHARS,
  PASTE_ATTACHMENT_MIN_CHARS,
  clampPasteAttachmentChars,
} from '@/lib/utils/shared/paste/pastedText';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Store-driven control for the large-paste threshold. Deliberately
 * self-contained (reads settingsStore directly), matching
 * `AutoFetchLinksToggle` — the legacy ChatSettings reducer/save plumbing is
 * not extended for new settings.
 *
 * `0` in the store means off, so the checkbox and the number are two views of
 * one value rather than two independent settings. Unchecking remembers the
 * previous threshold locally so re-checking doesn't silently reset it to the
 * default.
 */
export const PasteAttachmentSetting: FC = () => {
  const t = useTranslations('pastedText');
  const pasteAsAttachmentChars = useSettingsStore(
    (s) => s.pasteAsAttachmentChars,
  );
  const setPasteAsAttachmentChars = useSettingsStore(
    (s) => s.setPasteAsAttachmentChars,
  );

  const enabled = pasteAsAttachmentChars > 0;

  // The field is free-typed, so it holds a string: clamping every keystroke
  // would fight the user mid-edit ("5" becoming "500" before they type the
  // rest). The store only sees a clamped number, on blur.
  const [draft, setDraft] = useState(
    String(pasteAsAttachmentChars || DEFAULT_PASTE_ATTACHMENT_CHARS),
  );

  // Re-sync the field when the stored value changes underneath us (another
  // tab, a settings reset). Adjusting during render rather than in an effect:
  // React re-runs this render before committing, so the field never paints
  // the previous value first. See "You Might Not Need an Effect".
  const [syncedChars, setSyncedChars] = useState(pasteAsAttachmentChars);
  if (pasteAsAttachmentChars !== syncedChars) {
    setSyncedChars(pasteAsAttachmentChars);
    if (pasteAsAttachmentChars > 0) setDraft(String(pasteAsAttachmentChars));
  }

  const commitDraft = () => {
    const parsed = Number(draft);
    const next = clampPasteAttachmentChars(
      Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_PASTE_ATTACHMENT_CHARS,
    );
    setDraft(String(next));
    setPasteAsAttachmentChars(next);
  };

  return (
    <div>
      <h4 className="mb-2 text-sm font-medium text-black dark:text-white">
        {t('settingsTitle')}
      </h4>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
          checked={enabled}
          onChange={(e) =>
            setPasteAsAttachmentChars(
              e.target.checked
                ? clampPasteAttachmentChars(Number(draft))
                : /* 0 disables without discarding the remembered value */ 0,
            )
          }
        />
        <span>
          <span className="block text-sm text-black dark:text-gray-200">
            {t('settingsToggle')}
          </span>
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            {t('settingsDescription')}
          </span>
        </span>
      </label>

      {enabled && (
        <div className="mt-3 ms-7">
          <label className="flex flex-wrap items-center gap-2 text-sm text-black dark:text-gray-200">
            {t('settingsThresholdLabel')}
            <input
              type="number"
              min={PASTE_ATTACHMENT_MIN_CHARS}
              max={PASTE_ATTACHMENT_MAX_CHARS}
              step={100}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              className="w-28 rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
            />
            <span className="text-gray-500 dark:text-gray-400">
              {t('settingsThresholdUnit')}
            </span>
          </label>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('settingsThresholdHint', {
              min: PASTE_ATTACHMENT_MIN_CHARS,
              max: PASTE_ATTACHMENT_MAX_CHARS,
            })}
          </p>
        </div>
      )}
    </div>
  );
};

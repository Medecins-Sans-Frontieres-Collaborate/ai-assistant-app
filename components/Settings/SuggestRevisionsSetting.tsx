import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Controls for the Document workflow's "Suggest changes" behaviour: the
 * default state of the composer checkbox, and the cases that bypass it.
 *
 * Store-driven and applied immediately, matching `AutoFetchLinksToggle` and
 * `PasteAttachmentSetting` — the legacy ChatSettings save/dispatch flow is
 * not extended for new settings.
 *
 * The bypasses are nested under the main toggle because none of them mean
 * anything when suggestions are off; they are disabled rather than hidden so
 * the behaviour stays discoverable.
 */
export const SuggestRevisionsSetting: FC = () => {
  const t = useTranslations('settings.suggestRevisions');
  const enabled = useSettingsStore((s) => s.suggestRevisions);
  const setEnabled = useSettingsStore((s) => s.setSuggestRevisions);
  const exceptions = useSettingsStore((s) => s.suggestRevisionsExceptions);
  const setException = useSettingsStore((s) => s.setSuggestRevisionsException);
  const ratio = useSettingsStore((s) => s.suggestRevisionsLargeRewriteRatio);
  const setRatio = useSettingsStore(
    (s) => s.setSuggestRevisionsLargeRewriteRatio,
  );

  const exceptionRows = [
    { key: 'selectionScoped', label: t('exceptionSelection') },
    { key: 'largeRewrites', label: t('exceptionLargeRewrite') },
    { key: 'structuralReorders', label: t('exceptionReorder') },
  ] as const;

  return (
    <div>
      <h4 className="mb-2 text-sm font-medium text-black dark:text-white">
        {t('title')}
      </h4>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>
          <span className="block text-sm text-black dark:text-gray-200">
            {t('toggle')}
          </span>
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            {t('description')}
          </span>
        </span>
      </label>

      <div className="mt-3 ms-7">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
          {t('exceptionsTitle')}
        </p>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {exceptionRows.map(({ key, label }) => (
            <label
              key={key}
              className={`flex items-start gap-2 text-sm ${
                enabled
                  ? 'cursor-pointer text-black dark:text-gray-200'
                  : 'cursor-not-allowed text-gray-400 dark:text-gray-600'
              }`}
            >
              <input
                type="checkbox"
                disabled={!enabled}
                checked={exceptions[key]}
                onChange={(e) => setException(key, e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-gray-600 disabled:opacity-50 dark:accent-gray-400"
              />
              {label}
            </label>
          ))}
        </div>

        <label
          className={`mt-2 flex flex-wrap items-center gap-2 text-sm ${
            enabled && exceptions.largeRewrites
              ? 'text-black dark:text-gray-200'
              : 'text-gray-400 dark:text-gray-600'
          }`}
        >
          {t('thresholdLabel')}
          <input
            type="number"
            min={10}
            max={95}
            step={5}
            disabled={!enabled || !exceptions.largeRewrites}
            value={Math.round(ratio * 100)}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next)) setRatio(next / 100);
            }}
            className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-blue-600 focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
          />
          <span className="text-gray-500 dark:text-gray-400">
            {t('thresholdUnit')}
          </span>
        </label>
      </div>
    </div>
  );
};

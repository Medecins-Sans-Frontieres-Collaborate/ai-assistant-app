'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

export interface ConflictDiffRow {
  label: string;
  yours: string;
  theirs: string;
}

interface ConflictDiffProps {
  /** Field-level differences between the admin's draft and the latest record. */
  rows: ConflictDiffRow[];
  /** Who last wrote the record that won the race. */
  updatedBy: string;
  updatedAt: string;
  /** Re-save the draft over the latest version (adopting its etag). */
  onKeepMine: () => void;
  /** Replace the draft with the latest record's values. */
  onTakeTheirs: () => void;
}

const clip = (value: string) =>
  value.length > 160 ? `${value.slice(0, 160)}…` : value || '—';

/**
 * Draft-preserving 409 handling, shared by the admin editors: instead of
 * discarding what the admin typed, show a yours/theirs comparison against
 * the record that won the race and let them choose. "Keep mine" re-saves
 * the draft with the latest etag (a deliberate, informed overwrite — the
 * opposite of a silent one); "take theirs" loads the winning values into
 * the form. Either way nothing typed is lost, and the audit history keeps
 * every version regardless.
 */
export const ConflictDiff: FC<ConflictDiffProps> = ({
  rows,
  updatedBy,
  updatedAt,
  onKeepMine,
  onTakeTheirs,
}) => {
  const t = useTranslations('agentAccess');

  return (
    <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
      <p className="font-medium">
        {t('conflictDetectedBy', {
          user: updatedBy,
          date: new Date(updatedAt).toLocaleString(),
        })}
      </p>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs">{t('conflictNoFieldDiff')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-start text-amber-800 dark:text-amber-300">
                <th className="pe-2 text-start font-semibold">
                  {t('conflictField')}
                </th>
                <th className="pe-2 text-start font-semibold">
                  {t('conflictYours')}
                </th>
                <th className="text-start font-semibold">
                  {t('conflictTheirs')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="align-top">
                  <td className="pe-2 font-medium">{row.label}</td>
                  <td className="break-words pe-2">{clip(row.yours)}</td>
                  <td className="break-words">{clip(row.theirs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onTakeTheirs}
          className="rounded-md border border-amber-300 px-3 py-1 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40"
        >
          {t('conflictTakeTheirs')}
        </button>
        <button
          type="button"
          onClick={onKeepMine}
          className="rounded-md bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-700"
        >
          {t('conflictKeepMine')}
        </button>
      </div>
    </div>
  );
};

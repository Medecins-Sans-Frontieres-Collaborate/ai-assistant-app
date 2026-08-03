'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { ChipListInput } from './ChipListInput';
import { GroupSearchPicker } from './GroupSearchPicker';
import { MergedAgentRow } from './types';

type EditorAccessType = 'everyone' | 'restricted';

/**
 * 'user@example.org' or '@example.org' → 'example.org'. A stored domain
 * containing an '@' can never match the server's domain evaluation (it
 * compares against the part after the '@' of the user's mail), so strip
 * everything up to and including the last '@' before committing the chip.
 */
export function normalizeDomainEntry(value: string): string {
  return value.slice(value.lastIndexOf('@') + 1).trim();
}

interface RuleEditorProps {
  row: MergedAgentRow;
  /** Rule saved/deleted successfully — parent refetches and closes. */
  onSaved: () => void;
  onCancel: () => void;
  /** 409 conflict acknowledged — parent refetches (rule + etag) and closes. */
  onConflictReload: () => void;
}

/**
 * Inline editor for one agent's access rule. "Everyone" maps to no rule
 * (deletes an existing rule via If-Match); "Restricted" PUTs a restricted
 * rule with chip-input domains/users plus Entra group object ids (matched
 * against the user's cached transitive membership — third pass §5).
 */
export const RuleEditor: FC<RuleEditorProps> = ({
  row,
  onSaved,
  onCancel,
  onConflictReload,
}) => {
  const t = useTranslations('agentAccess');

  const storedAccess = row.stored?.rule.access;
  const [accessType, setAccessType] = useState<EditorAccessType>(
    storedAccess?.type === 'restricted' ? 'restricted' : 'everyone',
  );
  const [allowDomains, setAllowDomains] = useState<string[]>(
    storedAccess?.allowDomains ?? [],
  );
  const [allowUsers, setAllowUsers] = useState<string[]>(
    storedAccess?.allowUsers ?? [],
  );
  const [allowGroups, setAllowGroups] = useState<string[]>(
    storedAccess?.allowGroups ?? [],
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(false);
    try {
      if (accessType === 'everyone') {
        if (!row.stored) {
          // No rule exists and none is wanted — nothing to persist.
          onSaved();
          return;
        }
        const params = new URLSearchParams({
          source: row.source,
          agentName: row.agentName,
        });
        const response = await fetch(
          `/api/agent-access/rules?${params.toString()}`,
          {
            method: 'DELETE',
            headers: { 'If-Match': row.stored.etag },
          },
        );
        if (response.status === 409) {
          setIsConflict(true);
          return;
        }
        // 404 = another admin already deleted the rule. The desired end
        // state ("no rule") holds, so treat it as success — the parent
        // refetch drops the stale row/etag.
        if (!response.ok && response.status !== 404) {
          setSaveError(true);
          return;
        }
        toast.success(t('deleteSuccess'));
        onSaved();
        return;
      }

      const response = await fetch('/api/agent-access/rules', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          // If-Match updates the existing rule; If-None-Match: * creates —
          // either way a concurrent write surfaces as 409, never a clobber.
          ...(row.stored
            ? { 'If-Match': row.stored.etag }
            : { 'If-None-Match': '*' }),
        },
        body: JSON.stringify({
          source: row.source,
          agentName: row.agentName,
          access: {
            type: 'restricted',
            allowDomains,
            allowUsers,
            allowGroups,
          },
        }),
      });
      if (response.status === 409) {
        setIsConflict(true);
        return;
      }
      if (!response.ok) {
        setSaveError(true);
        return;
      }
      toast.success(t('saveSuccess'));
      onSaved();
    } catch {
      setSaveError(true);
    } finally {
      setIsSaving(false);
    }
  };

  const restrictedListsEmpty =
    accessType === 'restricted' &&
    allowDomains.length === 0 &&
    allowUsers.length === 0 &&
    allowGroups.length === 0;

  return (
    <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4">
      {/* Access type radio */}
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-black dark:text-white">
          {t('accessTypeLabel')}
        </legend>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              name={`access-type-${row.canonicalKey}`}
              className="mt-1 h-4 w-4 accent-gray-600 dark:accent-gray-400"
              checked={accessType === 'everyone'}
              onChange={() => setAccessType('everyone')}
            />
            <span>
              <span className="block text-sm text-black dark:text-gray-200">
                {t('accessEveryone')}
              </span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                {t('everyoneDescription')}
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              name={`access-type-${row.canonicalKey}`}
              className="mt-1 h-4 w-4 accent-gray-600 dark:accent-gray-400"
              checked={accessType === 'restricted'}
              onChange={() => setAccessType('restricted')}
            />
            <span>
              <span className="block text-sm text-black dark:text-gray-200">
                {t('accessRestricted')}
              </span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                {t('restrictedDescription')}
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      {accessType === 'restricted' && (
        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-black dark:text-white">
              {t('allowDomainsLabel')}
            </label>
            <ChipListInput
              values={allowDomains}
              onChange={setAllowDomains}
              normalize={normalizeDomainEntry}
              placeholder={t('allowDomainsPlaceholder')}
              addHint={t('chipAddHint')}
              removeLabel={t('removeChip')}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-black dark:text-white">
              {t('allowUsersLabel')}
            </label>
            <ChipListInput
              values={allowUsers}
              onChange={setAllowUsers}
              placeholder={t('allowUsersPlaceholder')}
              addHint={t('chipAddHint')}
              removeLabel={t('removeChip')}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-black dark:text-white">
              {t('groupsLabel')}
            </label>
            <GroupSearchPicker
              values={allowGroups}
              onChange={setAllowGroups}
              labels={{
                searchPlaceholder: t('groupSearchPlaceholder'),
                searchHint: t('groupSearchHint'),
                noResults: t('groupSearchNoResults'),
                searchError: t('groupSearchError'),
                chipPlaceholder: t('groupsPlaceholder'),
                addHint: t('chipAddHint'),
                removeLabel: t('removeChip'),
                flagOffHint: t('groupsFlagOff'),
              }}
            />
          </div>

          {restrictedListsEmpty && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
              {t('restrictedEmptyWarning')}
            </p>
          )}
        </div>
      )}

      {isConflict && (
        <div className="mt-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
          <p>{t('conflictError')}</p>
          <button
            type="button"
            className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
            onClick={onConflictReload}
          >
            {t('reload')}
          </button>
        </div>
      )}

      {saveError && !isConflict && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">
          {t('saveError')}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
          onClick={onCancel}
          disabled={isSaving}
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={handleSave}
          disabled={isSaving || isConflict}
        >
          {isSaving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  );
};

'use client';

import {
  IconChevronDown,
  IconChevronRight,
  IconTrash,
} from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  LimitEntry,
  LimitOverride,
  OverrideScope,
} from '@/lib/services/limits/types';

import {
  ADMIN_BTN_ICON_DANGER,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { ChipListInput } from '@/components/AgentAccess/ChipListInput';
import { GroupSearchPicker } from '@/components/AgentAccess/GroupSearchPicker';
import { normalizeDomainEntry } from '@/components/AgentAccess/RuleEditor';
import { LimitRow } from '@/components/Limits/LimitRow';
import {
  LIMIT_GROUPS,
  LimitGroup,
  memberDefinitions,
  seedValueFor,
} from '@/components/Limits/limitGroups';
import {
  EntryDraft,
  ceilingsFromEntries,
  draftKey,
  draftToEntries,
  entriesToDraft,
  parseDraftKey,
} from '@/components/Limits/types';

import { LIMIT_KEYS, getLimitDefinition } from '@/config/limits';

interface OverrideEditorProps {
  override: LimitOverride;
  onChange: (next: LimitOverride) => void;
  onRemove: () => void;
  disabled?: boolean;
  /**
   * The draft's global default entries, used ONLY to warn when a cap in
   * this override targets a feature whose gate is off (here or globally).
   * Purely informational — resolution is layered and another override may
   * re-enable the gate for some principals, so nothing is disabled.
   */
  globalDefaults?: LimitEntry[];
  /**
   * Collapsed cards keep a long override list scannable. Defaults to
   * expanded so a directly rendered editor (and a freshly added override)
   * is never a mystery card; LimitsPanel passes false for loaded ones.
   */
  defaultExpanded?: boolean;
}

const SCOPES: OverrideScope[] = ['user', 'domain', 'attribute', 'group'];

/**
 * One override record: who it targets, and the sparse set of limits it
 * speaks to. Everything it does NOT set is left absent, so lower layers keep
 * applying — that is the whole point of the sparse merge.
 *
 * Renders ONLY the limits the override actually configures (grouped by
 * feature, like the defaults tab) plus an add-limit picker — not all 17
 * catalog rows. "Not set — inherit" removes an entry and therefore its row.
 *
 * The `group` scope targets Entra group OBJECT IDS, edited through the same
 * `GroupSearchPicker` as `RuleEditor`'s allowGroups (typeahead adds id
 * chips; ids may also be pasted directly) — matched at evaluation time
 * against the user's cached transitive membership (third pass §5).
 */
export const OverrideEditor: FC<OverrideEditorProps> = ({
  override,
  onChange,
  onRemove,
  disabled = false,
  globalDefaults = [],
  defaultExpanded = true,
}) => {
  const t = useTranslations('limits');
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [pendingAdd, setPendingAdd] = useState('');
  const draft: EntryDraft = useMemo(
    () => entriesToDraft(override.entries),
    [override.entries],
  );
  const isGroupScope = override.scope === 'group';

  const update = (patch: Partial<LimitOverride>) =>
    onChange({ ...override, ...patch });

  /**
   * ⚠ `ceilings` MUST be threaded through every draftToEntries call.
   * draftToEntries defaults the argument to {} and then writes
   * `ceiling: ceilings[key] ?? false` for EVERY entry — so without this, one
   * keystroke on any limit rewrote the whole entry array with ceiling:false
   * and silently destroyed stored flags. The write schema
   * (app/api/limits/policy/route.ts) accepts and persists ceiling on override
   * entries, so that was real data loss.
   *
   * Preserved rather than stripped: resolver.ts reads only the GLOBAL entry's
   * ceiling, so an override-level ceiling is inert today — but silently
   * flipping a stored `true` is mutation, and a future resolver change could
   * make it meaningful.
   */
  const ceilings = useMemo(
    () => ceilingsFromEntries(override.entries),
    [override.entries],
  );

  const setValue = (key: string, value: EntryDraft[string]) => {
    const next = { ...draft, [key]: value };
    if (value === undefined) delete next[key];
    update({ entries: draftToEntries(next, ceilings) });
  };

  /** A member is configured if its base key OR any scoped cell is present. */
  const isConfigured = (limitKey: string) =>
    draft[draftKey(limitKey)] !== undefined ||
    Object.keys(draft).some((key) => key.startsWith(`${limitKey}@`));

  /** Entries whose limitKey this build's catalog does not know. */
  const unrecognized = useMemo(
    () =>
      Object.keys(draft).filter(
        (key) => !LIMIT_KEYS.has(parseDraftKey(key).limitKey),
      ),
    [draft],
  );

  const addLimit = (limitKey: string) => {
    if (!limitKey) return;
    const def = getLimitDefinition(limitKey);
    if (!def || draft[draftKey(limitKey)] !== undefined) return;
    setValue(draftKey(limitKey), seedValueFor(def));
    setPendingAdd('');
  };

  /**
   * The gate this group's caps depend on, as this override's targets would
   * see it from THIS override or the global defaults. A heuristic by
   * design: a same-or-higher layer can still re-enable the gate for some
   * principals, so this warns without disabling anything.
   */
  const gateEffectivelyOff = (group: LimitGroup): boolean => {
    if (!group.gateKey) return false;
    const own = draft[draftKey(group.gateKey)];
    if (own !== undefined) return own === false;
    const global = globalDefaults.find(
      (e) => e.limitKey === group.gateKey && !e.modelId && !e.series,
    );
    return global?.value === false;
  };

  const configuredGroups = LIMIT_GROUPS.map((group) => ({
    group,
    gateConfigured:
      group.gateKey !== undefined &&
      draft[draftKey(group.gateKey)] !== undefined,
    members: memberDefinitions(group).filter((def) => isConfigured(def.key)),
  })).filter(({ gateConfigured, members }) => gateConfigured || members.length);

  const unconfiguredByGroup = LIMIT_GROUPS.map((group) => ({
    group,
    keys: [
      ...(group.gateKey ? [group.gateKey] : []),
      ...group.memberKeys,
    ].filter((key) => draft[draftKey(key)] === undefined),
  })).filter(({ keys }) => keys.length > 0);

  return (
    <div className={ADMIN_CARD}>
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? t('collapseOverride') : t('expandOverride')}
      >
        {expanded ? (
          <IconChevronDown size={16} aria-hidden="true" />
        ) : (
          <IconChevronRight size={16} aria-hidden="true" />
        )}
        <span className="text-sm font-medium text-black dark:text-white">
          {override.label || t('untitledOverride')}
        </span>
        <span className={ADMIN_CHIP_NEUTRAL}>
          {t(`scope.${override.scope}` as never)}
        </span>
        {!override.enabled && (
          <span className={ADMIN_CHIP_NEUTRAL}>
            {t('overrideDisabledChip')}
          </span>
        )}
        <span className={`ml-auto ${ADMIN_MUTED}`}>
          {t('targetsCount', { count: override.targets.length })} ·{' '}
          {t('limitsCount', { count: override.entries.length })}
        </span>
      </button>

      {expanded && (
        <div className="mt-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              className={`min-w-[180px] flex-1 ${ADMIN_FIELD}`}
              value={override.label}
              onChange={(e) => update({ label: e.target.value })}
              placeholder={t('overrideLabelPlaceholder')}
              disabled={disabled}
              aria-label={t('overrideLabelLabel')}
            />
            <select
              className={ADMIN_FIELD}
              value={override.scope}
              onChange={(e) =>
                update({ scope: e.target.value as OverrideScope, targets: [] })
              }
              disabled={disabled}
              aria-label={t('overrideScopeLabel')}
            >
              {SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {t(`scope.${scope}` as never)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
              <input
                type="checkbox"
                className={ADMIN_CHECKBOX}
                checked={override.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
                disabled={disabled}
              />
              {t('overrideEnabled')}
            </label>
            <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
              {t('priorityLabel')}
              <input
                type="number"
                min={-1000}
                max={1000}
                className={`w-20 ${ADMIN_FIELD}`}
                value={override.priority}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 10);
                  update({
                    priority: Number.isNaN(parsed)
                      ? 0
                      : Math.max(-1000, Math.min(1000, parsed)),
                  });
                }}
                disabled={disabled}
                aria-label={t('priorityLabel')}
              />
            </label>
            <button
              type="button"
              className={ADMIN_BTN_ICON_DANGER}
              onClick={onRemove}
              disabled={disabled}
              aria-label={t('removeOverride')}
            >
              <IconTrash size={16} />
            </button>
          </div>
          <p className={`-mt-2 mb-3 ${ADMIN_HINT}`}>{t('priorityHint')}</p>

          <div className="mb-3">
            <label className={ADMIN_LABEL}>
              {t(`targetsLabel.${override.scope}` as never)}
            </label>
            {isGroupScope ? (
              <GroupSearchPicker
                values={override.targets}
                onChange={(targets) => update({ targets })}
                labels={{
                  searchPlaceholder: t('groupSearchPlaceholder'),
                  searchHint: t('groupSearchHint'),
                  noResults: t('groupSearchNoResults'),
                  searchError: t('groupSearchError'),
                  chipPlaceholder: t('targetsPlaceholder.group'),
                  addHint: t('chipAddHint'),
                  removeLabel: t('removeChip'),
                  flagOffHint: t('groupsFlagOff'),
                }}
                disabled={disabled}
              />
            ) : (
              <ChipListInput
                values={override.targets}
                onChange={(targets) => update({ targets })}
                normalize={
                  override.scope === 'domain' ? normalizeDomainEntry : undefined
                }
                placeholder={t(`targetsPlaceholder.${override.scope}` as never)}
                addHint={t('chipAddHint')}
                removeLabel={t('removeChip')}
                disabled={disabled}
              />
            )}
          </div>

          <div className="space-y-3">
            {configuredGroups.map(({ group, gateConfigured, members }) => {
              const gateDef = group.gateKey
                ? getLimitDefinition(group.gateKey)
                : undefined;
              const gateOff = gateEffectivelyOff(group);
              return (
                <div
                  key={group.id}
                  className="border-t border-gray-200 pt-2 dark:border-gray-700"
                >
                  <div className={`mb-1 ${ADMIN_MUTED}`}>
                    {t(`group.${group.id}` as never)}
                  </div>
                  <div className="space-y-2">
                    {gateConfigured && gateDef && (
                      <LimitRow
                        def={gateDef}
                        draft={draft}
                        onChange={setValue}
                        disabled={disabled}
                      />
                    )}
                    {members.map((def) => (
                      <LimitRow
                        key={def.key}
                        def={def}
                        draft={draft}
                        onChange={setValue}
                        dimmed={gateOff}
                        dimmedNote={t('overrideGateOffNote', {
                          feature: t(`group.${group.id}` as never),
                        })}
                        disabled={disabled}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {unrecognized.length > 0 && (
            <div className="mt-3">
              <div className={ADMIN_MUTED}>{t('unrecognizedEntries')}</div>
              {unrecognized.map((key) => (
                <div key={key} className={ADMIN_MUTED}>
                  <code className="font-mono">{key}</code>
                  {' = '}
                  {String(draft[key])}
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center gap-1.5">
            <select
              className={ADMIN_FIELD}
              value={pendingAdd}
              onChange={(e) => addLimit(e.target.value)}
              disabled={disabled}
              aria-label={t('addLimitLabel')}
            >
              <option value="">{t('addLimitPlaceholder')}</option>
              {unconfiguredByGroup.map(({ group, keys }) => (
                <optgroup
                  key={group.id}
                  label={t(`group.${group.id}` as never)}
                >
                  {keys.map((key) => {
                    const def = getLimitDefinition(key);
                    return (
                      <option key={key} value={key}>
                        {def ? t(`label.${def.labelKey}` as never) : key}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
};

'use client';

import {
  IconChevronDown,
  IconChevronRight,
  IconTrash,
} from '@tabler/icons-react';
import { FC, ReactNode, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import {
  LimitEntry,
  LimitOverride,
  OverrideScope,
} from '@/lib/services/limits/types';

import {
  ADMIN_BTN_ICON_DANGER,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_DANGER,
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
  TargetVerdict,
  hasUndecidable,
  outOfScopeTargets,
} from '@/components/Limits/jurisdiction';
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
  /**
   * `scoped` = edited by a scoped admin (or a scoped record in the global
   * panel): hides `priority` — scoped records are stored and compared as 0
   * (design §3b) so the field would be a lie — and the per-row Hard ceiling
   * toggle, which a scoped write is refused for (design §5). The `global`
   * variant offers the ceiling toggle on every configured row as long as the
   * record carries no `delegationId` (design §3c: only a global-tier
   * override entry is a ceiling candidate). Defaults to `global`.
   */
  variant?: 'global' | 'scoped';
  /**
   * Pre-translated one-line "applies to <scope>: a, b …" summary, shown in
   * the collapsed header and under the targets editor so the scope of a
   * change is never more than a glance away (design §6b).
   */
  appliesTo?: string;
  /** Extra header chips — delegation label, tier, narrowing flag. */
  chips?: ReactNode;
  /**
   * Controls rendered in the header row OUTSIDE the expand toggle (which is
   * itself a button, so nested controls are not an option): the relevant
   * rules popover lives here.
   */
  headerActions?: ReactNode;
  /**
   * Save-time verdicts for the CURRENT targets (design §4). Out-of-scope
   * targets are listed under the editor with a danger chip each; an
   * undecidable one adds the "applies only to members within your scope"
   * note. UX only — containment is enforced by the resolver.
   */
  verdicts?: TargetVerdict[];
  /**
   * Targets the SERVER refused on the last save (`LIMITS_OUT_OF_SCOPE`).
   * Highlighted like out-of-scope verdicts even if the client rule did not
   * catch them — the server is the authority.
   */
  rejectedTargets?: string[];
  /**
   * Global panel only: lets a global admin hand an override to a delegation
   * (or take it back). Only SAVED delegations belong here — a delegation
   * created this session has no server id yet. Choosing one forces
   * `priority: 0` and clears every ceiling flag, matching what the server
   * normalizes on a `delegationId` record (design §5).
   */
  delegationOptions?: Array<{ id: string; label: string }>;
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
  variant = 'global',
  appliesTo,
  chips,
  headerActions,
  verdicts,
  rejectedTargets = [],
  delegationOptions,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [pendingAdd, setPendingAdd] = useState('');
  const draft: EntryDraft = useMemo(
    () => entriesToDraft(override.entries),
    [override.entries],
  );
  const isGroupScope = override.scope === 'group';

  const update = (patch: Partial<LimitOverride>) =>
    onChange({ ...override, ...patch });

  /** Refused targets: the client's §4 verdicts ∪ the server's last answer. */
  const refused = useMemo(() => {
    const set = new Set<string>();
    for (const target of outOfScopeTargets(verdicts ?? [])) {
      set.add(target.trim().toLowerCase());
    }
    for (const target of rejectedTargets) set.add(target.trim().toLowerCase());
    return override.targets.filter((target) =>
      set.has(target.trim().toLowerCase()),
    );
  }, [verdicts, rejectedTargets, override.targets]);
  const undecidable = verdicts ? hasUndecidable(verdicts) : false;

  const assignDelegation = (delegationId: string) => {
    if (!delegationId) {
      const { delegationId: _dropped, ...rest } = override;
      onChange(rest);
      return;
    }
    // A scoped record never holds the priority lever and never pins a cell;
    // normalize here so what is drafted matches what runs (design §3c).
    onChange({
      ...override,
      delegationId,
      priority: 0,
      entries: override.entries.map((entry) => ({ ...entry, ceiling: false })),
    });
  };

  /**
   * ⚠ `ceilings` MUST be threaded through every draftToEntries call.
   * draftToEntries defaults the argument to {} and then writes
   * `ceiling: ceilings[key] ?? false` for EVERY entry — so without this, one
   * keystroke on any limit rewrote the whole entry array with ceiling:false
   * and silently destroyed stored flags. The write schema
   * (app/api/limits/policy/route.ts) accepts and persists ceiling on override
   * entries, so that was real data loss.
   *
   * On a global-tier override the flag is LIVE: the resolver takes every
   * global-tier override entry with `ceiling: true` as a ceiling candidate
   * and the most specific one clamps the cell (design §3c) — this is the
   * global admin's pin against scoped lifting. `setCeiling` below is the
   * only UI writer; a `delegationId` record never offers it (the server
   * normalizes those to false), and `assignDelegation` clears the flags.
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

  const setCeiling = (key: string, checked: boolean) =>
    update({ entries: draftToEntries(draft, { ...ceilings, [key]: checked }) });

  /**
   * Whether this record may pin a cell. Only the `global` variant AND no
   * `delegationId`: the scoped write path refuses `ceiling: true` and the
   * global PUT normalizes it to false on a delegated record, so offering
   * the toggle there would draft something that can never be stored.
   */
  const ceilingAllowed = variant === 'global' && !override.delegationId;
  const ceilingFor = (limitKey: string) =>
    ceilingAllowed
      ? {
          checked: ceilings[draftKey(limitKey)] ?? false,
          onToggle: (checked: boolean) =>
            setCeiling(draftKey(limitKey), checked),
        }
      : undefined;

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
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
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
          {chips}
          {refused.length > 0 && (
            <span className={ADMIN_CHIP_DANGER}>
              {t('verdictOutOfScopeChip')}
            </span>
          )}
          <span className={`ml-auto ${ADMIN_MUTED}`}>
            {t('targetsCount', { count: override.targets.length })} ·{' '}
            {t('limitsCount', { count: override.entries.length })}
          </span>
          {!expanded && appliesTo && (
            <span className={`w-full ${ADMIN_MUTED}`}>{appliesTo}</span>
          )}
        </button>
        {headerActions}
      </div>

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
            {variant === 'global' && (
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
            )}
            {delegationOptions && (
              <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
                {t('overrideDelegationLabel')}
                <select
                  className={ADMIN_FIELD}
                  value={override.delegationId ?? ''}
                  onChange={(e) => assignDelegation(e.target.value)}
                  disabled={disabled}
                  aria-label={t('overrideDelegationLabel')}
                >
                  <option value="">{t('overrideDelegationNone')}</option>
                  {delegationOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                  {override.delegationId &&
                    !delegationOptions.some(
                      (option) => option.id === override.delegationId,
                    ) && (
                      <option value={override.delegationId}>
                        {override.delegationId}
                      </option>
                    )}
                </select>
              </label>
            )}
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
          {variant === 'global' && (
            <p className={`-mt-2 mb-3 ${ADMIN_HINT}`}>{t('priorityHint')}</p>
          )}
          {delegationOptions && (
            <p className={`-mt-2 mb-3 ${ADMIN_HINT}`}>
              {t('overrideDelegationHint')}
            </p>
          )}

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
                suggest={override.scope === 'user' ? peopleSuggest : undefined}
                suggestionsLabel={tPeople('listLabel')}
                chipTone={(value) =>
                  refused.includes(value) ? 'danger' : undefined
                }
                chipTitle={(value) =>
                  refused.includes(value)
                    ? t('verdictOutOfScopeChip')
                    : undefined
                }
              />
            )}
            {refused.length > 0 && (
              <p className={ADMIN_HINT} role="status">
                {t('verdictOutOfScope', { targets: refused.join(', ') })}
              </p>
            )}
            {undecidable && (
              <p className={ADMIN_HINT}>{t('verdictCrossAxis')}</p>
            )}
            {appliesTo && <p className={ADMIN_HINT}>{appliesTo}</p>}
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
                        ceiling={ceilingFor(gateDef.key)}
                        disabled={disabled}
                      />
                    )}
                    {members.map((def) => (
                      <LimitRow
                        key={def.key}
                        def={def}
                        draft={draft}
                        onChange={setValue}
                        ceiling={ceilingFor(def.key)}
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
          {ceilingAllowed && configuredGroups.length > 0 && (
            <p className={ADMIN_HINT}>{t('overrideCeilingHint')}</p>
          )}

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

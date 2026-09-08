'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  ScopedDelegationView,
  ScopedLimitsError,
  ScopedOverrideFlag,
  useDeleteScopedOverride,
  useSaveScopedOverride,
} from '@/client/hooks/settings/useLimitsAdmin';

import { LimitOverride } from '@/lib/services/limits/types';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { OverrideEditor } from '@/components/Limits/OverrideEditor';
import { RelevantRulesPopover } from '@/components/Limits/RelevantRulesPopover';
import {
  RelevantRule,
  TargetVerdict,
  verdictsForTargets,
} from '@/components/Limits/jurisdiction';
import { LIMITS_CHIP_WARN } from '@/components/Limits/limitsClasses';
import { appliesToLine, jurisdictionLine } from '@/components/Limits/summaries';
import { scopedOverrideBody } from '@/components/Limits/types';

interface ScopedOverrideCardProps {
  override: LimitOverride;
  delegation: ScopedDelegationView;
  /** Server-computed verdicts for the STORED targets (design §6b). */
  serverVerdicts?: TargetVerdict[];
  flags?: ScopedOverrideFlag[];
  /** Other rules touching this override's targets (self excluded). */
  relevantRules: RelevantRule[];
  /** Show the delegation chip — only useful when the caller has several. */
  showDelegation?: boolean;
  /** Created this session, not yet saved — Discard drops it entirely. */
  isNew?: boolean;
  onDiscardNew: () => void;
  /** A save or delete round-tripped (success or conflict) — parent refetches. */
  onSettled: () => void;
  onDirtyChange: (id: string, dirty: boolean) => void;
}

/**
 * One override in SCOPED mode: an OverrideEditor (scoped variant — no
 * priority, no ceiling) with its own Save/Discard, writing through
 * `PUT/DELETE /api/limits/scoped/overrides/:id` (design §5). There is no
 * draft-the-world: each card is its own unit of work.
 *
 * Verdicts are rendered at AUTHORING time from the client-side §4 rules,
 * with the server's verdict preferred for any target it has already judged;
 * a refused save (`LIMITS_OUT_OF_SCOPE`) highlights exactly the targets the
 * server named. A 409 keeps the draft and says the usual conflict sentence.
 *
 * The draft re-seeds from the server object only while NOT dirty (a refetch
 * must never clobber typing), done during render behind a previous-value
 * guard rather than in an effect (react-hooks/set-state-in-effect).
 *
 * The trash icon is the SAME control the global panel renders, but there it
 * only edits a draft (recoverable until Save) while here it is an immediate,
 * irreversible server DELETE. So a STORED record asks first — an inline
 * alertdialog naming the override, mirroring DelegationEditor's
 * `confirmDelete` — and only a never-saved draft (`isNew`) is discarded on
 * the spot, since nothing exists on the server to lose.
 */
export const ScopedOverrideCard: FC<ScopedOverrideCardProps> = ({
  override,
  delegation,
  serverVerdicts = [],
  flags = [],
  relevantRules,
  showDelegation = false,
  isNew = false,
  onDiscardNew,
  onSettled,
  onDirtyChange,
}) => {
  const t = useTranslations('limits');
  const save = useSaveScopedOverride();
  const remove = useDeleteScopedOverride();
  const [draft, setDraft] = useState<LimitOverride>(override);
  const [dirty, setDirty] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [seededFrom, setSeededFrom] = useState(override);
  if (override !== seededFrom) {
    setSeededFrom(override);
    if (!dirty) setDraft(override);
  }

  const busy = save.isPending || remove.isPending;
  const disabled = busy || !delegation.enabled;

  const verdicts = useMemo(() => {
    const byTarget = new Map(
      serverVerdicts.map((v) => [v.target.trim().toLowerCase(), v]),
    );
    return verdictsForTargets(
      draft.scope,
      draft.targets,
      delegation.jurisdiction,
    ).map((verdict) => {
      const server =
        draft.scope === override.scope
          ? byTarget.get(verdict.target.trim().toLowerCase())
          : undefined;
      return server ? { ...server, target: verdict.target } : verdict;
    });
  }, [
    draft.scope,
    draft.targets,
    delegation.jurisdiction,
    serverVerdicts,
    override.scope,
  ]);

  const markDirty = (next: boolean) => {
    setDirty(next);
    onDirtyChange(override.id, next);
  };

  const change = (next: LimitOverride) => {
    setDraft(next);
    setRejected([]);
    markDirty(true);
  };

  const explain = (error: unknown): string => {
    if (!(error instanceof ScopedLimitsError)) return t('saveFailed');
    switch (error.code) {
      case 'LIMITS_OUT_OF_SCOPE':
        return t('saveRejectedOutOfScope', {
          targets: error.outOfScope.join(', '),
        });
      case 'LIMITS_BUDGET_EXCEEDED':
        return t('saveRejectedBudget', { max: delegation.maxOverrides });
      case 'LIMITS_FOREIGN_OVERRIDE':
        return t('saveRejectedForeign');
      case 'FORBIDDEN':
        return t('saveRejectedForbidden');
      case 'NOT_FOUND':
        return t('saveRejectedNotFound');
      case 'LIMITS_CONFLICT':
        return t('conflict');
      case 'LIMITS_POLICY_UNAVAILABLE':
        return t('policyUnavailable');
      default:
        return error.details || error.message || t('saveFailed');
    }
  };

  const handleSave = async () => {
    try {
      await save.mutateAsync({
        delegationId: delegation.id,
        body: scopedOverrideBody(draft),
      });
      setRejected([]);
      markDirty(false);
      toast.success(t('scopedSaved'));
      onSettled();
    } catch (error) {
      if (
        error instanceof ScopedLimitsError &&
        error.code === 'LIMITS_OUT_OF_SCOPE'
      ) {
        setRejected(error.outOfScope);
      }
      toast.error(explain(error));
      // A conflict or a vanished record means the server view moved on; the
      // draft is KEPT (dirty), only the surrounding data refreshes.
      if (
        error instanceof ScopedLimitsError &&
        (error.code === 'LIMITS_CONFLICT' || error.code === 'NOT_FOUND')
      ) {
        onSettled();
      }
    }
  };

  /** Trash icon: a never-saved draft is discarded; a stored record asks. */
  const requestRemove = () => {
    if (isNew) {
      markDirty(false);
      onDiscardNew();
      return;
    }
    setConfirmDelete(true);
  };

  const confirmRemove = async () => {
    setConfirmDelete(false);
    try {
      await remove.mutateAsync({ id: override.id });
      markDirty(false);
      toast.success(t('scopedDeleted'));
      onSettled();
    } catch (error) {
      toast.error(explain(error));
      if (error instanceof ScopedLimitsError && error.code === 'NOT_FOUND') {
        onSettled();
      }
    }
  };

  const discard = () => {
    if (isNew) {
      markDirty(false);
      onDiscardNew();
      return;
    }
    setDraft(override);
    setRejected([]);
    markDirty(false);
  };

  return (
    <div className="space-y-2">
      <OverrideEditor
        override={draft}
        onChange={change}
        onRemove={requestRemove}
        disabled={disabled}
        defaultExpanded={isNew}
        variant="scoped"
        appliesTo={appliesToLine(t, draft.scope, draft.targets)}
        verdicts={verdicts}
        rejectedTargets={rejected}
        chips={
          <>
            {showDelegation && (
              <span className={ADMIN_CHIP_NEUTRAL}>
                {delegation.label || t('untitledDelegation')}
              </span>
            )}
            {flags.includes('out-of-scope-targets') && (
              <span className={LIMITS_CHIP_WARN}>{t('narrowedChip')}</span>
            )}
            {flags.includes('delegation-disabled') && (
              <span className={ADMIN_CHIP_NEUTRAL}>
                {t('delegationDisabledChip')}
              </span>
            )}
            {dirty && (
              <span className={ADMIN_CHIP_NEUTRAL}>{t('unsavedChanges')}</span>
            )}
          </>
        }
        headerActions={<RelevantRulesPopover rules={relevantRules} />}
      />
      {confirmDelete && (
        <div role="alertdialog" className={ADMIN_BANNER_WARN}>
          <p className="flex items-center gap-2">
            <IconAlertTriangle size={16} aria-hidden="true" />
            {t('confirmDeleteOverride', {
              label: draft.label || t('untitledOverride'),
            })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={confirmRemove}
              disabled={disabled}
            >
              {t('confirmDeleteOverrideAction')}
            </button>
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={() => setConfirmDelete(false)}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 px-1">
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          onClick={handleSave}
          disabled={disabled || !dirty || draft.targets.length === 0}
        >
          {save.isPending ? t('saving') : t('save')}
        </button>
        {(dirty || isNew) && (
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={discard}
            disabled={busy}
          >
            {t('discard')}
          </button>
        )}
        <span className={ADMIN_MUTED}>
          {t('confinedTo', {
            jurisdiction: jurisdictionLine(t, delegation.jurisdiction),
          })}
        </span>
      </div>
    </div>
  );
};

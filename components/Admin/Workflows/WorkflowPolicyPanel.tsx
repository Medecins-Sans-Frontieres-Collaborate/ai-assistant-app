'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  WorkflowPolicyConflict,
  WorkflowPolicyResponse,
  useWorkflowPolicyAdmin,
} from '@/client/hooks/settings/useWorkflowPolicyAdmin';

import {
  WORKFLOW_POLICY_DEFAULTS,
  resolveAllWorkflowsEnabled,
} from '@/lib/services/workflows/policy/types';

import {
  CONVERSATION_WORKFLOW_TYPES,
  ConversationWorkflowType,
} from '@/types/workflow';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_HINT,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';
import { WORKFLOW_META } from '@/components/Workflows/registryMeta';

type Draft = Record<ConversationWorkflowType, boolean>;

/**
 * Admin panel for the workflow enable/disable policy
 * (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md).
 *
 * One document, one CAS'd PUT with If-Match; on 409 the admin is told
 * another admin won the race and the policy is reloaded. The server
 * component gates access; this client is presentation only.
 */
export const WorkflowPolicyPanel: FC = () => {
  const t = useTranslations('workflowsAdmin');
  const tWorkflows = useTranslations('workflows');
  const { query, save } = useWorkflowPolicyAdmin();
  const [draft, setDraft] = useState<Draft>({ ...WORKFLOW_POLICY_DEFAULTS });
  const [etag, setEtag] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Seed the draft from each NEW server response during render (the
  // "storing information from previous renders" pattern) rather than in an
  // effect, so a reload after a 409 replaces the stale draft in the same
  // pass and never flashes the old toggles.
  const [seededFrom, setSeededFrom] = useState<WorkflowPolicyResponse | null>(
    null,
  );
  if (
    query.data &&
    query.data !== seededFrom &&
    !query.data.policyUnavailable
  ) {
    setSeededFrom(query.data);
    setEtag(query.data.etag);
    setDraft(resolveAllWorkflowsEnabled(query.data.policy));
    setDirty(false);
  }

  const setAll = (enabled: boolean) => {
    const next = {} as Draft;
    for (const type of CONVERSATION_WORKFLOW_TYPES) next[type] = enabled;
    setDraft(next);
    setDirty(true);
  };

  const toggle = (type: ConversationWorkflowType) => {
    setDraft((prev) => ({ ...prev, [type]: !prev[type] }));
    setDirty(true);
  };

  const handleSave = async () => {
    const workflows = {} as Record<
      ConversationWorkflowType,
      { enabled: boolean }
    >;
    for (const type of CONVERSATION_WORKFLOW_TYPES) {
      workflows[type] = { enabled: draft[type] };
    }
    try {
      const result = await save.mutateAsync({ workflows, etag });
      setEtag(result.etag);
      setDirty(false);
      toast.success(t('saveSuccess'));
    } catch (error) {
      if (error instanceof WorkflowPolicyConflict) {
        toast.error(t('conflictError'));
        await query.refetch();
        return;
      }
      toast.error(t('saveError'));
    }
  };

  if (query.isLoading) {
    return <p className={`p-6 ${ADMIN_MUTED}`}>{t('loading')}</p>;
  }

  if (query.isError || !query.data) {
    return (
      <div className="p-6">
        <div className={`${ADMIN_BANNER_ERROR} flex items-center gap-3`}>
          <span className="flex-1">{t('loadError')}</span>
          <button
            type="button"
            className={ADMIN_BTN_RETRY}
            onClick={() => query.refetch()}
          >
            {t('retry')}
          </button>
        </div>
      </div>
    );
  }

  if (query.data.policyUnavailable) {
    return (
      <div className="p-6">
        <div className={`${ADMIN_BANNER_WARN} flex items-center gap-3`}>
          <IconAlertTriangle size={18} className="shrink-0" aria-hidden />
          <span className="flex-1">{t('policyUnavailable')}</span>
          <button
            type="button"
            className={ADMIN_BTN_RETRY}
            onClick={() => query.refetch()}
          >
            {t('retry')}
          </button>
        </div>
      </div>
    );
  }

  const policy = query.data.policy;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold text-black dark:text-white">
          {t('title')}
        </h2>
        <p className={`mt-1 text-sm text-gray-600 dark:text-gray-300`}>
          {t('description')}
        </p>
        <p className={ADMIN_HINT}>{t('layeredNote')}</p>
      </header>

      <section className={ADMIN_CARD}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => setAll(true)}
          >
            {t('enableAll')}
          </button>
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => setAll(false)}
          >
            {t('disableAll')}
          </button>
        </div>

        <ul className="space-y-2">
          {CONVERSATION_WORKFLOW_TYPES.map((type) => {
            const meta = WORKFLOW_META[type];
            const Icon = meta.icon;
            const inputId = `workflow-policy-${type}`;
            return (
              <li key={type} className={`${ADMIN_ROW} flex items-start gap-3`}>
                <input
                  id={inputId}
                  type="checkbox"
                  className={`${ADMIN_CHECKBOX} mt-1`}
                  checked={draft[type]}
                  onChange={() => toggle(type)}
                />
                <label htmlFor={inputId} className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-black dark:text-white">
                    <Icon size={16} aria-hidden />
                    {tWorkflows(`types.${meta.i18nKey}.label`)}
                    <span className={ADMIN_MUTED}>
                      {draft[type] ? t('enabledLabel') : t('disabledLabel')}
                    </span>
                  </span>
                  <span className={`block ${ADMIN_MUTED}`}>
                    {tWorkflows(`types.${meta.i18nKey}.description`)}
                  </span>
                  <span className={`block ${ADMIN_HINT}`}>
                    {WORKFLOW_POLICY_DEFAULTS[type]
                      ? t('defaultOnHint')
                      : t('defaultOffHint')}
                  </span>
                  {type === 'grants' && (
                    <span className={`block ${ADMIN_HINT}`}>
                      {t('grantsNote')}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      <footer className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          disabled={!dirty || save.isPending}
          onClick={handleSave}
        >
          {save.isPending ? t('saving') : t('save')}
        </button>
        {dirty && <span className={ADMIN_MUTED}>{t('unsaved')}</span>}
        {!dirty && (
          <span className={ADMIN_MUTED}>
            {policy
              ? t('updatedByLine', {
                  by: policy.updatedBy,
                  at: new Date(policy.updatedAt).toLocaleString(),
                })
              : t('neverSaved')}
          </span>
        )}
      </footer>
    </div>
  );
};

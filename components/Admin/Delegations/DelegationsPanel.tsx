'use client';

import { IconAlertTriangle, IconPlus, IconTrash } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  DelegationsResponse,
  DelegationsSaveError,
  useDelegationsAdmin,
} from '@/client/hooks/settings/useDelegationsAdmin';

import {
  DEFAULT_MAX_OVERRIDES,
  DELEGATION_GRANTS,
  DelegationGrant,
  SharedDelegation,
} from '@/lib/services/delegations/types';
import { WriteSharedDelegation } from '@/lib/services/delegations/writeSchema';

import {
  PredicateDraft,
  PredicateListEditor,
  targetsToText,
  textToTargets,
} from '@/components/Admin/Delegations/PredicateListEditor';
import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';

interface AdminDraft {
  mail: string;
  grants: 'all' | DelegationGrant[];
}

interface DelegationDraft {
  /** Server id; absent for a delegation created this session. */
  id?: string;
  /** Stable React key, also for unsaved rows. */
  key: string;
  label: string;
  enabled: boolean;
  predicates: PredicateDraft[];
  capabilities: DelegationGrant[];
  admins: AdminDraft[];
  maxOverrides: number;
}

let draftCounter = 0;
const nextKey = () => `new-${++draftCounter}`;

function toDraft(delegation: SharedDelegation): DelegationDraft {
  return {
    id: delegation.id,
    key: delegation.id,
    label: delegation.label,
    enabled: delegation.enabled,
    predicates: delegation.jurisdiction.map((predicate) => ({
      scope: predicate.scope,
      text: targetsToText(predicate.targets),
    })),
    capabilities: [...delegation.capabilities],
    admins: delegation.admins.map((admin) => ({
      mail: admin.mail,
      grants: admin.grants === 'all' ? 'all' : [...admin.grants],
    })),
    maxOverrides: delegation.limits.maxOverrides,
  };
}

function toWrite(draft: DelegationDraft): WriteSharedDelegation {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    label: draft.label.trim(),
    enabled: draft.enabled,
    jurisdiction: draft.predicates
      .map((predicate) => ({
        scope: predicate.scope,
        targets: textToTargets(predicate.text),
      }))
      .filter((predicate) => predicate.targets.length > 0),
    capabilities: draft.capabilities,
    admins: draft.admins
      .filter((admin) => admin.mail.trim().length > 0)
      .map((admin) => ({
        mail: admin.mail.trim().toLowerCase(),
        grants: admin.grants,
      })),
    limits: { maxOverrides: draft.maxOverrides },
  };
}

/**
 * Shared delegations (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §7): a delegation
 * says WHOSE users (its jurisdiction), which capabilities it can confer, and
 * which grants each of its admins holds. "All" means every capability THIS
 * delegation enables — never one added later without a global admin ticking
 * it here.
 *
 * One document, one CAS'd PUT; on 409 the admin is told another admin won the
 * race and the document is reloaded. The page's server component gates access.
 */
export const DelegationsPanel: FC = () => {
  const t = useTranslations('delegationsAdmin');
  const { query, save } = useDelegationsAdmin();
  const [drafts, setDrafts] = useState<DelegationDraft[]>([]);
  const [etag, setEtag] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [seededFrom, setSeededFrom] = useState<DelegationsResponse | null>(
    null,
  );
  if (query.data && query.data !== seededFrom && !query.data.unavailable) {
    setSeededFrom(query.data);
    setEtag(query.data.etag);
    setDrafts((query.data.document?.delegations ?? []).map(toDraft));
    setDirty(false);
  }

  const patch = (key: string, change: Partial<DelegationDraft>) => {
    setDrafts((previous) =>
      previous.map((draft) =>
        draft.key === key ? { ...draft, ...change } : draft,
      ),
    );
    setDirty(true);
  };

  const handleSave = async () => {
    if (!etag) return;
    try {
      const result = await save.mutateAsync({
        delegations: drafts.map(toWrite),
        etag,
      });
      setEtag(result.etag);
      setDirty(false);
      toast.success(t('saveSuccess'));
    } catch (error) {
      if (error instanceof DelegationsSaveError) {
        if (error.status === 409) {
          toast.error(t('conflictError'));
          await query.refetch();
          return;
        }
        if (error.code === 'DELEGATION_OWNS_OVERRIDES') {
          toast.error(
            t('ownsOverridesError', { details: error.details ?? '' }),
          );
          return;
        }
        if (error.code === 'DELEGATION_BUDGET_EXCEEDED') {
          toast.error(t('budgetError', { details: error.details ?? '' }));
          return;
        }
        toast.error(
          error.details ? `${error.message}: ${error.details}` : error.message,
        );
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
  if (query.data.unavailable) {
    return (
      <div className="p-6">
        <div className={`${ADMIN_BANNER_WARN} flex items-center gap-3`}>
          <IconAlertTriangle size={18} className="shrink-0" aria-hidden />
          <span className="flex-1">{t('unavailable')}</span>
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

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold text-black dark:text-white">
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          {t('description')}
        </p>
        <p className={ADMIN_HINT}>{t('grantsNote')}</p>
      </header>

      {drafts.length === 0 && <p className={ADMIN_MUTED}>{t('empty')}</p>}

      {drafts.map((draft) => (
        <section key={draft.key} className={`${ADMIN_CARD} space-y-4`}>
          <div className="flex flex-wrap items-center gap-3">
            <input
              aria-label={t('label')}
              className={`${ADMIN_FIELD} min-w-0 flex-1`}
              value={draft.label}
              placeholder={t('labelPlaceholder')}
              maxLength={200}
              onChange={(e) => patch(draft.key, { label: e.target.value })}
            />
            <label className="flex items-center gap-2 text-sm text-black dark:text-white">
              <input
                type="checkbox"
                className={ADMIN_CHECKBOX}
                checked={draft.enabled}
                onChange={(e) =>
                  patch(draft.key, { enabled: e.target.checked })
                }
              />
              {t('enabled')}
            </label>
            <button
              type="button"
              className={ADMIN_BTN_ICON_DANGER}
              aria-label={t('removeDelegation')}
              onClick={() => {
                setDrafts((previous) =>
                  previous.filter((d) => d.key !== draft.key),
                );
                setDirty(true);
              }}
            >
              <IconTrash size={16} />
            </button>
          </div>

          <div>
            <p className={ADMIN_LABEL}>{t('jurisdiction')}</p>
            <p className={ADMIN_HINT}>{t('jurisdictionHint')}</p>
            <div className="mt-2">
              <PredicateListEditor
                idPrefix={`delegation-${draft.key}`}
                predicates={draft.predicates}
                onChange={(predicates) => patch(draft.key, { predicates })}
              />
            </div>
          </div>

          <div>
            <p className={ADMIN_LABEL}>{t('capabilities')}</p>
            <p className={ADMIN_HINT}>{t('capabilitiesHint')}</p>
            <div className="mt-2 flex flex-wrap gap-4">
              {DELEGATION_GRANTS.map((grant) => (
                <label
                  key={grant}
                  className="flex items-center gap-2 text-sm text-black dark:text-white"
                >
                  <input
                    type="checkbox"
                    className={ADMIN_CHECKBOX}
                    checked={draft.capabilities.includes(grant)}
                    onChange={(e) =>
                      patch(draft.key, {
                        capabilities: e.target.checked
                          ? [...draft.capabilities, grant]
                          : draft.capabilities.filter((g) => g !== grant),
                      })
                    }
                  />
                  {t(`grant.${grant}`)}
                </label>
              ))}
            </div>
            {draft.capabilities.includes('limits') && (
              <label className="mt-3 flex items-center gap-2 text-sm text-black dark:text-white">
                {t('maxOverrides')}
                <input
                  type="number"
                  min={0}
                  max={100}
                  className={`${ADMIN_FIELD} w-24`}
                  value={draft.maxOverrides}
                  onChange={(e) =>
                    patch(draft.key, {
                      maxOverrides: Math.max(
                        0,
                        Math.min(100, Number(e.target.value) || 0),
                      ),
                    })
                  }
                />
              </label>
            )}
          </div>

          <div>
            <p className={ADMIN_LABEL}>{t('admins')}</p>
            <p className={ADMIN_HINT}>{t('adminsHint')}</p>
            <ul className="mt-2 space-y-2">
              {draft.admins.map((admin, index) => {
                const setAdmin = (change: Partial<AdminDraft>) =>
                  patch(draft.key, {
                    admins: draft.admins.map((a, i) =>
                      i === index ? { ...a, ...change } : a,
                    ),
                  });
                return (
                  <li key={index} className="flex flex-wrap items-center gap-3">
                    <input
                      type="email"
                      aria-label={t('adminMail')}
                      className={`${ADMIN_FIELD} min-w-[14rem] flex-1`}
                      value={admin.mail}
                      placeholder="name@example.org"
                      onChange={(e) => setAdmin({ mail: e.target.value })}
                    />
                    <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
                      <input
                        type="checkbox"
                        className={ADMIN_CHECKBOX}
                        checked={admin.grants === 'all'}
                        onChange={(e) =>
                          setAdmin({
                            grants: e.target.checked
                              ? 'all'
                              : [...draft.capabilities],
                          })
                        }
                      />
                      {t('grantAll')}
                    </label>
                    {DELEGATION_GRANTS.map((grant) => {
                      const offered = draft.capabilities.includes(grant);
                      const held =
                        admin.grants === 'all'
                          ? offered
                          : admin.grants.includes(grant);
                      return (
                        <label
                          key={grant}
                          className={`flex items-center gap-1.5 text-sm ${
                            offered
                              ? 'text-black dark:text-white'
                              : 'text-gray-400 dark:text-gray-500'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className={ADMIN_CHECKBOX}
                            checked={held}
                            disabled={admin.grants === 'all' || !offered}
                            onChange={(e) => {
                              const current =
                                admin.grants === 'all' ? [] : admin.grants;
                              setAdmin({
                                grants: e.target.checked
                                  ? [...current, grant]
                                  : current.filter((g) => g !== grant),
                              });
                            }}
                          />
                          {t(`grant.${grant}`)}
                        </label>
                      );
                    })}
                    <button
                      type="button"
                      className={ADMIN_BTN_ICON_DANGER}
                      aria-label={t('removeAdmin')}
                      onClick={() =>
                        patch(draft.key, {
                          admins: draft.admins.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <IconTrash size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className={`${ADMIN_BTN_SECONDARY} mt-2`}
              onClick={() =>
                patch(draft.key, {
                  admins: [...draft.admins, { mail: '', grants: 'all' }],
                })
              }
            >
              <IconPlus size={16} />
              {t('addAdmin')}
            </button>
          </div>
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={() => {
            setDrafts((previous) => [
              ...previous,
              {
                key: nextKey(),
                label: '',
                enabled: true,
                predicates: [{ scope: 'domain', text: '' }],
                capabilities: [],
                admins: [],
                maxOverrides: DEFAULT_MAX_OVERRIDES,
              },
            ]);
            setDirty(true);
          }}
        >
          <IconPlus size={16} />
          {t('addDelegation')}
        </button>
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          disabled={!dirty || save.isPending || !etag}
          onClick={handleSave}
        >
          {save.isPending ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  );
};

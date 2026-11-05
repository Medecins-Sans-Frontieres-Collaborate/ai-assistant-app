'use client';

import { useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import {
  AuxiliaryAdminError,
  useAuxiliaryModelsAdmin,
} from '@/client/hooks/settings/useAuxiliaryModelsAdmin';

import {
  AUXILIARY_LIMITS,
  AUXILIARY_PURPOSES,
  AUXILIARY_REGIONS,
  type AuxiliaryAdminReport,
  type AuxiliaryAssignments,
  type AuxiliaryCandidateStatus,
  type AuxiliaryPurpose,
  type AuxiliaryReference,
  type AuxiliaryRegion,
  PURPOSE_OPERATIONS,
  referenceKey,
} from '@/lib/services/auxiliary/types';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_FIELD,
  ADMIN_LABEL,
} from '../adminClasses';

const body = 'text-sm text-gray-700 dark:text-gray-300';
const action = `${ADMIN_BTN_SECONDARY} min-h-11 justify-center`;

/** Environment-local assignment editor and readiness report, gated by the server page and API. */
export function AuxiliaryModelsPanel() {
  const t = useTranslations('auxiliaryModels');
  const format = useFormatter();
  const { query, refresh, save, probe } = useAuxiliaryModelsAdmin();
  const [tab, setTab] = useState<'assignments' | 'readiness'>('assignments');
  const [draft, setDraft] = useState<AuxiliaryAssignments | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [seed, setSeed] = useState<AuxiliaryAdminReport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (query.data && query.data !== seed) {
    setSeed(query.data);
    if (!dirty && !query.data.configUnavailable) {
      setDraft(structuredClone(query.data.effective));
      setEtag(query.data.etag);
    }
  }
  const timestamp = (value?: string) =>
    value
      ? format.dateTime(new Date(value), {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : t('neverChecked');
  const busy = refresh.isPending || save.isPending || probe.isPending;
  const error = save.error ?? probe.error ?? refresh.error;
  const edit = (
    purpose: AuxiliaryPurpose,
    region: AuxiliaryRegion,
    entries: AuxiliaryReference[],
  ) => {
    if (!draft) return;
    setDraft({ ...draft, [purpose]: { ...draft[purpose], [region]: entries } });
    setDirty(true);
    setNotice(null);
  };
  if (query.isLoading)
    return (
      <div className="space-y-4 p-6" role="status" aria-busy="true">
        <p>{t('loading')}</p>
        <div className="h-20 rounded-md bg-gray-100 dark:bg-gray-800" />
      </div>
    );
  if (!query.data || query.isError)
    return (
      <div className="space-y-4 p-6">
        <p className={ADMIN_BANNER_ERROR} role="alert">
          {t('loadError')}
        </p>
        <button className={action} onClick={() => query.refetch()}>
          {t('retry')}
        </button>
      </div>
    );
  const report = query.data;
  const problems = report.chains.filter(
    (chain) =>
      chain.state !== 'ready' ||
      chain.redundancy < 2 ||
      chain.candidates.some((candidate) => candidate.retiringSoon),
  );
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <span className={`${ADMIN_CHIP_NEUTRAL} text-sm`}>
            {report.environment}
          </span>
        </div>
        <p className={`${body} max-w-prose`}>{t('description')}</p>
        <p className={body}>{t('environmentHint')}</p>
        <p className={body}>
          {t('updated', { time: timestamp(report.checkedAt) })}
        </p>
        <button
          className={action}
          disabled={busy}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? t('refreshing') : t('refreshInventory')}
        </button>
      </header>
      {report.configUnavailable && (
        <p role="alert" className={ADMIN_BANNER_ERROR}>
          {t('configUnavailable')}
        </p>
      )}
      {problems.length > 0 && (
        <section aria-label={t('attention')} className="space-y-2">
          <h2 className="text-lg font-semibold">{t('attention')}</h2>
          <ul className={`${ADMIN_BANNER_WARN} space-y-3`}>
            {problems.map((chain) => (
              <li key={`${chain.purpose}:${chain.region}`}>
                <p className="font-semibold">
                  {t(`purpose.${chain.purpose}`)} · {chain.region}:{' '}
                  {t(`state.${chain.state}`)}
                </p>
                <p>{t('eligibleCount', { count: chain.redundancy })}</p>
                {chain.candidates.some((entry) => entry.retiringSoon) && (
                  <p>{t('retirementWarning')}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div
        role="tablist"
        aria-label={t('title')}
        className="flex flex-wrap gap-2 border-b border-gray-200 pb-3 dark:border-gray-700"
      >
        {(['assignments', 'readiness'] as const).map((name) => (
          <button
            id={`aux-tab-${name}`}
            key={name}
            role="tab"
            aria-selected={tab === name}
            aria-controls={`aux-panel-${name}`}
            className={`${action} ${tab === name ? 'font-semibold underline underline-offset-4' : ''}`}
            onClick={() => setTab(name)}
          >
            {t(name)}
          </button>
        ))}
      </div>
      {tab === 'assignments' && (
        <section
          id="aux-panel-assignments"
          role="tabpanel"
          aria-labelledby="aux-tab-assignments"
          className="space-y-6"
        >
          <p className={`${body} max-w-prose`}>{t('assignmentHint')}</p>
          <p className={body}>{t('probeUsage')}</p>
          {draft &&
            AUXILIARY_PURPOSES.map((purpose) => (
              <section key={purpose} className="space-y-5">
                <h2 className="text-xl font-semibold">
                  {t(`purpose.${purpose}`)}
                </h2>
                <p className={`${body} max-w-prose`}>
                  {t(`purposeDescription.${purpose}`)}
                </p>
                {AUXILIARY_REGIONS.map((region) => (
                  <ChainEditor
                    key={region}
                    purpose={purpose}
                    region={region}
                    entries={draft[purpose][region]}
                    choices={report.choices[region]}
                    report={report}
                    disabled={busy || report.configUnavailable}
                    onChange={(entries) => edit(purpose, region, entries)}
                    onProbe={(reference) =>
                      probe.mutate({ reference, purpose, region })
                    }
                  />
                ))}
              </section>
            ))}
          <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 pt-5 dark:border-gray-700">
            <button
              className={`${ADMIN_BTN_PRIMARY} min-h-11`}
              disabled={!dirty || busy || !draft || report.configUnavailable}
              onClick={() =>
                draft &&
                save.mutate(
                  { assignments: draft, etag },
                  {
                    onSuccess: (result) => {
                      setDraft(structuredClone(result.effective));
                      setEtag(result.etag);
                      setDirty(false);
                      setNotice(t('saved'));
                    },
                  },
                )
              }
            >
              {save.isPending ? t('saving') : t('save')}
            </button>
            <button
              className={action}
              disabled={busy || report.configUnavailable}
              onClick={() => {
                setDraft(structuredClone(report.defaults));
                setDirty(true);
                setNotice(null);
              }}
            >
              {t('resetDefaults')}
            </button>
            {dirty && <span className={body}>{t('unsaved')}</span>}
          </div>
        </section>
      )}
      {tab === 'readiness' && (
        <section
          id="aux-panel-readiness"
          role="tabpanel"
          aria-labelledby="aux-tab-readiness"
          className="space-y-6"
        >
          <p className={`${body} max-w-prose`}>{t('readinessHint')}</p>
          {report.inventory.map((inventory) => (
            <section
              key={inventory.account.binding}
              className="space-y-2 border-t border-gray-200 pt-4 dark:border-gray-700"
            >
              <h2 className="text-lg font-semibold">
                {t('account', { binding: inventory.account.binding })}:{' '}
                {t(`inventoryState.${inventory.status}`)}
              </h2>
              <p className={body}>
                {t('lastInventory', { time: timestamp(inventory.fetchedAt) })}
              </p>
              {inventory.account.resourcePath && (
                <p className={`${body} break-all`}>
                  {inventory.account.resourcePath}
                </p>
              )}
              {inventory.account.endpoint && (
                <p className={`${body} break-all`}>
                  {inventory.account.endpoint}
                </p>
              )}
              {inventory.error && (
                <p className={ADMIN_BANNER_WARN}>
                  {t(`accountError.${inventory.error}`)}
                </p>
              )}
              {!inventory.retirementAvailable && (
                <p className={body}>{t('retirementUnknown')}</p>
              )}
            </section>
          ))}
          <section className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
            <h2 className="text-lg font-semibold">{t('history')}</h2>
            <p className={`${body} break-all`}>
              {t('revision', { revision: report.revision })}
            </p>
            {report.history.length ? (
              <ul className="space-y-3">
                {report.history.map((entry) => (
                  <li className={body} key={entry.revision}>
                    {timestamp(entry.updatedAt)} · {entry.updatedBy}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={body}>{t('noHistory')}</p>
            )}
          </section>
        </section>
      )}
      {notice && (
        <p role="status" className={body}>
          {notice}
        </p>
      )}
      {error && (
        <div role="alert" className={`${ADMIN_BANNER_ERROR} space-y-3`}>
          <p>
            {error instanceof AuxiliaryAdminError && error.status === 409
              ? t('conflict')
              : error instanceof AuxiliaryAdminError && error.status === 429
                ? t('rateLimit')
                : t('actionError')}
          </p>
          {error instanceof AuxiliaryAdminError && (
            <details>
              <summary>{t('technicalDetails')}</summary>
              <p className="mt-2 break-words">{error.message}</p>
            </details>
          )}
          {error instanceof AuxiliaryAdminError && error.status === 409 && (
            <button
              className={action}
              onClick={async () => {
                const refreshed = await query.refetch();
                if (refreshed.data) {
                  setDraft(structuredClone(refreshed.data.effective));
                  setEtag(refreshed.data.etag);
                  setDirty(false);
                  save.reset();
                }
              }}
            >
              {t('reloadPolicy')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChainEditor({
  purpose,
  region,
  entries,
  choices,
  report,
  disabled,
  onChange,
  onProbe,
}: {
  purpose: AuxiliaryPurpose;
  region: AuxiliaryRegion;
  entries: AuxiliaryReference[];
  choices: AuxiliaryCandidateStatus[];
  report: AuxiliaryAdminReport;
  disabled: boolean;
  onChange: (entries: AuxiliaryReference[]) => void;
  onProbe: (reference: AuxiliaryReference) => void;
}) {
  const t = useTranslations('auxiliaryModels');
  const format = useFormatter();
  const [selected, setSelected] = useState('');
  const [filter, setFilter] = useState('');
  const choice = choices.find(
    (entry) => referenceKey(entry.reference) === selected,
  );
  const statusFor = (reference: AuxiliaryReference) =>
    choices.find(
      (entry) => referenceKey(entry.reference) === referenceKey(reference),
    ) ??
    report.chains
      .find((chain) => chain.purpose === purpose && chain.region === region)
      ?.candidates.find(
        (entry) => referenceKey(entry.reference) === referenceKey(reference),
      );
  const checked = (status?: AuxiliaryCandidateStatus) =>
    !!status?.fingerprint &&
    PURPOSE_OPERATIONS[purpose].every((operation) => {
      const latest = status.observations
        .filter((entry) => entry.operation === operation)
        .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
      return (
        latest?.success &&
        Date.now() - Date.parse(latest.checkedAt) <
          AUXILIARY_LIMITS.probeFreshMs
      );
    });
  const move = (index: number, direction: number) => {
    const next = [...entries];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    onChange(next);
  };
  const id = `aux-${purpose}-${region}`;
  return (
    <section
      className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700"
      aria-labelledby={`${id}-heading`}
    >
      <h3 id={`${id}-heading`} className="text-lg font-semibold">
        {region}
      </h3>
      {!entries.length && (
        <p className={ADMIN_BANNER_WARN}>{t('emptyChain')}</p>
      )}
      <ol className="divide-y divide-gray-200 dark:divide-gray-700">
        {entries.map((reference, index) => {
          const status = statusFor(reference);
          return (
            <li
              key={referenceKey(reference)}
              className="flex flex-col gap-3 py-4 sm:flex-row sm:justify-between"
            >
              <div className="min-w-0 space-y-2">
                <p className="break-all font-semibold">
                  {index + 1}. {reference.deploymentName}
                </p>
                <p className={body}>
                  {t(index === 0 ? 'primary' : 'fallback')} ·{' '}
                  {reference.accountBinding} ·{' '}
                  {status?.eligible
                    ? checked(status)
                      ? t('state.ready')
                      : t('state.unverified')
                    : t(`reason.${status?.reason ?? 'deployment_missing'}`)}
                </p>
                {status?.deployment && (
                  <p className={`${body} break-words`}>
                    {status.deployment.modelName} ·{' '}
                    {status.deployment.modelVersion ?? t('unknown')} ·{' '}
                    {status.deployment.sku ?? t('unknown')}
                  </p>
                )}
                {status?.deployment?.retiresAt && (
                  <p className={status.retiringSoon ? ADMIN_BANNER_WARN : body}>
                    {t('retires', {
                      date: format.dateTime(
                        new Date(status.deployment.retiresAt),
                        { dateStyle: 'medium' },
                      ),
                    })}
                  </p>
                )}
                {status?.retirementUnknown && (
                  <p className={body}>{t('retirementUnknown')}</p>
                )}
                {status?.observations.length ? (
                  <details className={body}>
                    <summary className="cursor-pointer py-2">
                      {t('checkResults')}
                    </summary>
                    <ul className="space-y-2">
                      {PURPOSE_OPERATIONS[purpose].map((operation) => {
                        const latest = status.observations
                          .filter((entry) => entry.operation === operation)
                          .sort((a, b) =>
                            b.checkedAt.localeCompare(a.checkedAt),
                          )[0];
                        return (
                          <li key={operation}>
                            {t(`operation.${operation}`)}:{' '}
                            {latest
                              ? latest.success
                                ? t('passed')
                                : t(`reason.${latest.reason ?? 'provider'}`)
                              : t('neverChecked')}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                ) : null}
              </div>
              <div className="flex flex-wrap content-start gap-2 sm:max-w-xs">
                <button
                  className={action}
                  aria-label={t('moveUpLabel', {
                    model: reference.deploymentName,
                  })}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  {t('moveUp')}
                </button>
                <button
                  className={action}
                  aria-label={t('moveDownLabel', {
                    model: reference.deploymentName,
                  })}
                  disabled={disabled || index === entries.length - 1}
                  onClick={() => move(index, 1)}
                >
                  {t('moveDown')}
                </button>
                <button
                  className={action}
                  aria-label={t('removeLabel', {
                    model: reference.deploymentName,
                  })}
                  disabled={disabled}
                  onClick={() =>
                    onChange(entries.filter((_, at) => at !== index))
                  }
                >
                  {t('remove')}
                </button>
                <button
                  className={action}
                  disabled={disabled || !status?.eligible}
                  onClick={() => onProbe(reference)}
                >
                  {t('runChecks')}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="space-y-3 pb-4">
        <label className={ADMIN_LABEL} htmlFor={`${id}-filter`}>
          {t('findDeployment')}
        </label>
        <input
          id={`${id}-filter`}
          className={`${ADMIN_FIELD} min-h-11 w-full`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          disabled={disabled}
          type="search"
        />
        <label className={ADMIN_LABEL} htmlFor={`${id}-choice`}>
          {t('deployment')}
        </label>
        <select
          id={`${id}-choice`}
          className={`${ADMIN_FIELD} min-h-11 w-full`}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={disabled}
        >
          <option value="">{t('chooseDeployment')}</option>
          {choices
            .filter(
              (entry) =>
                referenceKey(entry.reference)
                  .toLowerCase()
                  .includes(filter.toLowerCase()) &&
                !entries.some(
                  (ref) => referenceKey(ref) === referenceKey(entry.reference),
                ),
            )
            .map((entry) => (
              <option
                key={referenceKey(entry.reference)}
                value={referenceKey(entry.reference)}
                disabled={!entry.eligible}
              >
                {referenceKey(entry.reference)}
                {!entry.eligible
                  ? ` (${t(`reason.${entry.reason ?? 'incompatible'}`)})`
                  : ''}
              </option>
            ))}
        </select>
        <div className="flex flex-wrap gap-2">
          <button
            className={action}
            disabled={disabled || !choice?.eligible}
            onClick={() => choice && onProbe(choice.reference)}
          >
            {t('runChecks')}
          </button>
          <button
            className={action}
            disabled={
              disabled ||
              !choice?.eligible ||
              !checked(choice) ||
              entries.length >= AUXILIARY_LIMITS.chainLength
            }
            onClick={() => {
              if (choice) {
                onChange([...entries, choice.reference]);
                setSelected('');
              }
            }}
          >
            {t('addDeployment')}
          </button>
        </div>
        {choice && !checked(choice) && (
          <p className={body}>{t('checkBeforeAdd')}</p>
        )}
      </div>
    </section>
  );
}

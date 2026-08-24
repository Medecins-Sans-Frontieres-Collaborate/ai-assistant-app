'use client';

import { IconAlertTriangle, IconMasksTheater } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  ViewAsStateResponse,
  useViewAs,
} from '@/client/hooks/settings/useViewAs';

import {
  ViewAsAdminRole,
  ViewAsOverrides,
  isViewAsEmpty,
  normalizeViewAsOverrides,
} from '@/lib/services/admin/viewAsTypes';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_FIELD,
  ADMIN_HEADING,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';

export interface ViewAsOffice {
  id: string;
  displayName: string;
  region: 'US' | 'EU';
}

interface ViewAsPanelProps {
  offices: ViewAsOffice[];
}

interface FormState {
  adminRole: ViewAsAdminRole;
  localAdminKeys: string;
  region: '' | 'US' | 'EU';
  department: string;
  companyName: string;
  jobTitle: string;
  officeId: string;
  groupIds: string;
}

const EMPTY_FORM: FormState = {
  adminRole: 'global',
  localAdminKeys: '',
  region: '',
  department: '',
  companyName: '',
  jobTitle: '',
  officeId: '',
  groupIds: '',
};

/**
 * The grants team rule (lib/services/grants/access.ts) as a preset: company
 * MSF-USA, department Program, a title containing "grants". Office is not
 * part of that rule, so it is left at the admin's actual value.
 */
const GRANTS_MEMBER_PRESET: Partial<FormState> = {
  companyName: 'MSF-USA',
  department: 'Program',
  jobTitle: 'Grants Officer',
};

function formFromOverrides(overrides: ViewAsOverrides): FormState {
  return {
    adminRole: overrides.adminRole ?? 'global',
    localAdminKeys: (overrides.localAdminKeys ?? []).join(', '),
    region: overrides.region ?? '',
    department: overrides.department ?? '',
    companyName: overrides.companyName ?? '',
    jobTitle: overrides.jobTitle ?? '',
    officeId: overrides.officeId ?? '',
    groupIds: (overrides.groupIds ?? []).join('\n'),
  };
}

function overridesFromForm(form: FormState): ViewAsOverrides {
  const splitList = (raw: string) =>
    raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  return normalizeViewAsOverrides({
    adminRole: form.adminRole,
    localAdminKeys: splitList(form.localAdminKeys),
    region: form.region || undefined,
    department: form.department,
    companyName: form.companyName,
    jobTitle: form.jobTitle,
    officeId: form.officeId,
    groupIds: splitList(form.groupIds),
  });
}

/**
 * Admin "view as" editor (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md). The server
 * component gates access on the REAL identity; this client is presentation
 * only, and every Apply/Exit round-trips through /api/admin/view-as and
 * reloads so the server session callback re-reads the cookie.
 */
export const ViewAsPanel: FC<ViewAsPanelProps> = ({ offices }) => {
  const t = useTranslations('viewAs');
  const { query, apply, clear } = useViewAs();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // Seed the form from each new server response during render (see
  // WorkflowPolicyPanel for why this is not an effect).
  const [seededFrom, setSeededFrom] = useState<ViewAsStateResponse | null>(
    null,
  );
  if (query.data && query.data !== seededFrom) {
    setSeededFrom(query.data);
    const active = query.data.active;
    setForm(active ? formFromOverrides(active.overrides) : EMPTY_FORM);
  }

  const actual = query.data?.actual;
  const active = query.data?.active ?? null;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleApply = async () => {
    const overrides = overridesFromForm(form);
    if (isViewAsEmpty(overrides)) {
      toast.error(t('nothingToApply'));
      return;
    }
    try {
      await apply.mutateAsync(overrides);
    } catch (error) {
      toast.error(
        t('applyError', {
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
  };

  const handleClear = async () => {
    try {
      await clear.mutateAsync();
    } catch (error) {
      toast.error(
        t('clearError', {
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
  };

  if (query.isLoading) {
    return <p className={`p-6 ${ADMIN_MUTED}`}>{t('title')}…</p>;
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

  const actualHint = (value: string | null | undefined) =>
    value
      ? t('attributes.actualValue', { value })
      : t('attributes.actualEmpty');

  const busy = apply.isPending || clear.isPending;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-black dark:text-white">
          <IconMasksTheater size={20} aria-hidden />
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          {t('description')}
        </p>
        <p className={ADMIN_HINT}>{t('expiresNote')}</p>
      </header>

      <div className={`${ADMIN_BANNER_WARN} flex items-center gap-3`}>
        <IconAlertTriangle size={18} className="shrink-0" aria-hidden />
        <span className="flex-1">
          {active ? t('activeTitle') : t('inactiveTitle')}
        </span>
        {active && (
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            disabled={busy}
            onClick={handleClear}
          >
            {clear.isPending ? t('clearing') : t('clear')}
          </button>
        )}
      </div>

      <section className={ADMIN_CARD}>
        <h3 className={ADMIN_HEADING}>{t('sections.presets')}</h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => setForm({ ...EMPTY_FORM, ...GRANTS_MEMBER_PRESET })}
          >
            {t('presets.grantsMember')}
          </button>
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => setForm({ ...EMPTY_FORM, adminRole: 'none' })}
          >
            {t('presets.regularUser')}
          </button>
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => setForm({ ...EMPTY_FORM, adminRole: 'local' })}
          >
            {t('presets.localAdmin')}
          </button>
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() =>
              setForm({
                ...EMPTY_FORM,
                region: actual?.region === 'US' ? 'EU' : 'US',
              })
            }
          >
            {t('presets.otherRegion')}
          </button>
        </div>
        <p className={ADMIN_HINT}>{t('presets.hint')}</p>
      </section>

      <section className={ADMIN_CARD}>
        <h3 className={ADMIN_HEADING}>{t('sections.role')}</h3>
        <div className="space-y-2">
          {(['global', 'local', 'none'] as const).map((role) => (
            <label
              key={role}
              className="flex items-center gap-2 text-sm text-black dark:text-white"
            >
              <input
                type="radio"
                name="view-as-role"
                className="h-4 w-4 accent-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:accent-gray-400"
                checked={form.adminRole === role}
                onChange={() => set('adminRole', role)}
              />
              {t(`role.${role}`)}
            </label>
          ))}
        </div>
        {form.adminRole === 'local' && (
          <div className="mt-3">
            <label htmlFor="view-as-local-keys" className={ADMIN_LABEL}>
              {t('role.localKeysLabel')}
            </label>
            <input
              id="view-as-local-keys"
              type="text"
              className={`${ADMIN_FIELD} w-full`}
              value={form.localAdminKeys}
              onChange={(e) => set('localAdminKeys', e.target.value)}
            />
            <p className={ADMIN_HINT}>{t('role.localKeysHint')}</p>
          </div>
        )}
        {form.adminRole === 'none' && (
          <p className={ADMIN_HINT}>{t('role.noneWarning')}</p>
        )}
      </section>

      <section className={ADMIN_CARD}>
        <h3 className={ADMIN_HEADING}>{t('sections.region')}</h3>
        <label htmlFor="view-as-region" className="sr-only">
          {t('sections.region')}
        </label>
        <select
          id="view-as-region"
          className={ADMIN_FIELD}
          value={form.region}
          onChange={(e) => set('region', e.target.value as FormState['region'])}
        >
          <option value="">
            {t('region.actual', { region: actual?.region ?? '—' })}
          </option>
          <option value="US">US</option>
          <option value="EU">EU</option>
        </select>
        <p className={ADMIN_HINT}>{t('region.hint')}</p>
      </section>

      <section className={ADMIN_CARD}>
        <h3 className={ADMIN_HEADING}>{t('sections.attributes')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['department', 'companyName', 'jobTitle'] as const).map((key) => (
            <div key={key}>
              <label htmlFor={`view-as-${key}`} className={ADMIN_LABEL}>
                {t(`attributes.${key}`)}
              </label>
              <input
                id={`view-as-${key}`}
                type="text"
                className={`${ADMIN_FIELD} w-full`}
                value={form[key]}
                onChange={(e) => set(key, e.target.value)}
              />
              <p className={ADMIN_HINT}>{actualHint(actual?.[key])}</p>
            </div>
          ))}
          <div>
            <label htmlFor="view-as-office" className={ADMIN_LABEL}>
              {t('attributes.officeId')}
            </label>
            <select
              id="view-as-office"
              className={`${ADMIN_FIELD} w-full`}
              value={form.officeId}
              onChange={(e) => set('officeId', e.target.value)}
            >
              <option value="">{t('attributes.officeActual')}</option>
              {offices.map((office) => (
                <option key={office.id} value={office.id}>
                  {office.displayName} ({office.region})
                </option>
              ))}
            </select>
            <p className={ADMIN_HINT}>{actualHint(actual?.officeId)}</p>
          </div>
        </div>
        <p className={ADMIN_HINT}>{t('attributes.hint')}</p>
      </section>

      <section className={ADMIN_CARD}>
        <h3 className={ADMIN_HEADING}>{t('sections.groups')}</h3>
        <label htmlFor="view-as-groups" className={ADMIN_LABEL}>
          {t('groups.label')}
        </label>
        <textarea
          id="view-as-groups"
          rows={4}
          className={`${ADMIN_FIELD} w-full font-mono`}
          placeholder={t('groups.placeholder')}
          value={form.groupIds}
          onChange={(e) => set('groupIds', e.target.value)}
        />
        <p className={ADMIN_HINT}>{t('groups.hint')}</p>
      </section>

      <footer className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          disabled={busy}
          onClick={handleApply}
        >
          {apply.isPending ? t('applying') : t('apply')}
        </button>
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          disabled={busy}
          onClick={() =>
            setForm(active ? formFromOverrides(active.overrides) : EMPTY_FORM)
          }
        >
          {t('reset')}
        </button>
      </footer>
    </div>
  );
};

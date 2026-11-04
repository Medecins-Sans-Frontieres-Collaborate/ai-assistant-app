'use client';

import { type FC, type FormEvent, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  ADMIN_BTN_SECONDARY,
  ADMIN_FIELD,
  ADMIN_HEADING,
  ADMIN_LABEL,
} from '@/components/Admin/adminClasses';

const OBJECT_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HINT = 'mt-1 text-sm text-gray-700 dark:text-gray-200';

/** Global-admin cache refresh form. Shows invalidation, not an unverified upstream permission change. */
export const PermissionCacheControls: FC = () => {
  const t = useTranslations('permissionCache');
  const [scope, setScope] = useState<'user' | 'all'>('user');
  const [userId, setUserId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<'success' | 'error' | null>(null);
  const valid = scope === 'all' ? confirmed : OBJECT_ID.test(userId.trim());

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !valid) return;
    setPending(true);
    setOutcome(null);
    try {
      const response = await fetch('/api/admin/permission-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          scope === 'user'
            ? { scope, userId: userId.trim() }
            : { scope, confirm: confirmed },
        ),
      });
      const result = await response.json();
      if (
        !response.ok ||
        result?.success !== true ||
        result.data?.status !== 'invalidated' ||
        result.data?.freshVerificationRequired !== true
      )
        throw new Error('Permission invalidation was not confirmed');
      setOutcome('success');
    } catch {
      setOutcome('error');
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className="border-t border-gray-200 pt-6 dark:border-gray-700"
      aria-labelledby="permission-cache-title"
    >
      <h3 id="permission-cache-title" className={ADMIN_HEADING}>
        {t('title')}
      </h3>
      <p id="permission-cache-description" className={`${HINT} max-w-prose`}>
        {t('description')}
      </p>
      <form
        onSubmit={submit}
        className="mt-4 space-y-4"
        aria-describedby="permission-cache-description"
        aria-busy={pending}
      >
        <fieldset disabled={pending} className="space-y-4">
          <div>
            <label htmlFor="permission-cache-scope" className={ADMIN_LABEL}>
              {t('scope')}
            </label>
            <select
              id="permission-cache-scope"
              className={`${ADMIN_FIELD} mt-1 min-h-11`}
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as 'user' | 'all');
                setConfirmed(false);
                setOutcome(null);
              }}
            >
              <option value="user">{t('oneUser')}</option>
              <option value="all">{t('everyone')}</option>
            </select>
          </div>
          {scope === 'user' ? (
            <div>
              <label htmlFor="permission-cache-user" className={ADMIN_LABEL}>
                {t('userId')}
              </label>
              <input
                id="permission-cache-user"
                className={`${ADMIN_FIELD} mt-1 min-h-11`}
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                  setOutcome(null);
                }}
                autoComplete="off"
                dir="ltr"
                spellCheck={false}
                required
                aria-invalid={
                  userId.trim() !== '' && !OBJECT_ID.test(userId.trim())
                }
                aria-describedby="permission-cache-user-hint"
              />
              <p id="permission-cache-user-hint" className={HINT}>
                {t('userIdHint')}
              </p>
            </div>
          ) : (
            <label className="flex min-h-11 items-center gap-3 text-sm text-gray-700 dark:text-gray-200">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {t('confirmAll')}
            </label>
          )}
          <button
            type="submit"
            className={`${ADMIN_BTN_SECONDARY} min-h-11`}
            disabled={pending || !valid}
          >
            {pending
              ? t('refreshing')
              : scope === 'user'
                ? t('refreshUser')
                : t('refreshAll')}
          </button>
        </fieldset>
        {outcome && (
          <p
            role={outcome === 'error' ? 'alert' : 'status'}
            className="max-w-prose text-sm text-gray-700 dark:text-gray-200"
          >
            {t(outcome === 'success' ? 'invalidated' : 'failed')}
          </p>
        )}
        <p className={`${HINT} max-w-prose`}>{t('propagationNote')}</p>
      </form>
    </section>
  );
};

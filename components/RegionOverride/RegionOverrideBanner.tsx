'use client';

import { useSession } from 'next-auth/react';
import { useEffect } from 'react';

import { useTranslations } from 'next-intl';

import { useAdminAreas } from '@/client/hooks/settings/useAdminAreas';

import {
  REGION_OVERRIDE_CLEAR,
  REGION_OVERRIDE_COOKIE,
  REGION_OVERRIDE_PARAM,
  UserRegion,
  parseRegion,
} from '@/lib/utils/shared/region';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8; // 8h — long enough for a test session

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function setOverrideCookie(value: UserRegion): void {
  document.cookie = `${REGION_OVERRIDE_COOKIE}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

function clearOverrideCookie(): void {
  document.cookie = `${REGION_OVERRIDE_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** Strips `?regionOverride=` so it isn't re-applied or shared. */
function stripParam(params: URLSearchParams): void {
  params.delete(REGION_OVERRIDE_PARAM);
  const qs = params.toString();
  window.history.replaceState(
    null,
    '',
    window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
  );
}

/**
 * Persistent warning banner for the manual data-region override.
 *
 * GLOBAL ADMINS ONLY. The `?regionOverride=US|EU` param (or `=clear`) writes
 * a plain cookie that the auth session callback honours solely when the real
 * identity is a global admin (auth.ts); for anyone else it is inert. So:
 *
 *  - the param is applied only once the admin-areas query confirms the
 *    caller is a real global admin (`view-as` is the real-identity area),
 *    and is silently stripped for everyone else;
 *  - the banner is driven by the SESSION (`regionOverridden`), never by the
 *    cookie's presence, so a non-admin can never see a warning about an
 *    override that is not actually in effect.
 *
 * A region set through view-as is announced by ViewAsBanner instead, so this
 * stays quiet in that case rather than saying the same thing twice.
 */
export function RegionOverrideBanner() {
  const t = useTranslations();
  const { data: session } = useSession();
  const { areas, isLoading: areasLoading } = useAdminAreas();
  const isRealGlobalAdmin = areas.includes('view-as');

  useEffect(() => {
    if (areasLoading) return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get(REGION_OVERRIDE_PARAM);
    if (raw === null) return;

    let changed = false;
    if (isRealGlobalAdmin) {
      const normalized = raw.trim().toLowerCase();
      if (normalized === REGION_OVERRIDE_CLEAR || normalized === '') {
        if (readCookie(REGION_OVERRIDE_COOKIE) !== null) {
          clearOverrideCookie();
          changed = true;
        }
      } else {
        const parsed = parseRegion(raw);
        if (parsed && readCookie(REGION_OVERRIDE_COOKIE) !== parsed) {
          setOverrideCookie(parsed);
          changed = true;
        }
      }
    }

    stripParam(params);
    // Reload so the server session callback re-reads the cookie and every
    // server-rendered surface reflects the new region.
    if (changed) window.location.reload();
  }, [areasLoading, isRealGlobalAdmin]);

  const user = session?.user;
  const active =
    user?.regionOverridden === true &&
    user.viewAs?.overrides.region === undefined;
  if (!active || !user?.region) return null;

  const handleClear = () => {
    clearOverrideCookie();
    window.location.reload();
  };

  return (
    <div
      role="alert"
      className="flex w-full items-center justify-center gap-3 border-b border-amber-500 bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-900 dark:border-amber-500/60 dark:bg-amber-950/60 dark:text-amber-200"
    >
      <span aria-hidden="true">⚠️</span>
      <span>{t('regionOverride.warning', { region: user.region })}</span>
      <button
        type="button"
        onClick={handleClear}
        className="shrink-0 rounded border border-amber-600 px-2 py-0.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-200 dark:border-amber-400/70 dark:text-amber-100 dark:hover:bg-amber-900/60"
      >
        {t('regionOverride.clear')}
      </button>
    </div>
  );
}

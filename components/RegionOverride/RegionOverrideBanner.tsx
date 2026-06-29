'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { useTranslations } from 'next-intl';

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

// The override only changes when we write the cookie and then reload, so there
// is no live source to subscribe to — a no-op subscribe is sufficient for
// useSyncExternalStore (which we use to read the cookie without a hydration
// mismatch: null on the server, the real value after mount).
const subscribe = () => () => {};

/**
 * Persistent warning banner for the manual data-region override.
 *
 * Activated by a `?regionOverride=US|EU` URL param (or `=clear` to remove it).
 * The param is read once on the client, written to a cookie that the server
 * reads in the auth session callback (so subsequent API requests route to the
 * overridden region), then stripped from the URL so it isn't sticky/shareable.
 * A full reload follows so server-rendered content reflects the new region.
 *
 * While an override is active this renders a prominent banner making it
 * unmistakable that requests are being sent to a region the user selected
 * manually — NOT their actual location.
 */
export function RegionOverrideBanner() {
  const t = useTranslations();

  // Apply (or clear) a `?regionOverride=` param once on mount, then reload so
  // the server session callback re-reads the cookie and every server-rendered
  // surface reflects the new region.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get(REGION_OVERRIDE_PARAM);
    if (raw === null) return;

    const normalized = raw.trim().toLowerCase();
    let changed = false;

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

    // Strip the param so the override isn't re-applied on every navigation and
    // the URL stays shareable without leaking the override.
    params.delete(REGION_OVERRIDE_PARAM);
    const qs = params.toString();
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
    );

    if (changed) window.location.reload();
  }, []);

  const override = parseRegion(
    useSyncExternalStore(
      subscribe,
      () => readCookie(REGION_OVERRIDE_COOKIE),
      () => null,
    ),
  );

  if (!override) return null;

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
      <span>{t('regionOverride.warning', { region: override })}</span>
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

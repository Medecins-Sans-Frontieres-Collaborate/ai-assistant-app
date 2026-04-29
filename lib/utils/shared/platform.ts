'use client';

import { useEffect, useState } from 'react';

/**
 * Platform-aware keyboard hint helpers.
 *
 * The MSF user base is primarily on Windows, so we default to `Ctrl` for any
 * SSR / pre-hydration render and only switch to `⌘` after we can read
 * `navigator.platform` on the client.
 */

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform);
}

/**
 * Returns the bare modifier label used in shortcut hint strings:
 *   `'⌘'` on Mac, `'Ctrl'` elsewhere.
 *
 * The label is intentionally bare (no trailing space, no `+` suffix) so
 * callers can pick the separator that suits their layout. Conventional
 * usage: `${modifier}+${key}` (e.g. `⌘+K`, `Ctrl+K`).
 */
export function getModifierLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl';
}

/**
 * Reactive hook for the modifier label. Returns `'Ctrl'` during SSR and the
 * first render, then updates to `'⌘'` post-hydration on Mac.
 */
export function usePlatformModifier(): string {
  const [label, setLabel] = useState('Ctrl');
  useEffect(() => {
    setLabel(getModifierLabel());
  }, []);
  return label;
}

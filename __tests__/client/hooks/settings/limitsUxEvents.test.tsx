import {
  LIMITS_CHANGED_EVENT,
  notifyLimitsChanged,
} from '@/client/hooks/settings/limitsUxEvents';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('limitsUxEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches limits:changed on window', () => {
    const listener = vi.fn();
    window.addEventListener(LIMITS_CHANGED_EVENT, listener);
    try {
      notifyLimitsChanged();
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as Event).type).toBe('limits:changed');
    } finally {
      window.removeEventListener(LIMITS_CHANGED_EVENT, listener);
    }
  });

  it('is a no-op without a window (SSR / store code on the server)', () => {
    vi.stubGlobal('window', undefined);
    expect(() => notifyLimitsChanged()).not.toThrow();
  });
});

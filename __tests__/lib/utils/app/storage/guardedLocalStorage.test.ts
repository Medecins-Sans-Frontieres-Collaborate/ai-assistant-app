// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A persisted store's writes when the browser's storage is full: dropped
 * with a warning event instead of thrown from inside a state update (which
 * left the prompt editor open after "Save" with no explanation).
 */
describe('guardedLocalStorage', () => {
  // Fresh modules per test: the warning is throttled module-wide.
  const load = async () => {
    vi.resetModules();
    const storage =
      await import('@/lib/utils/app/storage/perConversationStorage');
    const { guardedLocalStorage } =
      await import('@/lib/utils/app/storage/guardedLocalStorage');
    return { guardedLocalStorage, EVENT: storage.STORAGE_QUOTA_EXCEEDED_EVENT };
  };
  const failWith = (error: unknown) =>
    // On the instance: the test setup may install its own localStorage.
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw error;
    });

  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads and writes like localStorage', async () => {
    const { guardedLocalStorage } = await load();
    guardedLocalStorage.setItem('settings-storage', '{"a":1}');
    expect(guardedLocalStorage.getItem('settings-storage')).toBe('{"a":1}');
    guardedLocalStorage.removeItem('settings-storage');
    expect(localStorage.getItem('settings-storage')).toBeNull();
  });

  it('drops a write when storage is full and raises the warning once', async () => {
    const { guardedLocalStorage, EVENT } = await load();
    const heard = vi.fn();
    window.addEventListener(EVENT, heard);
    failWith(new DOMException('full', 'QuotaExceededError'));

    expect(() =>
      guardedLocalStorage.setItem('settings-storage', '{}'),
    ).not.toThrow();
    guardedLocalStorage.setItem('settings-storage', '{}');

    window.removeEventListener(EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({
      scope: 'settings',
      id: 'settings-storage',
    });
  });

  it('still throws errors other than a full storage', async () => {
    const { guardedLocalStorage } = await load();
    failWith(new DOMException('denied', 'SecurityError'));
    expect(() => guardedLocalStorage.setItem('settings-storage', '{}')).toThrow(
      'denied',
    );
  });
});

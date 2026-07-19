/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import { useCameraSupport } from '@/client/hooks/ui/useCameraSupport';

import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = () => void;

/**
 * Installs a fake `navigator.mediaDevices` and returns a handle for driving
 * `devicechange` and swapping what `enumerateDevices` reports.
 */
function stubMediaDevices(devices: { kind: string }[]) {
  const listeners = new Set<Listener>();
  const enumerateDevices = vi.fn(async () => devices);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices,
      addEventListener: (_: string, fn: Listener) => listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    },
  });
  return {
    enumerateDevices,
    setDevices: (next: { kind: string }[]) => {
      devices = next;
    },
    fireDeviceChange: () => listeners.forEach((fn) => fn()),
    listenerCount: () => listeners.size,
  };
}

function removeMediaDevices() {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: undefined,
  });
}

describe('useCameraSupport', () => {
  afterEach(() => {
    removeMediaDevices();
    vi.restoreAllMocks();
  });

  it('reports true when a videoinput device is present', async () => {
    stubMediaDevices([{ kind: 'audioinput' }, { kind: 'videoinput' }]);

    const { result } = renderHook(() => useCameraSupport());

    expect(result.current).toBe(false); // never true before the async check
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('reports false when only non-camera devices exist', async () => {
    stubMediaDevices([{ kind: 'audioinput' }, { kind: 'audiooutput' }]);

    const { result } = renderHook(() => useCameraSupport());

    await waitFor(() => expect(result.current).toBe(false));
  });

  it('reports false when the MediaDevices API is unavailable', async () => {
    removeMediaDevices();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useCameraSupport());

    await waitFor(() => expect(result.current).toBe(false));
  });

  it('reports false when enumerateDevices rejects', async () => {
    const media = stubMediaDevices([]);
    media.enumerateDevices.mockRejectedValue(new Error('denied'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useCameraSupport());

    await waitFor(() => expect(result.current).toBe(false));
  });

  it('re-checks when a camera is plugged in', async () => {
    const media = stubMediaDevices([{ kind: 'audioinput' }]);

    const { result } = renderHook(() => useCameraSupport());
    await waitFor(() => expect(result.current).toBe(false));

    media.setDevices([{ kind: 'audioinput' }, { kind: 'videoinput' }]);
    act(() => media.fireDeviceChange());

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('removes its devicechange listener on unmount', async () => {
    const media = stubMediaDevices([{ kind: 'videoinput' }]);

    const { unmount, result } = renderHook(() => useCameraSupport());
    await waitFor(() => expect(result.current).toBe(true));
    expect(media.listenerCount()).toBe(1);

    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});

import { useEffect, useState } from 'react';

import { checkCameraSupport } from '@/lib/utils/client/device/detection';

/**
 * Reports whether the device exposes at least one camera.
 *
 * Starts `false` so nothing camera-related renders during SSR or on machines
 * without a camera, then re-checks whenever devices are plugged in or removed.
 */
export function useCameraSupport(): boolean {
  const [hasCamera, setHasCamera] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const supported = await checkCameraSupport();
      if (!cancelled) setHasCamera(supported);
    };

    void check();

    const mediaDevices =
      typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    mediaDevices?.addEventListener?.('devicechange', check);

    return () => {
      cancelled = true;
      mediaDevices?.removeEventListener?.('devicechange', check);
    };
  }, []);

  return hasCamera;
}

export default useCameraSupport;

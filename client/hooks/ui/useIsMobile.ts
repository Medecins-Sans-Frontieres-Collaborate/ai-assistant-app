import { useEffect, useState } from 'react';

import { UI_CONSTANTS } from '@/lib/constants/ui';

/**
 * Returns true when the viewport is narrower than the mobile breakpoint.
 *
 * Viewport-based (not user-agent), so it also covers narrow desktop windows.
 * SSR-safe: renders `false` first, then syncs in an effect to avoid hydration
 * mismatches.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const query = `(max-width: ${UI_CONSTANTS.BREAKPOINTS.MOBILE - 1}px)`;
    const mql = window.matchMedia(query);

    const update = () => setIsMobile(mql.matches);
    update();

    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  return isMobile;
}

export default useIsMobile;

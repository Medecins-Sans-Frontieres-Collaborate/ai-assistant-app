/**
 * The admin-configured per-file upload cap (`feature.upload.megabytesPerFile`,
 * docs/LIMITS.md), shared by every upload entry point that must apply it
 * server-side — the security control, per docs/LIMITS_USER_FACING_UX.md §5.
 *
 * Extracted from `app/api/file/upload/route.ts` (the only caller until now)
 * so `lib/actions/fileUpload.ts`'s Server Action path — the one every file
 * over `SERVER_ACTION_THRESHOLD` takes — can apply the SAME cap instead of
 * only the compiled per-category ceiling. Without this, a
 * `feature.upload.megabytesPerFile` policy below a compiled cap bound only
 * uploads ≤10MB; anything larger silently ignored it.
 */
import { Session } from 'next-auth';

import {
  currentPolicy,
  effectiveCeiling,
} from '@/lib/services/limits/enforcement';
import { buildPrincipal } from '@/lib/services/limits/principal';

/**
 * The effective per-file cap in MB for this caller, or undefined when
 * unlimited. Fails open — an unreadable policy must not block uploads.
 */
export async function resolveEffectiveUploadMegabytes(
  session: Session,
): Promise<number | undefined> {
  try {
    const policy = await currentPolicy();
    if (!policy) return undefined;
    return effectiveCeiling(
      policy,
      buildPrincipal(session),
      'feature.upload.megabytesPerFile',
    );
  } catch {
    return undefined;
  }
}

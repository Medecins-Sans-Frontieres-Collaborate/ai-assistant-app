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
  checkCeiling,
  currentPolicy,
  effectiveCeiling,
} from '@/lib/services/limits/enforcement';
import { buildPrincipal } from '@/lib/services/limits/principal';

const LIMIT_KEY = 'feature.upload.megabytesPerFile';
const MEGABYTE = 1024 * 1024;

/**
 * The effective per-file cap in MB for this caller, or undefined when
 * unlimited or in observe mode (the cap must not bite then). Fails open —
 * an unreadable policy must not block uploads.
 *
 * Pass `sizeBytes` when the file's size is already known: the ceiling check
 * then runs the observe/enforce switch, so observe mode writes its
 * would-block audit line for an over-cap file instead of silently letting
 * it through unrecorded, and enforce mode records the block the size
 * validator is about to apply.
 */
export async function resolveEffectiveUploadMegabytes(
  session: Session,
  sizeBytes?: number,
): Promise<number | undefined> {
  try {
    const policy = await currentPolicy();
    if (!policy) return undefined;
    const principal = buildPrincipal(session);
    if (sizeBytes !== undefined && Number.isFinite(sizeBytes)) {
      checkCeiling(policy, principal, LIMIT_KEY, sizeBytes / MEGABYTE);
    }
    return effectiveCeiling(policy, principal, LIMIT_KEY);
  } catch {
    return undefined;
  }
}

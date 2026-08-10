/**
 * Per-day transcription budget, measured in MINUTES of audio.
 *
 * Duration rather than bytes is the honest unit: a 5-minute lossless file and
 * a 5-minute compressed one cost the same to transcribe but differ wildly in
 * size, so a byte-based cap would meter the wrong thing.
 *
 * Runs on the file already staged for transcription (extracted audio for
 * video), using the existing ffprobe helper — so it costs one probe of a
 * local file, and only for principals who actually have a limit configured.
 */
import { Session } from 'next-auth';

import {
  applyMode,
  currentPolicy,
  meteredCells,
} from '@/lib/services/limits/enforcement';
import { buildPrincipal } from '@/lib/services/limits/principal';
import { reserve } from '@/lib/services/limits/usageStore';

import { getAudioDuration } from '@/lib/utils/server/audio/audioSplitter';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const LIMIT_KEY = 'feature.transcription.minutesPerDay';

export interface TranscriptionGuardResult {
  allowed: boolean;
  /** User-facing reason when denied. */
  message?: string;
}

const ALLOWED: TranscriptionGuardResult = { allowed: true };

export async function guardTranscriptionMinutes(
  session: Session | null | undefined,
  audioPath: string,
): Promise<TranscriptionGuardResult> {
  try {
    const policy = await currentPolicy();
    if (!policy) return ALLOWED;
    const principal = buildPrincipal(session ?? null);
    if (!principal.userId) return ALLOWED;

    const cells = meteredCells(policy, principal, LIMIT_KEY);
    // Unlimited for this caller → no ffprobe, no storage, no cost.
    if (cells.length === 0) return ALLOWED;

    const seconds = await getAudioDuration(audioPath);
    // Rounded UP: a 60-minute limit must not be circumvented by 120 requests
    // of 30 seconds each. A file too short to measure still costs 1 minute.
    const minutes = Math.max(1, Math.ceil(seconds / 60));

    const result = await reserve(
      principal.userId,
      'day',
      cells.map((cell) => ({
        cell: cell.limitKey,
        cost: minutes,
        limit: cell.value as number,
        limitKey: cell.limitKey,
        source: cell.source,
      })),
      {
        timezone: policy.timezone,
        failMode: policy.failMode,
      },
    );
    if (result.allowed || !result.denial) return ALLOWED;

    const decision = applyMode(policy, principal, {
      limitKey: result.denial.limitKey,
      limit: result.denial.limit,
      used: result.denial.used,
      resetAt: result.denial.resetAt,
      source: 'global',
    });
    if (decision.allowed) return ALLOWED;

    const resets = result.denial.resetAt
      ? ` Resets ${new Date(result.denial.resetAt).toUTCString()}.`
      : '';
    return {
      allowed: false,
      message:
        `Daily transcription limit reached (${result.denial.used}/${result.denial.limit} minutes used).` +
        resets,
    };
  } catch (error) {
    // FAIL OPEN — a probe or counter failure must not stop a transcription.
    console.error(
      `[limits] transcription budget FAIL-OPEN: ${sanitizeForLog(error)}`,
    );
    return ALLOWED;
  }
}

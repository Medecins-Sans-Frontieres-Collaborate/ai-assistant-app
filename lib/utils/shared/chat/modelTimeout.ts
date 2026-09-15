/**
 * User-controlled model timeout (GitHub issue #130).
 *
 * The timeout bounds how long the server waits for the MODEL to start
 * responding (time to first byte of the handler's stream). It never applies
 * once bytes are flowing: the chat route and the pipeline race their timers
 * against the handler *returning* a Response, and the body is piped
 * afterwards with no timer at all.
 *
 * Shared between the client (settings store, request body, error card) and
 * the server (request validation, per-request stage timeouts) so the two
 * can never disagree about the bounds. The server clamps whatever the
 * client sends; the bounds here are the only ceiling.
 */

/** Matches the pre-#130 `STAGE_TIMEOUTS.StandardChatHandler` (90 s). */
export const DEFAULT_MODEL_TIMEOUT_SECONDS = 90;
export const MIN_MODEL_TIMEOUT_SECONDS = 30;
/**
 * Hard ceiling. Long silent waits are kept alive by the route's activity
 * heartbeat (see app/api/chat/route.ts), so this is bounded by how long a
 * user can reasonably be asked to watch a loader, not by infrastructure.
 */
export const MAX_MODEL_TIMEOUT_SECONDS = 600;

/** Preset choices offered in Settings; `custom` is anything else. */
export const MODEL_TIMEOUT_PRESETS = [
  { key: 'standard', seconds: DEFAULT_MODEL_TIMEOUT_SECONDS },
  { key: 'patient', seconds: 180 },
  { key: 'maximum', seconds: MAX_MODEL_TIMEOUT_SECONDS },
] as const;

export type ModelTimeoutPresetKey =
  (typeof MODEL_TIMEOUT_PRESETS)[number]['key'];

/**
 * Clamps a persisted/user-typed value into the allowed range in seconds.
 * Non-numeric, non-finite and non-positive input resolve to the default —
 * a hand-edited localStorage value must never disable the timeout.
 */
export function clampModelTimeoutSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MODEL_TIMEOUT_SECONDS;
  return Math.min(
    MAX_MODEL_TIMEOUT_SECONDS,
    Math.max(MIN_MODEL_TIMEOUT_SECONDS, Math.round(n)),
  );
}

/** Same clamp for a millisecond value (the wire unit of `ChatBody.timeoutMs`). */
export function clampModelTimeoutMs(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0)
    return DEFAULT_MODEL_TIMEOUT_SECONDS * 1000;
  return clampModelTimeoutSeconds(n / 1000) * 1000;
}

/**
 * The next timeout to offer after a turn timed out at `current`: doubled,
 * capped at the ceiling. Null when `current` already IS the ceiling — the
 * error card then has no "wait longer" action to offer.
 */
export function escalateModelTimeoutSeconds(current: number): number | null {
  const base = clampModelTimeoutSeconds(current);
  if (base >= MAX_MODEL_TIMEOUT_SECONDS) return null;
  return Math.min(MAX_MODEL_TIMEOUT_SECONDS, base * 2);
}

/** Which preset (if any) a stored value corresponds to. */
export function modelTimeoutPresetFor(
  seconds: number,
): ModelTimeoutPresetKey | 'custom' {
  const match = MODEL_TIMEOUT_PRESETS.find((p) => p.seconds === seconds);
  return match ? match.key : 'custom';
}

/**
 * Error codes the chat route reports when the model did not start in time
 * (`PIPELINE_TIMEOUT` from a handler stage, `REQUEST_TIMEOUT` from the
 * route's whole-request guard). Both mean "waiting longer might help".
 */
export const MODEL_TIMEOUT_ERROR_CODES = [
  'PIPELINE_TIMEOUT',
  'REQUEST_TIMEOUT',
] as const;

export function isModelTimeoutErrorCode(
  code: string | null | undefined,
): boolean {
  return (
    !!code && (MODEL_TIMEOUT_ERROR_CODES as readonly string[]).includes(code)
  );
}

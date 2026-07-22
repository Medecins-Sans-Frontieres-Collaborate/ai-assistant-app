/**
 * Detects local model runtimes listening on loopback.
 *
 * Runs in the BROWSER only — the app is deployed, so a server-side probe
 * would hit the container rather than the user's machine.
 *
 * The two-request design is the point of this module. From a single failed
 * `fetch`, "nothing is listening" and "listening but CORS isn't configured
 * for our origin" are the same opaque `TypeError`. The second is by far the
 * likeliest real-world failure and the one users cannot diagnose alone, so we
 * spend an extra request to name it.
 */
import {
  LOCAL_RUNTIME_DEFAULTS,
  LocalRuntime,
  LocalRuntimeErrorReason,
  LocalRuntimeModel,
  LocalRuntimeStatus,
  buildLocalBaseUrl,
} from '@/types/localRuntime';

/**
 * A closed loopback port refuses instantly, but a *filtered* one (split-tunnel
 * VPN, some endpoint-security agents) hangs indefinitely. Without this the
 * settings pane would spin forever.
 */
const PROBE_TIMEOUT_MS = 2000;

interface OpenAiModelsResponse {
  data?: Array<{ id?: unknown }>;
}

/**
 * Probe A — is anything listening at all?
 *
 * `mode: 'no-cors'` resolves with an opaque response whenever the socket
 * accepts and answers, even with no CORS headers. It rejects on
 * connection-refused. That difference is exactly what separates "not running"
 * from "running but CORS-blocked".
 */
async function isSomethingListening(baseUrl: string): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      mode: 'no-cors',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/** Probe B — will it actually talk to our origin, and what does it serve? */
async function listModels(
  baseUrl: string,
): Promise<
  { ok: true; models: LocalRuntimeModel[] } | { ok: false; status?: number }
> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, status: response.status };

    const body = (await response.json()) as OpenAiModelsResponse;
    const models = (body.data ?? [])
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => ({ id }));
    return { ok: true, models };
  } catch {
    // Either a CORS rejection or a malformed body; both mean "unusable".
    return { ok: false };
  }
}

/**
 * Probes one runtime. Never throws — an undetectable runtime is a normal
 * outcome, not an error, and the chat picker degrades by simply showing
 * nothing.
 */
export async function probeLocalRuntime(
  runtime: LocalRuntime,
  portOverride?: number,
): Promise<LocalRuntimeStatus> {
  const baseUrl = buildLocalBaseUrl(runtime, portOverride);
  const checkedAt = new Date().toISOString();

  const fail = (reason: LocalRuntimeErrorReason): LocalRuntimeStatus => ({
    state: 'error',
    reason,
    checkedAt,
  });

  const corsResult = await listModels(baseUrl);
  if (corsResult.ok) {
    return { state: 'ready', models: corsResult.models, checkedAt };
  }

  // A clean non-2xx means CORS was fine (we could read the status), so the
  // runtime is reachable but unhappy — no need for probe A.
  if (corsResult.status !== undefined) return fail('http_error');

  const listening = await isSomethingListening(baseUrl);
  return fail(listening ? 'cors_blocked' : 'not_running');
}

/**
 * Probes every known runtime concurrently. Results are keyed by runtime so
 * callers can render per-runtime status without re-deriving order.
 */
export async function probeLocalRuntimes(
  runtimes: readonly LocalRuntime[],
  ports: Partial<Record<LocalRuntime, number>> = {},
): Promise<Record<string, LocalRuntimeStatus>> {
  const entries = await Promise.all(
    runtimes.map(
      async (runtime) =>
        [runtime, await probeLocalRuntime(runtime, ports[runtime])] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/** Human-facing runtime label, for status copy. */
export function localRuntimeLabel(runtime: LocalRuntime): string {
  return LOCAL_RUNTIME_DEFAULTS[runtime].label;
}

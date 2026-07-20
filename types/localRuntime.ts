/**
 * Local model runtimes (Ollama, LM Studio, llama.cpp) that a user runs on
 * their own machine.
 *
 * These are reached BROWSER-DIRECT over loopback, never through the Next.js
 * server: the app is deployed, so a server-side fetch to localhost would hit
 * the container rather than the user's machine. That constraint shapes the
 * whole feature — see client/services/chat/LocalChatService.ts.
 *
 * The host is pinned to 127.0.0.1 and is NOT user-editable. Only the port is,
 * so a tampered/persisted value can never steer a request off-loopback.
 */

/** Runtimes we know how to detect and talk to. */
export type LocalRuntime = 'ollama' | 'lmstudio' | 'llamacpp';

export const LOCAL_RUNTIMES: readonly LocalRuntime[] = [
  'ollama',
  'lmstudio',
  'llamacpp',
] as const;

export interface LocalRuntimeDefinition {
  /** Display label. Not localized — these are product names. */
  label: string;
  /** Port the runtime listens on out of the box. */
  defaultPort: number;
  /**
   * Whether we consider this runtime fully supported. llama-server's CORS
   * behavior varies enough between builds and flags that we surface it as
   * experimental rather than over-promising.
   */
  experimental: boolean;
  /**
   * How the user enables cross-origin access for this runtime. Rendered in
   * the settings pane when a probe reports `cors_blocked`, which is the most
   * likely failure and the one users cannot diagnose on their own.
   */
  corsHint: 'ollamaOrigins' | 'lmstudioToggle' | 'llamacppFlag';
}

export const LOCAL_RUNTIME_DEFAULTS: Record<
  LocalRuntime,
  LocalRuntimeDefinition
> = {
  ollama: {
    label: 'Ollama',
    defaultPort: 11434,
    experimental: false,
    corsHint: 'ollamaOrigins',
  },
  lmstudio: {
    label: 'LM Studio',
    defaultPort: 1234,
    experimental: false,
    corsHint: 'lmstudioToggle',
  },
  llamacpp: {
    label: 'llama.cpp',
    defaultPort: 8080,
    experimental: true,
    corsHint: 'llamacppFlag',
  },
};

/**
 * Why a runtime isn't usable. These are distinguishable only because the
 * probe runs two requests (see localRuntimeProbe.ts) — from a single failed
 * fetch, "not running" and "CORS blocked" are the same opaque TypeError.
 */
export type LocalRuntimeErrorReason =
  /**
   * Nothing reachable on the port. Note this also covers "Chrome's Local
   * Network Access permission was denied" — a denied LNA request and a
   * refused connection are the same opaque TypeError from JS, so we cannot
   * honestly distinguish them. User-facing copy for this reason must mention
   * both causes.
   */
  | 'not_running'
  /** Something is listening, but it won't send CORS headers for our origin. */
  | 'cors_blocked'
  /** Reachable, but the requested model is no longer loaded. */
  | 'model_missing'
  /** Reachable and CORS-clean, but returned a non-2xx. */
  | 'http_error';

/** A model name as reported by a runtime's `GET /v1/models`. */
export interface LocalRuntimeModel {
  /** Raw id, e.g. "llama3.1:8b" or "hf.co/user/repo:Q4_K_M". */
  id: string;
}

export type LocalRuntimeStatus =
  | { state: 'unknown' }
  | { state: 'checking' }
  | { state: 'ready'; models: LocalRuntimeModel[]; checkedAt: string }
  | { state: 'error'; reason: LocalRuntimeErrorReason; checkedAt: string };

/** Ports outside this range can't be dialled; used to validate persisted state. */
export function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

/**
 * Base URL for a runtime's OpenAI-compatible API.
 *
 * Deliberately 127.0.0.1 rather than "localhost": localhost may resolve to
 * ::1 first, and Ollama binds IPv4 by default — a real and confusing class of
 * "works on my machine" failures.
 */
export function buildLocalBaseUrl(
  runtime: LocalRuntime,
  portOverride?: number,
): string {
  const port = isValidPort(portOverride)
    ? portOverride
    : LOCAL_RUNTIME_DEFAULTS[runtime].defaultPort;
  return `http://127.0.0.1:${port}`;
}

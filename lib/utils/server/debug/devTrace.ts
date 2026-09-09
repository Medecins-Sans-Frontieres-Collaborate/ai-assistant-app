import { appendFile, stat } from 'fs/promises';

/**
 * TEMPORARY dev-only diagnostics — DELETE before merge.
 *
 * Appends NDJSON events to a fixed /tmp file so pipeline decisions can be
 * inspected from disk after a manual test, without relying on the IDE
 * console. Fire-and-forget: tracing must never affect the request.
 *
 * Guards (defense in depth for a tool that must never reach beta/live):
 * - STRICT env gate: only NODE_ENV === 'development' writes. Production
 *   builds no-op, and so do vitest runs (NODE_ENV === 'test'), which used
 *   to pollute the trace with mock noise.
 * - Hard size cap: the file never grows past MAX_TRACE_BYTES per process
 *   lifetime (seeded from the existing file size, so restarts don't reset
 *   the budget). One terminal "trace-capped" line marks the cutoff.
 */
const TRACE_FILE = '/tmp/ai-assistant-dev-trace.ndjson';
const MAX_TRACE_BYTES = 5 * 1024 * 1024;

let bytesWritten: number | null = null;
let seeding: Promise<void> | null = null;
let capped = false;

async function seedBytesWritten(): Promise<void> {
  try {
    bytesWritten = (await stat(TRACE_FILE)).size;
  } catch {
    bytesWritten = 0;
  }
}

export function devTrace(event: string, data: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== 'development' || capped) return;

  let line: string;
  try {
    line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`;
  } catch {
    // Unserializable payload — diagnostics only, drop it.
    return;
  }

  void (async () => {
    if (bytesWritten === null) {
      seeding ??= seedBytesWritten();
      await seeding;
    }
    if ((bytesWritten ?? 0) >= MAX_TRACE_BYTES) {
      if (!capped) {
        capped = true;
        await appendFile(
          TRACE_FILE,
          `${JSON.stringify({ ts: new Date().toISOString(), event: 'trace-capped', maxBytes: MAX_TRACE_BYTES })}\n`,
        );
      }
      return;
    }
    bytesWritten = (bytesWritten ?? 0) + Buffer.byteLength(line);
    await appendFile(TRACE_FILE, line);
  })().catch(() => {
    // Diagnostics only — never let tracing break a chat turn.
  });
}

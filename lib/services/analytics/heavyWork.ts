/**
 * One heavy file operation at a time per replica. Server-only.
 *
 * Opening the largest example workbook in full costs ~500 MB resident for a
 * couple of seconds. The background validator and the export route both do
 * that kind of work; two at once on a replica that is also serving chat is
 * the failure this prevents.
 */

/** An export arrived while too many were already waiting. */
export class AnalyticsBusyError extends Error {
  constructor() {
    super('Too many exports are in progress; try again shortly');
    this.name = 'AnalyticsBusyError';
  }
}

/** Exports allowed to wait behind the one that is running. */
const MAX_WAITING = 3;

let tail: Promise<unknown> = Promise.resolve();
let waiting = 0;

/**
 * Runs `work` after everything queued before it. `shed` is for user-facing
 * requests: rather than join a long queue, they are refused.
 */
export async function runHeavy<T>(
  work: () => Promise<T>,
  options: { shed?: boolean } = {},
): Promise<T> {
  if (options.shed && waiting >= MAX_WAITING) throw new AnalyticsBusyError();
  waiting += 1;
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous.catch(() => undefined);
    return await work();
  } finally {
    waiting -= 1;
    release();
  }
}

/** Test hook. */
export function __resetHeavyWorkForTests(): void {
  tail = Promise.resolve();
  waiting = 0;
}

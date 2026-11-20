/**
 * The queue every LibreOffice job waits in (see the render service).
 *
 * LANES: `interactive` is work a person is waiting on in a chat (reading an
 * attachment, a file preview); `background` is work that already tells the
 * person it takes a while (document translation, brand review, building a
 * deck). Interactive jobs go first, but after `interactiveBurst` of them in
 * a row a waiting background job takes the next slot, so background work
 * never starves.
 *
 * A queued job is a closure and a few numbers: it holds no file bytes, so
 * the queue can be long. Past `maxQueued` waiting jobs, new work is refused
 * (RenderBusyError) rather than queued.
 */

/** Which line a job waits in; see LANES above. */
export type RenderLane = 'interactive' | 'background';

export const RENDER_LANES: readonly RenderLane[] = [
  'interactive',
  'background',
] as const;

export interface RenderQueueOptions {
  /** Jobs running at once. At least 1. */
  maxConcurrent: number;
  /** Jobs waiting at once, both lanes together, before work is refused. */
  maxQueued: number;
  /** Interactive jobs run in a row while background work waits. At least 1. */
  interactiveBurst: number;
  /** Told when a job starts and ends, for metrics. */
  observer?: RenderQueueObserver;
}

/** What the queue reports about each job, for metrics and logs. */
export interface RenderQueueObserver {
  onRefused?(lane: RenderLane): void;
  onStart?(lane: RenderLane, waitedMs: number): void;
  onFinish?(
    lane: RenderLane,
    ranMs: number,
    outcome: 'ok' | 'error' | 'aborted',
  ): void;
}

/** Per-job options. */
export interface RenderQueueRunOptions {
  /** Aborting removes a waiting job, or is passed to a running one. */
  signal?: AbortSignal;
  /**
   * Told how many jobs are ahead whenever that changes while waiting, and
   * 0 when the job starts. An estimate: interactive work arriving later can
   * still go first, within the burst limit.
   */
  onPosition?: (ahead: number) => void;
}

/** Raised when the queue is full; nothing was started. */
export class RenderBusyError extends Error {
  readonly code = 'RENDER_BUSY';
  constructor(readonly queued: number) {
    super(
      `The document converter is busy (${queued} jobs waiting). Try again shortly.`,
    );
    this.name = 'RenderBusyError';
  }
}

interface Waiting {
  lane: RenderLane;
  enqueuedAt: number;
  start: () => void;
  abort: (reason: unknown) => void;
  onPosition?: (ahead: number) => void;
  lastReported?: number;
}

/**
 * A bounded two-lane queue. `run` resolves with the task's result once the
 * task has had its turn and finished.
 *
 * @example
 * const queue = new RenderQueue({ maxConcurrent: 1, maxQueued: 50, interactiveBurst: 3 });
 * const pdf = await queue.run('interactive', (signal) => convert(file, signal));
 */
export class RenderQueue {
  private readonly waiting: Record<RenderLane, Waiting[]> = {
    interactive: [],
    background: [],
  };
  private running = 0;
  private interactiveStreak = 0;
  private readonly options: RenderQueueOptions;

  constructor(options: RenderQueueOptions) {
    if (!(options.maxConcurrent >= 1)) {
      throw new Error('RenderQueue: maxConcurrent must be at least 1');
    }
    if (!(options.interactiveBurst >= 1)) {
      throw new Error('RenderQueue: interactiveBurst must be at least 1');
    }
    if (!(options.maxQueued >= 0)) {
      throw new Error('RenderQueue: maxQueued must not be negative');
    }
    this.options = options;
  }

  /** Jobs running and waiting, by lane. */
  snapshot(): { running: number; queued: Record<RenderLane, number> } {
    return {
      running: this.running,
      queued: {
        interactive: this.waiting.interactive.length,
        background: this.waiting.background.length,
      },
    };
  }

  /**
   * Runs `task` when a slot is free.
   *
   * @param lane - Which line to wait in.
   * @param task - The work; receives the job's abort signal.
   * @param options - Abort signal and position updates.
   * @returns What the task returns.
   * @throws RenderBusyError when the queue is full (the task never runs).
   * @throws The signal's reason when aborted while waiting.
   * @throws Whatever the task throws.
   */
  run<T>(
    lane: RenderLane,
    task: (signal?: AbortSignal) => Promise<T>,
    options: RenderQueueRunOptions = {},
  ): Promise<T> {
    const { signal, onPosition } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        this.running += 1;
        const startedAt = Date.now();
        onPosition?.(0);
        let outcome: 'ok' | 'error' | 'aborted' = 'ok';
        task(signal)
          .then(resolve, (error) => {
            outcome = signal?.aborted ? 'aborted' : 'error';
            reject(error);
          })
          .finally(() => {
            this.running -= 1;
            this.options.observer?.onFinish?.(
              lane,
              Date.now() - startedAt,
              outcome,
            );
            this.pump();
          });
      };

      if (
        this.running < this.options.maxConcurrent &&
        this.queuedCount() === 0
      ) {
        this.noteChosen(lane);
        this.options.observer?.onStart?.(lane, 0);
        execute();
        return;
      }
      if (this.queuedCount() >= this.options.maxQueued) {
        this.options.observer?.onRefused?.(lane);
        reject(new RenderBusyError(this.queuedCount()));
        return;
      }

      const entry: Waiting = {
        lane,
        enqueuedAt: Date.now(),
        onPosition,
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          this.options.observer?.onStart?.(lane, Date.now() - entry.enqueuedAt);
          execute();
        },
        abort: reject,
      };
      const onAbort = () => {
        const line = this.waiting[lane];
        const at = line.indexOf(entry);
        if (at >= 0) line.splice(at, 1);
        reject(signal?.reason);
        this.reportPositions();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting[lane].push(entry);
      this.reportPositions();
      this.pump();
    });
  }

  private queuedCount(): number {
    return this.waiting.interactive.length + this.waiting.background.length;
  }

  /** Records which lane got a slot, for the burst limit. */
  private noteChosen(lane: RenderLane): void {
    this.interactiveStreak =
      lane === 'interactive' ? this.interactiveStreak + 1 : 0;
  }

  /** The lane whose next job runs next; null when nothing waits. */
  private nextLane(): RenderLane | null {
    const interactive = this.waiting.interactive.length > 0;
    const background = this.waiting.background.length > 0;
    if (
      interactive &&
      (!background || this.interactiveStreak < this.options.interactiveBurst)
    ) {
      return 'interactive';
    }
    if (background) return 'background';
    return null;
  }

  /** Starts waiting jobs while slots are free. */
  private pump(): void {
    while (this.running < this.options.maxConcurrent) {
      const lane = this.nextLane();
      if (!lane) break;
      const entry = this.waiting[lane].shift()!;
      this.noteChosen(lane);
      entry.start();
    }
    this.reportPositions();
  }

  /**
   * Tells each waiting job how many are ahead of it: those before it in
   * its lane and, for background work, every interactive job waiting.
   */
  private reportPositions(): void {
    for (const lane of RENDER_LANES) {
      this.waiting[lane].forEach((entry, index) => {
        const ahead =
          index +
          this.running +
          (lane === 'background' ? this.waiting.interactive.length : 0);
        if (entry.lastReported !== ahead) {
          entry.lastReported = ahead;
          entry.onPosition?.(ahead);
        }
      });
    }
  }
}

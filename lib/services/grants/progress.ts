/**
 * Structured progress emission for the grant extraction pipeline.
 *
 * Writes an atomic JSON snapshot to disk on each update.
 */
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const STAGES: [string, number][] = [
  ['extract_text', 15],
  ['extract_fields', 40],
  ['normalize', 10],
  ['enrich', 10],
  ['validate', 10],
  ['build_output', 15],
];

const NAME_TO_INDEX: Record<string, number> = {};
const NAME_TO_WEIGHT: Record<string, number> = {};
let TOTAL_WEIGHT = 0;

for (let i = 0; i < STAGES.length; i++) {
  const [name, weight] = STAGES[i];
  NAME_TO_INDEX[name] = i + 1;
  NAME_TO_WEIGHT[name] = weight;
  TOTAL_WEIGHT += weight;
}

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface ProgressState {
  run_id: string;
  status: string;
  started_at: string;
  updated_at: string;
  stage: number;
  stage_name: string;
  stage_progress: number;
  stage_total: number;
  overall_percent: number;
  error: string | null;
}

export class ProgressEmitter {
  private path: string | null;
  private runId: string;
  private verbose: boolean;
  private state: ProgressState;
  private completedWeight: number = 0;

  constructor(path: string | null, runId: string, verbose: boolean = true) {
    this.path = path;
    this.runId = runId;
    this.verbose = verbose;
    this.state = {
      run_id: runId,
      status: 'running',
      started_at: nowISO(),
      updated_at: nowISO(),
      stage: 0,
      stage_name: 'init',
      stage_progress: 0,
      stage_total: 0,
      overall_percent: 0,
      error: null,
    };
  }

  stageStart(name: string, total: number): void {
    this.state.stage = NAME_TO_INDEX[name] ?? this.state.stage;
    this.state.stage_name = name;
    this.state.stage_progress = 0;
    this.state.stage_total = total;
    this.updatePercent();
    this.flush();
    if (this.verbose) {
      console.log(
        `\n========== Stage ${this.state.stage}: ${name} (${total} items) ==========`,
      );
    }
  }

  tick(completed: number, total?: number): void {
    this.state.stage_progress = completed;
    if (total !== undefined) this.state.stage_total = total;
    this.updatePercent();
    this.flush();
  }

  stageDone(name: string): void {
    this.completedWeight += NAME_TO_WEIGHT[name] ?? 0;
    this.state.stage_progress = this.state.stage_total;
    this.updatePercent();
    this.flush();
    if (this.verbose) {
      console.log(`========== Stage ${name}: done ==========`);
    }
  }

  finish(status: string = 'succeeded', error?: string): void {
    this.state.status = status;
    this.state.error = error || null;
    this.state.overall_percent =
      status === 'succeeded' ? 100 : this.state.overall_percent;
    this.flush();
  }

  private updatePercent(): void {
    let inProgress = 0;
    if (this.state.stage_total > 0) {
      inProgress =
        (this.state.stage_progress / this.state.stage_total) *
        (NAME_TO_WEIGHT[this.state.stage_name] ?? 0);
    }
    this.state.overall_percent = Math.round(
      ((this.completedWeight + inProgress) * 100) / TOTAL_WEIGHT,
    );
    this.state.updated_at = nowISO();
  }

  private flush(): void {
    if (!this.path) return;
    try {
      const dir = dirname(this.path);
      mkdirSync(dir, { recursive: true });
      const tmpPath = join(
        dir,
        `.progress-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
      renameSync(tmpPath, this.path);
    } catch (e) {
      console.error(`[progress] flush failed: ${e}`);
    }
  }
}

/** No-op progress emitter for revalidation. */
export class NoopProgress {
  stageStart(_name: string, _total: number = 0): void {}
  stageDone(_name: string): void {}
  tick(_current: number, _total?: number): void {}
  finish(_status: string = 'succeeded', _error?: string): void {}
}

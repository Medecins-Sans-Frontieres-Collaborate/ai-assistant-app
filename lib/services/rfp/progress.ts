/**
 * Structured progress emission for the RFP scorecard pipeline.
 *
 * Writes an atomic JSON snapshot to disk on each update. Same schema and
 * polling contract as the grants pipeline emitter — the progress API route
 * and frontend read this file unchanged from the Python era.
 */
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const STAGES: [string, number][] = [
  ['extract_pdfs', 5],
  ['extract_responses', 30],
  ['generate_rubrics', 25],
  ['score_vendors', 30],
  ['build_scorecard', 10],
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
  private verbose: boolean;
  private state: ProgressState;
  private completedWeight = 0;

  constructor(path: string | null, runId: string, verbose = true) {
    this.path = path;
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

  /** On resume, credit the weight of stages that already completed so the
   * progress bar doesn't reset to 0%. */
  markStagesComplete(names: string[]): void {
    for (const n of names) this.completedWeight += NAME_TO_WEIGHT[n] ?? 0;
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
    if (this.verbose) console.log(`========== Stage ${name}: done ==========`);
  }

  finish(status = 'succeeded', error?: string): void {
    this.state.status = status;
    this.state.error = error || null;
    if (status === 'succeeded') this.state.overall_percent = 100;
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
      mkdirSync(dir, { recursive: true, mode: 0o700 });
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

/**
 * Per-process singleton serving the workflow enable/disable policy.
 *
 * Caching contract mirrors LimitsService: `await ensureFresh()` (no-op while
 * the 60s TTL is warm), then read `isEnabled(type)` synchronously. Single-
 * flight refresh, epoch guard so an `invalidate()` landing mid-refresh is
 * not lost, 5s failure cooldown, last-known-good retention.
 *
 * Failure posture is decided by the per-workflow DEFAULTS in types.ts, not
 * here: with no snapshot at all, `isEnabled` answers from the defaults —
 * closed for grants, open for the general workflows. There is no separate
 * fail-mode knob; a kill switch that fails open for the restricted workflow
 * would not be a kill switch.
 */
import {
  WorkflowPolicy,
  resolveAllWorkflowsEnabled,
  resolveWorkflowEnabled,
} from '@/lib/services/workflows/policy/types';
import {
  createWorkflowPolicyBlobStorage,
  readWorkflowPolicy,
} from '@/lib/services/workflows/policy/workflowPolicyStore';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { ConversationWorkflowType } from '@/types/workflow';

const POLICY_CACHE_TTL_MS = 60_000;
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;

export interface WorkflowPolicySnapshot {
  policy: WorkflowPolicy | null;
  etag: string | null;
  /**
   * No policy has ever loaded on this replica (cold start + storage outage).
   * Distinct from `policy: null` with `policyUnavailable: false` ("nobody
   * has authored a policy yet, defaults apply").
   */
  policyUnavailable: boolean;
  fetchedAt: number | null;
}

export class WorkflowPolicyService {
  private static instance: WorkflowPolicyService | null = null;

  private storage: BlobStorage | null = null;
  private policy: WorkflowPolicy | null = null;
  private etag: string | null = null;
  private loadedOnce = false;
  private fetchedAt = 0;
  private epoch = 0;
  private lastRefreshFailureAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  static getInstance(): WorkflowPolicyService {
    if (!WorkflowPolicyService.instance) {
      WorkflowPolicyService.instance = new WorkflowPolicyService();
    }
    return WorkflowPolicyService.instance;
  }

  /** Test seam only. */
  static resetInstance(): void {
    WorkflowPolicyService.instance = null;
  }

  async ensureFresh(): Promise<void> {
    if (this.loadedOnce && Date.now() - this.fetchedAt < POLICY_CACHE_TTL_MS) {
      return;
    }
    if (
      this.loadedOnce &&
      this.lastRefreshFailureAt !== 0 &&
      Date.now() - this.lastRefreshFailureAt < REFRESH_FAILURE_COOLDOWN_MS
    ) {
      return;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
  }

  invalidate(): void {
    this.epoch += 1;
    this.fetchedAt = 0;
    this.lastRefreshFailureAt = 0;
  }

  getSnapshot(): WorkflowPolicySnapshot {
    return {
      policy: this.policy,
      etag: this.etag,
      policyUnavailable: !this.loadedOnce,
      fetchedAt: this.loadedOnce ? this.fetchedAt : null,
    };
  }

  /** Effective state over the current snapshot (defaults when none). */
  isEnabled(type: ConversationWorkflowType): boolean {
    return resolveWorkflowEnabled(this.policy, type);
  }

  allEnabled(): Record<ConversationWorkflowType, boolean> {
    return resolveAllWorkflowsEnabled(this.policy);
  }

  private getStorage(): BlobStorage {
    if (!this.storage) {
      this.storage = createWorkflowPolicyBlobStorage();
    }
    return this.storage;
  }

  private async refresh(): Promise<void> {
    const epochAtEntry = this.epoch;
    try {
      const result = await readWorkflowPolicy(this.getStorage());
      if (epochAtEntry !== this.epoch) return;
      this.policy = result?.policy ?? null;
      this.etag = result?.etag ?? null;
      this.loadedOnce = true;
      this.fetchedAt = Date.now();
      this.lastRefreshFailureAt = 0;
    } catch (error) {
      this.lastRefreshFailureAt = Date.now();
      console.error(
        `[workflows-policy] refresh failed (serving ${this.loadedOnce ? 'last-known-good' : 'defaults'}): ${sanitizeForLog(error)}`,
      );
    }
  }
}

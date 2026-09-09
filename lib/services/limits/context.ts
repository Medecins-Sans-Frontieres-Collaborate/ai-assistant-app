/**
 * The resolved-limits bundle carried on ChatContext.
 *
 * Declared in its own module (rather than on ChatContext) so enforcement
 * points outside the chat pipeline — the TTS route, the upload route, the MCP
 * tool loop — can consume the same shape without importing the whole chat
 * pipeline.
 */
import { Principal } from '@/lib/services/limits/principal';
import { LimitsPolicy } from '@/lib/services/limits/types';

export interface ChatLimits {
  /** The policy snapshot this request was decided against. */
  policy: LimitsPolicy | null;
  principal: Principal;
  /**
   * Effective per-request ceilings that call sites CLAMP to rather than
   * reject on (tool-loop rounds, upload size). Absent key = unlimited.
   */
  ceilings: Record<string, number>;
  /**
   * Fallback-chain models this caller may not use, precomputed so the
   * DeploymentNotFound fallback cannot route around a per-user model
   * restriction. Pure resolution, no I/O.
   */
  blockedModelIds: string[];
  /**
   * True when this request is exempt from model/family counting because it
   * runs against the user's own model account (`byom-`) and the policy does
   * not count that usage.
   */
  byomExempt?: boolean;
}

/**
 * How one KIND of spec plugs into the drafter core.
 *
 * The core never imports an adapter; adapters are composed in
 * `lib/utils/shared/drafter/adapters.ts`. That direction is enforced by an
 * ESLint `no-restricted-imports` rule, which is the test of the seam.
 */
import { DeterministicCheck } from '@/lib/utils/shared/review/deterministicChecks';

import { VersionSpec } from '@/types/drafter';
import { ConversationWorkflowType } from '@/types/workflow';

import { VersionCheckCtx } from './checks';
import { LinkPolicy } from './links';
import { OverflowOptions } from './segments';

export interface SpecAdapter<S extends VersionSpec = VersionSpec> {
  kind: S['kind'];
  /** The conversationType whose admin policy guards this kind's routes. */
  workflow: ConversationWorkflowType;
  /** Resolves a spec id server-side; request bodies never carry specs. */
  resolveSpec(id: string): S | undefined;
  listSpecs(): ReadonlyArray<S>;
  /** Structural rules for the model, in prose, built from the spec. */
  promptBlock(spec: S): string;
  /**
   * Where this kind carries links and what one costs against its limit.
   * Absent = the default: allowed, in the last segment, at full length.
   */
  linkPolicy?(spec: S): LinkPolicy;
  /**
   * What `text` costs against this spec's limit, counted the way the target
   * counts (a Japanese quotation costs double on X). Absent = its length.
   */
  cost?(spec: S, text: string): number;
  /**
   * How a version of this spec may be made to fit by MOVING text between
   * segments. Absent, or null for a spec with a single segment = it cannot,
   * and only rewording helps.
   */
  fitOptions?(spec: S): OverflowOptions | null;
  /** Checks added to the core's for this kind. */
  checks(spec: S): ReadonlyArray<DeterministicCheck<VersionCheckCtx<S>>>;
}

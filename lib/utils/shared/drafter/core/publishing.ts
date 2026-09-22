/**
 * The publish gate. Copy is never blocked; PUBLISH is. Sending a post out
 * under the organisation's name is the one action here that cannot be taken
 * back, so every condition is checked by code and the first unmet one is
 * stated in words.
 *
 * Pure and kind-agnostic. It is evaluated in the browser to explain the
 * button, and AGAIN on the server from the request's own data before
 * anything is sent: the client's answer is never trusted.
 */
import {
  CheckFinding,
  blockingCount,
} from '@/lib/utils/shared/review/deterministicChecks';

import { Brief, Version } from '@/types/drafter';

import { groundVersion } from './grounding';
import { pendingEdits } from './revisions';
import { approvalStatus, hasText, isStale } from './versions';

/** Why a version may not be published yet, worst first. */
export type PublishBlocker =
  | 'empty'
  | 'to-fix'
  | 'suggestions-pending'
  | 'proposal-pending'
  | 'brief-changed'
  | 'uses-excluded-item'
  | 'uses-vouched-item'
  | 'not-approved'
  | 'approval-lapsed';

export interface PublishPolicy {
  /** Whether a post resting on a vouched (unsourced) item may go out. */
  allowVouched: boolean;
}

export const DEFAULT_PUBLISH_POLICY: PublishPolicy = { allowVouched: false };

/**
 * Every reason this version may not be published. Empty = it may.
 *
 * Approval is deliberately LAST: it is the human's statement that the text
 * is final, and asking for it while a check is still open would invite
 * approving something that then has to change.
 */
export function publishBlockers(
  version: Version | undefined,
  brief: Brief,
  findings: CheckFinding[],
  policy: PublishPolicy = DEFAULT_PUBLISH_POLICY,
): PublishBlocker[] {
  if (!version || !hasText(version)) return ['empty'];
  const blockers: PublishBlocker[] = [];
  if (blockingCount(findings) > 0) blockers.push('to-fix');
  if (pendingEdits(version).length > 0) blockers.push('suggestions-pending');
  if (version.proposed) blockers.push('proposal-pending');
  else if (isStale(version, brief)) blockers.push('brief-changed');

  // What the text actually rests on is decided by the grounding marks, not
  // by the ids reported at generation: those go stale as the user edits.
  const itemsById = new Map(brief.items.map((item) => [item.id, item]));
  const used = new Set(
    groundVersion(version.segments, brief)
      .map((mark) => mark.itemId)
      .filter((id): id is string => !!id),
  );
  for (const id of version.segments.flatMap((s) => s.usedItemIds)) used.add(id);
  let excluded = false;
  let vouched = false;
  for (const id of used) {
    const item = itemsById.get(id);
    if (!item) continue;
    if (item.decision !== 'included') excluded = true;
    if (item.verified === 'user-asserted') vouched = true;
  }
  if (excluded) blockers.push('uses-excluded-item');
  if (vouched && !policy.allowVouched) blockers.push('uses-vouched-item');

  const approval = approvalStatus(version);
  if (approval === 'none') blockers.push('not-approved');
  if (approval === 'changed') blockers.push('approval-lapsed');
  return blockers;
}

export function canPublish(
  version: Version | undefined,
  brief: Brief,
  findings: CheckFinding[],
  policy?: PublishPolicy,
): boolean {
  return publishBlockers(version, brief, findings, policy).length === 0;
}

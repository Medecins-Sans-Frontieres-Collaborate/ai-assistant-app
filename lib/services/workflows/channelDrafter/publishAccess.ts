/**
 * Who may publish to a channel. DEFAULT DENY, on purpose the opposite of
 * every other access check in this app.
 *
 * The access engine is a deny-list: with no rule, or with the subsystem off,
 * it answers "allow". For drafting that is right. For publishing it would
 * mean that deploying the feature grants it to everyone, so here those two
 * answers are read as "nobody". Only a rule an admin actually wrote can
 * grant, and an undecidable answer (a Graph blip) grants nothing.
 *
 * A rule for the specific channel decides alone when one exists; otherwise
 * the "all channels" rule does; otherwise nobody may publish.
 */
import {
  PUBLISH_ALL_CHANNELS,
  PUBLISH_SOURCE,
} from '@/lib/services/agentAccess/types';

interface Decision {
  decision: string;
  reason: string;
}

export type EvaluateAccess = (input: {
  userMail: string | undefined;
  source: string;
  agentName: string;
}) => Decision;

/** The reasons that mean "an admin's rule grants this user". */
const GRANTING_REASONS = new Set([
  'public',
  'allow-user',
  'allow-domain',
  'allow-group',
]);

/** Answers that mean no rule was consulted at all. */
const NO_RULE_REASONS = new Set(['no-rule', 'feature-disabled']);

export interface PublishAccess {
  allowed: boolean;
  /** Machine-readable, for the audit line; never shown as a permission hint. */
  reason: string;
}

function granted(decision: Decision): boolean {
  return decision.decision === 'allow' && GRANTING_REASONS.has(decision.reason);
}

export function evaluatePublishAccess(
  evaluate: EvaluateAccess,
  userMail: string | undefined,
  channelId: string,
): PublishAccess {
  const specific = evaluate({
    userMail,
    source: PUBLISH_SOURCE,
    agentName: channelId,
  });
  if (!NO_RULE_REASONS.has(specific.reason)) {
    return { allowed: granted(specific), reason: `channel:${specific.reason}` };
  }
  if (specific.reason === 'feature-disabled') {
    return { allowed: false, reason: 'feature-disabled' };
  }
  const all = evaluate({
    userMail,
    source: PUBLISH_SOURCE,
    agentName: PUBLISH_ALL_CHANNELS,
  });
  if (NO_RULE_REASONS.has(all.reason)) {
    return { allowed: false, reason: 'no-grant' };
  }
  return { allowed: granted(all), reason: `all:${all.reason}` };
}

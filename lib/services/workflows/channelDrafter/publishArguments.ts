/**
 * The arguments of the one tool call that sends a post. Pure, so what goes
 * over the wire is tested without a connection: exactly the configured
 * fixed arguments, the text under the configured name, and the channel's
 * own Hootsuite profile when the tool takes one. Nothing else.
 */
import { ChannelProfile } from '@/types/drafter';

import { HootsuitePublishingConfig } from '@/config/publishing';

export type PublishArguments =
  | { ok: true; arguments: Record<string, unknown> }
  | { ok: false; reason: 'no-target' };

export function buildPublishArguments(
  config: HootsuitePublishingConfig,
  text: string,
  profile: Pick<ChannelProfile, 'publishTarget'>,
): PublishArguments {
  const args: Record<string, unknown> = { ...config.fixedArguments };
  const targetArgument = config.targetArgument.trim();
  if (targetArgument) {
    const target = profile.publishTarget?.trim();
    if (!target) return { ok: false, reason: 'no-target' };
    args[targetArgument] = config.targetIsList ? [target] : target;
  }
  // Last, so a fixed argument can never stand in for the approved text.
  args[config.textArgument.trim()] = text;
  return { ok: true, arguments: args };
}

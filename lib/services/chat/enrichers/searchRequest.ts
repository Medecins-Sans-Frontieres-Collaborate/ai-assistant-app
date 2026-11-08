import { peekOrgAgentById } from '@/lib/services/orgAgents/orgAgentRegistry';

import { SearchMode } from '@/types/searchMode';

import type { ChatContext } from '../pipeline/ChatContext';

/**
 * Whether web search is requested for this turn: search mode is auto or
 * forced, and an org agent (if any) allows it. Prompt and M365 agents ride
 * the standard path and follow the mode alone.
 *
 * Shared by the tool router (which acts on it) and the turn budget (which
 * sizes timers for it), so the two can never disagree.
 *
 * @param context - The turn (only searchMode, botId and agent fields are read).
 * @returns True when a web search may run this turn.
 */
export function searchRequested(
  context: Pick<
    ChatContext,
    'searchMode' | 'botId' | 'promptAgent' | 'm365Agent'
  >,
): boolean {
  const modeActive =
    context.searchMode === SearchMode.INTELLIGENT ||
    context.searchMode === SearchMode.ALWAYS;
  if (!modeActive) return false;
  if (context.botId && !context.promptAgent && !context.m365Agent) {
    // Sync snapshot peek (shouldRun cannot await): admin records win over
    // the static config; a cold snapshot denies — fail closed.
    const agent = peekOrgAgentById(context.botId);
    return !!agent?.allowWebSearch;
  }
  return true;
}

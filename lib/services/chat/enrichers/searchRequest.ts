import { peekOrgAgentById } from '@/lib/services/orgAgents/orgAgentRegistry';

import { SearchMode } from '@/types/searchMode';

import type { ChatContext } from '../pipeline/ChatContext';

/**
 * Whether web search is requested for this turn: search mode is auto or
 * forced, AND the agent answering the turn (if any) allows it. The agent's
 * setting is a hard gate — neither the user's search mode nor the agent's
 * instructions can open it:
 * - M365 agents search only when their owner opted in (off by default, so
 *   answers stay within the agent's documents);
 * - prompt agents search unless their owner opted out;
 * - org agents search only when their record allows it.
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
  if (context.m365Agent) return context.m365Agent.allowWebSearch === true;
  if (context.promptAgent) return context.promptAgent.allowWebSearch !== false;
  if (context.botId) {
    // Sync snapshot peek (shouldRun cannot await): admin records win over
    // the static config; a cold snapshot denies — fail closed.
    const agent = peekOrgAgentById(context.botId);
    return !!agent?.allowWebSearch;
  }
  return true;
}

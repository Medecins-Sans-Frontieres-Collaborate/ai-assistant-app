/**
 * Whether a turn can/should run the native code interpreter. Shared by
 * ToolRouterEnricher (which dispatches it) and SkillEnricher (which must not
 * displace a native interpreter turn with the skill tool loop —
 * docs/SKILLS_DESIGN.md §5.6). Kept dependency-light on purpose.
 */
import { peekOrgAgentById } from '@/lib/services/orgAgents/orgAgentRegistry';

import { InterpreterMode } from '@/types/interpreterMode';

import type { ChatContext } from '../pipeline/ChatContext';

import { env } from '@/config/environment';

/**
 * Whether the PICKED model can run code_interpreter natively in-turn on
 * the Responses path (Phase 2). MCP turns are excluded — they execute on
 * chat.completions, which has no server-side tools — and fall back to the
 * sub-tool round-trip like any other incapable configuration. Exported so
 * the skills pipeline can avoid displacing a native interpreter turn
 * (docs/SKILLS_DESIGN.md §5.6).
 */
export function nativeInterpreterCapable(context: ChatContext): boolean {
  return (
    context.model?.supportsCodeInterpreter === true &&
    context.model?.supportsResponsesApi === true &&
    context.model?.sdk === 'azure-openai' &&
    // Persona skill loops run on chat.completions. Preserve interpreter
    // functionality via the existing bounded pre-turn sub-tool path.
    !context.agentSkillsEnabled &&
    !context.model?.isCustomSourceModel &&
    // Only REAL (network) MCP servers force the chat.completions loop —
    // the builtin M365 toolset must not disable the native interpreter.
    !context.mcpServers?.some((entry) => !entry.builtin)
  );
}

/**
 * Whether code execution is requested for this turn (env kill switch +
 * mode + org-agent gate).
 */
export function interpreterRequested(context: ChatContext): boolean {
  if (!env.CODE_INTERPRETER_ENABLED) return false;
  const modeActive =
    context.interpreterMode === InterpreterMode.INTELLIGENT ||
    context.interpreterMode === InterpreterMode.ALWAYS;
  if (!modeActive) return false;
  if (context.botId && !context.promptAgent && !context.m365Agent) {
    // Same sync snapshot peek as searchRequested (fail closed when cold).
    const agent = peekOrgAgentById(context.botId);
    return !!agent?.allowCodeInterpreter;
  }
  return true;
}

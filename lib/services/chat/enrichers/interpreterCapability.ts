/**
 * Whether a turn can/should run the native code interpreter. Shared by
 * ToolRouterEnricher (which dispatches it) and SkillEnricher (which must not
 * displace a native interpreter turn with the skill tool loop —
 * docs/SKILLS_DESIGN.md §5.6). Kept dependency-light on purpose.
 */
import { peekOrgAgentById } from '@/lib/services/orgAgents/orgAgentRegistry';

import {
  NATIVE_INTERPRETER_PLANNED_MODEL_CALLS,
  perCallTokensPerMinute,
} from '@/lib/utils/shared/modelThroughput';

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

/**
 * System-prompt notice for a turn whose model was told it can generate
 * files (CODE_INTERPRETER_PROMPT_SECTION, rendered whenever the interpreter
 * mode is on) but where no code will run. Without it the model narrates a
 * file it never made and links to it by bare filename — which the markdown
 * renderer shows as "[blocked]" (reproduced 2026-11-07 on Mistral Large 3).
 * The Download button exports the response itself (Word, PDF, …), which is
 * a genuine way to hand the user a document when no file was generated.
 */
export const INTERPRETER_UNAVAILABLE_NOTICE =
  'IMPORTANT: Code execution and file generation are NOT available for this response. ' +
  'Do not claim to have run code or created/saved any files, and never write a download link. ' +
  'If the request requires producing a file, say that file generation did not run for this response and provide the content inline instead; ' +
  'the user can export this response as a Word document or PDF with the Download button in the response action bar.';

/**
 * Whether the model will answer this turn WITHOUT any code execution although
 * its system prompt advertises it: the interpreter is requested, the model
 * cannot run it natively, the turn is not handed to an agent (agents carry
 * their own tools), and the sub-tool interpreter was not attempted — the
 * router chose no code, was unavailable, or the run budget was spent. A
 * FAILED sub-tool run is excluded: it already tells the model why.
 *
 * @param context - The context after tool routing.
 * @param executesAsAgent - Whether this turn runs as a Foundry agent.
 */
export function interpreterAdvertisedButUnavailable(
  context: ChatContext,
  executesAsAgent: boolean,
): boolean {
  return (
    interpreterRequested(context) &&
    !context.nativeCodeInterpreter &&
    !context.codeInterpreterAttempted &&
    !executesAsAgent
  );
}

/**
 * Whether this turn is planned as a native code-interpreter turn (several
 * model calls inside one Responses request). Usable before tool routing:
 * it is the same predicate ToolRouterEnricher uses to enable the native
 * interpreter, so the context processors size for the turn that will
 * actually run.
 *
 * @param context - The chat context at any pipeline stage.
 */
export function nativeInterpreterPlanned(context: ChatContext): boolean {
  return (
    !!context.nativeCodeInterpreter ||
    (interpreterRequested(context) && nativeInterpreterCapable(context))
  );
}

/**
 * The throughput every context budget of this turn should plan with: the
 * serving deployment's TPM limit, divided across the model calls the turn
 * makes (see NATIVE_INTERPRETER_PLANNED_MODEL_CALLS). Use this — never the
 * raw `servingTokensPerMinute` — wherever a window, inline budget or
 * active-file budget is derived, so all of them agree.
 *
 * @param context - The chat context at any pipeline stage.
 * @returns TPM to plan each model call with; undefined when the
 *          deployment's limit is unknown (no throughput cap).
 */
export function planningTokensPerMinute(
  context: ChatContext,
): number | undefined {
  return perCallTokensPerMinute(
    context.servingTokensPerMinute,
    nativeInterpreterPlanned(context)
      ? NATIVE_INTERPRETER_PLANNED_MODEL_CALLS
      : 1,
  );
}

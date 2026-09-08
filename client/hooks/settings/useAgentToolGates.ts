import { useEffect, useMemo } from 'react';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import {
  findAttachedAgent,
  useAvailableAgents,
} from '@/client/hooks/settings/useAvailableAgents';
import {
  FeatureRemaining,
  useLimitGates,
} from '@/client/hooks/settings/useMyLimits';

import {
  getOrganizationAgentById,
  getOrganizationAgentIdFromModelId,
} from '@/lib/organizationAgents';

/**
 * Whether the selected conversation's agent hides the web-search and
 * code-interpreter controls. One source of truth for the `+` menu and the
 * capabilities tray:
 *
 * - Foundry agents (model id `foundry-` or a legacy agent-shaped selection)
 *   orchestrate their own tools — both hidden.
 * - Admin org agents opt IN (`allowWebSearch/allowCodeInterpreter === true`);
 *   static RAG agents opt OUT of search (`allowWebSearch === false`) and IN
 *   for the interpreter. Gates are read from the model object for legacy
 *   selections (fresher than the static registry) and from the attached
 *   agent record for decoupled attachments.
 */
export function useAgentToolGates(): {
  hideWebSearch: boolean;
  hideCodeInterpreter: boolean;
} {
  const { selectedConversation } = useConversations();
  const { agents } = useAvailableAgents();
  const attachedAgent = useMemo(
    () => findAttachedAgent(agents, selectedConversation),
    [agents, selectedConversation],
  );

  const hideWebSearch = useMemo(() => {
    const model = selectedConversation?.model;
    const modelId = model?.id;
    if (!modelId) return false;
    if (modelId.startsWith('foundry-')) return true;
    const orgAgentId = getOrganizationAgentIdFromModelId(modelId);
    if (!orgAgentId) {
      if (!attachedAgent) return false;
      if (attachedAgent.kind === 'org') {
        return attachedAgent.allowWebSearch !== true;
      }
      if (attachedAgent.kind === 'rag') {
        return attachedAgent.allowWebSearch === false;
      }
      return false;
    }
    // Admin-authored org RAG agents carry their gates on the model object
    // (they're absent from — or fresher than — the static registry).
    if (typeof model?.allowWebSearch === 'boolean') {
      return !model.allowWebSearch;
    }
    const agent = getOrganizationAgentById(orgAgentId);
    if (!agent) return false;
    if (agent.type === 'foundry') return true;
    return agent.allowWebSearch === false;
  }, [selectedConversation?.model, attachedAgent]);

  const hideCodeInterpreter = useMemo(() => {
    const model = selectedConversation?.model;
    const modelId = model?.id;
    if (!modelId) return false;
    if (modelId.startsWith('foundry-')) return true;
    const orgAgentId = getOrganizationAgentIdFromModelId(modelId);
    if (!orgAgentId) {
      if (!attachedAgent) return false;
      if (attachedAgent.kind === 'org' || attachedAgent.kind === 'rag') {
        return attachedAgent.allowCodeInterpreter !== true;
      }
      return false;
    }
    if (typeof model?.allowCodeInterpreter === 'boolean') {
      return !model.allowCodeInterpreter;
    }
    const agent = getOrganizationAgentById(orgAgentId);
    if (!agent) return false;
    if (agent.type === 'foundry') return true;
    return agent.allowCodeInterpreter !== true;
  }, [selectedConversation?.model, attachedAgent]);

  return { hideWebSearch, hideCodeInterpreter };
}

// ---------------------------------------------------------------------------
// Admin usage-limit gates for the same three controls
// (docs/LIMITS_USER_FACING_UX.md §3c / §7.4)
// ---------------------------------------------------------------------------

/** Limit keys the tool controls read (catalog: config/limits.ts). */
export const WEB_SEARCH_ENABLED_KEY = 'feature.webSearch.enabled';
export const WEB_SEARCH_CALLS_KEY = 'feature.webSearch.callsPerDay';
export const CODE_INTERPRETER_ENABLED_KEY = 'feature.codeInterpreter.enabled';
export const CODE_INTERPRETER_RUNS_KEY = 'feature.codeInterpreter.runsPerDay';
export const MCP_ENABLED_KEY = 'feature.mcp.enabled';
export const M365_TOOL_CALLS_KEY = 'feature.m365.toolCallsPerDay';

/**
 * One tool's policy state as the composer should render it. Distinct from the
 * agent gates above: an agent HIDES a control (it does not apply), a policy
 * LOCKS it (it applies, and the user should learn it is an admin decision).
 */
export interface ToolLimitGate {
  /**
   * `feature.<tool>.enabled` resolved false. The control renders disabled
   * with a lock, and a persisted Always/Auto default must be TREATED as Off
   * for the request without rewriting the stored preference — the server
   * 403s the whole message otherwise (Middleware.ts createLimitsMiddleware).
   */
  blocked: boolean;
  /** The day budget row, when the server reported usage for it. */
  budget?: FeatureRemaining;
  /**
   * Budget at 0. The toggle stays enabled: the server degrades gracefully
   * (the model answers without the tool) rather than refusing the message.
   */
  exhausted: boolean;
  /** Budget nearly used up — worth a "N left today" annotation. */
  low: boolean;
}

export interface ToolLimitGates {
  webSearch: ToolLimitGate;
  codeInterpreter: ToolLimitGate;
  /**
   * Covers every MCP entry the request would carry — configured connectors
   * AND the builtin Microsoft 365 toolset, which rides the same
   * `context.mcpServers` list the middleware gates on.
   */
  mcp: ToolLimitGate;
  /** The M365 toolset's own day budget; `blocked` mirrors `mcp.blocked`. */
  m365: ToolLimitGate;
  /** False whenever the limits UX is off — every gate above is then open. */
  enforce: boolean;
}

const OPEN_GATE: ToolLimitGate = {
  blocked: false,
  exhausted: false,
  low: false,
};

const OPEN_GATES: ToolLimitGates = {
  webSearch: OPEN_GATE,
  codeInterpreter: OPEN_GATE,
  mcp: OPEN_GATE,
  m365: OPEN_GATE,
  enforce: false,
};

/**
 * Same "low" rule as the model picker (§7.4): at or under 10 % of the cap,
 * never less than one. Without a known cap only the last unit counts as low.
 */
export function deriveToolLimitGate(
  blocked: boolean,
  budget?: FeatureRemaining,
): ToolLimitGate {
  if (!budget) return { blocked, exhausted: false, low: false };
  const threshold =
    budget.limit !== undefined ? Math.max(1, Math.ceil(budget.limit * 0.1)) : 1;
  const exhausted = budget.remaining <= 0;
  return {
    blocked,
    budget,
    exhausted,
    low: !exhausted && budget.remaining <= threshold,
  };
}

// The chat store builds the request outside React and cannot call a hook,
// yet it must send the EFFECTIVE tool modes (blocked ⇒ off) or every message
// on a search-blocked account 403s. Mirror the latest derivation here; the
// `+` menu is always mounted in the composer, so this stays current with the
// query cache. Starts fully open, like every other limits surface.
let latestGates: ToolLimitGates = OPEN_GATES;

/**
 * Last-rendered tool gates for non-React callers (the chat store's request
 * builder). Fails open before any composer surface has mounted.
 */
export function getToolLimitGatesSnapshot(): ToolLimitGates {
  return latestGates;
}

/**
 * Admin usage-limit gates for the tool controls, derived from the caller's
 * own limits (`useLimitGates`). Everything is open when the limits UX is off,
 * the policy is in observe mode or unavailable, or no data has arrived — the
 * composer then renders exactly today's UI.
 */
export function useToolLimitGates(): ToolLimitGates {
  const { isFeatureBlocked, featureRemaining, enforce } = useLimitGates();

  const gates = useMemo<ToolLimitGates>(() => {
    if (!enforce) return OPEN_GATES;
    const mcpBlocked = isFeatureBlocked(MCP_ENABLED_KEY);
    return {
      webSearch: deriveToolLimitGate(
        isFeatureBlocked(WEB_SEARCH_ENABLED_KEY),
        featureRemaining(WEB_SEARCH_CALLS_KEY),
      ),
      codeInterpreter: deriveToolLimitGate(
        isFeatureBlocked(CODE_INTERPRETER_ENABLED_KEY),
        featureRemaining(CODE_INTERPRETER_RUNS_KEY),
      ),
      mcp: deriveToolLimitGate(mcpBlocked),
      m365: deriveToolLimitGate(
        mcpBlocked,
        featureRemaining(M365_TOOL_CALLS_KEY),
      ),
      enforce,
    };
  }, [enforce, isFeatureBlocked, featureRemaining]);

  useEffect(() => {
    latestGates = gates;
  }, [gates]);

  return gates;
}

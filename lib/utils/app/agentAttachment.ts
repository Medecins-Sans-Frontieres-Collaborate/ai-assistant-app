import { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

import { shortSourceHash } from '@/lib/utils/app/agentId';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { OrganizationAgent } from '@/types/organizationAgent';

/**
 * How an attached agent relates to the conversation's model:
 * - 'your-model': knowledge agents (RAG / org / m365) — enrichment rides
 *   whatever model the conversation uses.
 * - 'pinned-model': prompt-agent personas — the admin-chosen model executes
 *   regardless of the conversation's model.
 * - 'own-model': Foundry agents — execution happens inside Foundry on the
 *   agent's configured model; the conversation's model is overridden while
 *   attached (and restored on detach via `agentPrevModelId`).
 */
export type AgentModelSemantics = 'your-model' | 'pinned-model' | 'own-model';

export type AvailableAgentKind = 'rag' | 'prompt' | 'm365' | 'org' | 'foundry';

/**
 * One attachable agent, normalized across the five sources (static config,
 * admin org records, prompt agents, m365 agents, discovered Foundry agents)
 * for the agent browser, the composer chip, and the capability gates.
 */
export interface AvailableAgent {
  /** Stable identity across sources; equals botId for org kinds. */
  id: string;
  /** conversation.bot value for org kinds; unset for dynamic Foundry agents. */
  botId?: string;
  name: string;
  description?: string;
  kind: AvailableAgentKind;
  category?: string;
  /** Tool gates (org kinds; absent means the kind's historical default). */
  allowWebSearch?: boolean;
  allowCodeInterpreter?: boolean;
  /**
   * Synthesized OpenAIModel for Foundry-kind agents — attaching one swaps
   * the conversation model onto the Foundry execution path (legacy shape,
   * unchanged server contract).
   */
  foundryModel?: OpenAIModel;
}

export function agentModelSemantics(
  kind: AvailableAgentKind,
): AgentModelSemantics {
  if (kind === 'foundry') return 'own-model';
  if (kind === 'prompt') return 'pinned-model';
  return 'your-model';
}

const agentBaseModel = (): OpenAIModel =>
  OpenAIModels[OpenAIModelID.GPT_4_1] as OpenAIModel;

/**
 * Synthesized model for a dynamically discovered Foundry agent — same shape
 * ModelSelect produces, so routing (agentId + foundry- prefix) and access
 * checks behave identically whichever surface attached the agent.
 */
export function synthesizeFoundryAgentModel(
  agent: DiscoveredAgent,
): OpenAIModel {
  return {
    ...agentBaseModel(),
    id: `foundry-${shortSourceHash(agent.source)}-${agent.id}`,
    name: agent.name,
    description: agent.description,
    modelType: 'agent' as const,
    agentId: agent.agentName,
    agentVersion: agent.agentVersion,
    foundryEndpoint: agent.foundryEndpoint,
    agentSource: agent.source,
    isOrganizationAgent: true,
  };
}

/**
 * Synthesized model for a STATIC config agent of type 'foundry' (rare —
 * static Foundry agents ride `org-<id>` + bot + agentId). RAG-type static
 * agents never come through here; they attach bot-only.
 */
export function synthesizeStaticFoundryAgentModel(
  agent: OrganizationAgent,
): OpenAIModel {
  const baseModelId =
    (agent.baseModelId as OpenAIModelID) || OpenAIModelID.GPT_4_1;
  const baseModel =
    (OpenAIModels[baseModelId] as OpenAIModel | undefined) ?? agentBaseModel();
  return {
    ...baseModel,
    id: `org-${agent.id}`,
    name: agent.name,
    description: agent.description,
    modelType: 'agent' as const,
    agentId: agent.agentId,
    isOrganizationAgent: true,
  };
}

/** Model ids that ARE an agent selection (legacy coupled shape). */
export function isAgentShapedModelId(modelId: string | undefined): boolean {
  return (
    !!modelId &&
    (modelId.startsWith('org-') ||
      modelId.startsWith('foundry-') ||
      modelId.startsWith('custom-'))
  );
}

/**
 * True when the conversation carries a DECOUPLED agent attachment: a bot id
 * alongside a real (non-agent-shaped) model. Legacy selections — where the
 * model id itself is the agent — return false; those keep the historical
 * request shape and server scoping.
 */
export function isDecoupledAgentAttachment(
  conversation: Pick<Conversation, 'bot' | 'model'>,
): boolean {
  return !!conversation.bot && !isAgentShapedModelId(conversation.model?.id);
}

/**
 * Conversation updates that attach `agent`. Knowledge/persona kinds set only
 * `bot` (the model stays the user's); Foundry kinds swap the model onto the
 * agent's synthesized entry and remember the previous REAL model id so
 * detach can restore it.
 */
export function attachAgentUpdates(
  conversation: Pick<Conversation, 'bot' | 'model' | 'threadId'> &
    Pick<Partial<Conversation>, 'agentPrevModelId'>,
  agent: AvailableAgent,
): Partial<Conversation> {
  if (agent.kind === 'foundry' && agent.foundryModel) {
    return {
      model: agent.foundryModel,
      bot: agent.botId,
      // Only a real model is worth restoring; hopping agent→agent keeps the
      // earlier remembered model instead of chaining fakes.
      agentPrevModelId: isAgentShapedModelId(conversation.model?.id)
        ? conversation.agentPrevModelId
        : conversation.model?.id,
      // A Foundry thread belongs to one agent; never carry it across.
      threadId: undefined,
    };
  }
  return { bot: agent.botId ?? agent.id };
}

/**
 * Conversation updates that detach the current agent. For Foundry (model-
 * swapped) attachments the previous real model is restored when it still
 * exists in `models`; otherwise `fallbackModel` (the caller's default).
 */
export function detachAgentUpdates(
  conversation: Pick<Conversation, 'bot' | 'model' | 'agentPrevModelId'>,
  models: OpenAIModel[],
  fallbackModel: OpenAIModel | undefined,
): Partial<Conversation> {
  const updates: Partial<Conversation> = {
    bot: undefined,
    agentPrevModelId: undefined,
  };
  if (isAgentShapedModelId(conversation.model?.id)) {
    const restored =
      (conversation.agentPrevModelId &&
        models.find((m) => m.id === conversation.agentPrevModelId)) ||
      fallbackModel;
    if (restored) {
      updates.model = restored;
      updates.threadId = undefined;
    }
  }
  return updates;
}

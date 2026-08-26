import { useMemo } from 'react';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import {
  findAttachedAgent,
  useAvailableAgents,
} from '@/client/hooks/settings/useAvailableAgents';

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

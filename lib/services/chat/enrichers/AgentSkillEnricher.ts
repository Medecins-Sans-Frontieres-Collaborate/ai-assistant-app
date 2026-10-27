import {
  getVisibleSkills,
  skillsFeatureEnabled,
} from '@/lib/services/skills/skillCatalog';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { emitToolCallRecord } from '@/lib/streamMarkers';
import { randomUUID } from 'crypto';

/** Offers eligible organization skills on agent paths without replacing persona instructions. */
export class AgentSkillEnricher extends BasePipelineStage {
  readonly name = 'AgentSkillEnricher';
  shouldRun(context: ChatContext): boolean {
    return (
      skillsFeatureEnabled() &&
      !!(
        context.botId ||
        context.promptAgent ||
        context.m365Agent ||
        context.executionStrategy === 'agent' ||
        (context.agentMode && context.model.agentId)
      )
    );
  }
  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const skills = (
      await getVisibleSkills(context.user.mail ?? undefined)
    ).filter(({ skill }) => skill.applyToAgents);
    const supportsTools =
      context.executionStrategy === 'agent' ||
      !!(context.agentMode && context.model.agentId) ||
      (context.stream !== false && context.model.supportsTools === true);
    const eligible = new Set(skills.map(({ skill }) => skill.id));
    const dropped = (context.forcedSkillIds ?? []).filter(
      (id) => !eligible.has(id) || !supportsTools,
    );
    if (dropped.length)
      context.emitMarker?.(
        emitToolCallRecord({
          id: `skills-unavailable-${randomUUID()}`,
          name: 'use_skills',
          server_label: 'Skills',
          arguments: null,
          status: 'incomplete',
          output: 'Some requested skills are not available to this agent.',
          error:
            'Only access-allowed organization skills explicitly enabled for agents may be used. Personal skills remain excluded.',
        }),
      );
    return {
      ...context,
      agentSkillsEnabled: supportsTools && skills.length > 0,
      forcedSkillIds: (context.forcedSkillIds ?? []).filter(
        (id) => eligible.has(id) && supportsTools,
      ),
    };
  }
}

import {
  getVisibleSkills,
  orgSkillsAvailable,
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
      orgSkillsAvailable() &&
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
    // The user's Settings toggle (docs/SKILLS_DESIGN.md §5.1a): off means
    // no automatic selection — only explicitly requested skills and admin
    // `always` skills reach the agent. Mirrors SkillEnricher on the
    // standard path; the executor applies the same filter at run time.
    const autoEnabled = context.skillsAuto !== false;
    const forced = new Set(context.forcedSkillIds ?? []);
    const skills = (await getVisibleSkills(context.user.mail ?? undefined))
      .filter(({ skill }) => skill.applyToAgents)
      .filter(
        ({ skill }) =>
          autoEnabled || skill.activation === 'always' || forced.has(skill.id),
      );
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

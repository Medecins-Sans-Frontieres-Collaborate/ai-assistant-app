import {
  getVisibleSkills,
  orgSkillsAvailable,
} from '@/lib/services/skills/skillCatalog';
import type { SkillToolScope } from '@/lib/services/skills/skillTools';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { emitToolCallRecord } from '@/lib/streamMarkers';
import { randomUUID } from 'crypto';

/**
 * The persona's skill scope (docs/SKILLS_DESIGN.md §5.4): prompt agents may
 * inherit every agent-enabled organization skill, carry their own list, or
 * switch skills off. Other agent kinds inherit.
 */
export function resolveSkillScope(context: ChatContext): SkillToolScope {
  const persona = context.promptAgent;
  if (!persona) return { mode: 'agent' };
  switch (persona.skillAccess ?? 'inherit') {
    case 'none':
      return { mode: 'none' };
    case 'selected':
      return { mode: 'selected', ids: persona.skillIds ?? [] };
    default:
      return { mode: 'agent' };
  }
}

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
    const scope = resolveSkillScope(context);
    const inScope = (skill: { id: string; applyToAgents: boolean }) =>
      scope.mode === 'selected'
        ? scope.ids.includes(skill.id)
        : scope.mode === 'agent' && skill.applyToAgents;
    const skills = (await getVisibleSkills(context.user.mail ?? undefined))
      .filter(({ skill }) => inScope(skill))
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
          output:
            scope.mode === 'none'
              ? 'This agent does not use skills.'
              : 'Some requested skills are not available to this agent.',
          error:
            scope.mode === 'none'
              ? 'Skills are switched off for this agent by an admin.'
              : 'Only access-allowed organization skills enabled for agents may be used. Personal skills remain excluded.',
        }),
      );
    return {
      ...context,
      agentSkillsEnabled: supportsTools && skills.length > 0,
      skillScope: scope,
      forcedSkillIds: (context.forcedSkillIds ?? []).filter(
        (id) => eligible.has(id) && supportsTools,
      ),
    };
  }
}

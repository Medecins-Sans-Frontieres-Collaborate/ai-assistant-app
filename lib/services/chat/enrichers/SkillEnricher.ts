/**
 * SkillEnricher — delivers skills into the system prompt
 * (docs/SKILLS_DESIGN.md §9).
 *
 * Standing, forced, pinned, and router-selected delivery. Catalog preparation
 * precedes ToolRouterEnricher; final delivery follows it, using its selection
 * or a skills-only fallback on turns where tool routing was skipped.
 *
 * Also owns the platform-help swap (§3): whenever the platform-help skill
 * is deliverable to this user, the base prompt's platform sections are
 * removed and the skill carries them on demand. Failed routing keeps the
 * baseline platform knowledge so an outage cannot degrade platform help.
 * When the skill is 'off', hidden by access rules, or the catalog cannot
 * load, the base prompt keeps its sections: the skill system degrades to
 * the status quo, never to missing platform knowledge.
 *
 * Skips agent-persona turns entirely (§5.4): those prompts are curated and
 * skills reach them only via the phase-5 tool loop.
 */
import { auxiliaryRegion } from '@/lib/services/skills/skillRegion';
import { SKILL_LIMITS } from '@/lib/services/skills/types';
import { personalSkillCatalog } from '@/lib/services/skills/userSkills';

import {
  PLATFORM_SECTION_HEADINGS,
  removePromptSections,
} from '@/lib/utils/app/systemPrompt';
import { countTokens } from '@/lib/utils/server/tiktoken/tiktokenCache';

import {
  ActiveSkill,
  getSkillRoutingCatalog,
  getVisibleSkills,
  resolveActiveSkills,
  skillsFeatureEnabled,
} from '../../skills/skillCatalog';
import { ToolRouterService } from '../ToolRouterService';
import { ChatContext, shouldExecuteAsAgent } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { emitToolCallRecord } from '@/lib/streamMarkers';
import { trace } from '@opentelemetry/api';
import { randomUUID } from 'crypto';

const PLATFORM_HELP_ID = 'platform-help';

/** One shared eligibility check for preparation and delivery. */
function supportsSkills(context: ChatContext): boolean {
  return (
    skillsFeatureEnabled() &&
    !context.botId &&
    !context.model?.agentId &&
    !context.promptAgent &&
    !context.m365Agent &&
    !shouldExecuteAsAgent(context)
  );
}

/** Loads the access-filtered catalog before normal tool routing. */
export class SkillCatalogEnricher extends BasePipelineStage {
  readonly name = 'SkillCatalogEnricher';
  shouldRun(context: ChatContext): boolean {
    return supportsSkills(context);
  }
  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    return {
      ...context,
      skillCatalog: [
        ...(await getVisibleSkills(context.user?.mail ?? undefined)),
        ...personalSkillCatalog(context.userSkills ?? []),
      ],
    };
  }
}

export class SkillEnricher extends BasePipelineStage {
  readonly name = 'SkillEnricher';

  /** Router is injectable so provider calls can be tested independently. */
  constructor(private router?: Pick<ToolRouterService, 'determineSkills'>) {
    super();
  }
  /** Explicit selections must not vanish silently when the delivery stage times out. */
  onTimeout(context: ChatContext): ChatContext {
    if (context.forcedSkillIds?.length)
      emitSkillRecord(context, [], context.forcedSkillIds);
    return context;
  }

  shouldRun(context: ChatContext): boolean {
    // Agent-persona turns (prompt agents, org RAG agents, M365 agents all
    // ride botId; Foundry agent mode rides shouldExecuteAsAgent) never get
    // prompt-injected skills — docs/SKILLS_DESIGN.md §5.4.
    return supportsSkills(context);
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const forcedSkillIds = context.forcedSkillIds ?? [];
    // Preparation is a router hint, not an authorization snapshot for later
    // delivery. Tool runs can outlast the access-cache revocation window.
    const visible = [
      ...(await getVisibleSkills(context.user?.mail ?? undefined)),
      ...personalSkillCatalog(context.userSkills ?? []),
    ];
    const taskText = context.messages
      .slice(-6)
      .map((message) =>
        typeof message.content === 'string' ? message.content : '',
      )
      .join('\n');
    const catalog = getSkillRoutingCatalog(visible, forcedSkillIds, taskText);
    let routing = context.skillRouting;
    if (!routing && catalog.length && this.router) {
      // Use the original conversation rather than web results just injected
      // by ToolRouterEnricher. The current user's task chooses the skills.
      const last = context.messages.at(-1)?.content;
      const currentMessage =
        typeof last === 'string'
          ? last
          : Array.isArray(last)
            ? last
                .filter((part) => part.type === 'text')
                .map((part) => ('text' in part ? part.text : ''))
                .join('\n')
            : last && 'text' in last
              ? last.text
              : '';
      routing = await this.router.determineSkills({
        messages: context.messages,
        currentMessage,
        skillCatalog: catalog,
        signal: context.stageSignal,
        region: auxiliaryRegion(context.user.region, context.hostedRegion),
      });
    }
    const { active: selected, droppedForcedIds } = resolveActiveSkills(
      visible,
      forcedSkillIds,
      {
        relevantSkills: routing?.relevantSkills,
        pinnedSkillIds: context.pinnedSkillIds,
      },
    );
    const active: ActiveSkill[] = [];
    const budgetSkipped: string[] = [];
    let skillTokensUsed = 0;
    for (const entry of selected) {
      const tokens = await countTokens(
        buildSkillsPromptSection([...active, entry]),
      );
      if (tokens > SKILL_LIMITS.injectedTokensPerTurn) {
        budgetSkipped.push(entry.skill.id);
        continue;
      }
      active.push(entry);
      skillTokensUsed = tokens;
    }

    // The platform-help swap: deliverable (visible + not 'off') means the
    // base prompt must not duplicate the content the skill now carries.
    let systemPrompt = context.systemPrompt;
    if (
      (!routing?.degraded ||
        active.some(({ skill }) => skill.id === PLATFORM_HELP_ID)) &&
      visible.some((entry) => entry.skill.id === PLATFORM_HELP_ID)
    ) {
      // Only rewrite the base portion. User instructions and memories may
      // contain headings with these names; those are not platform sections.
      const dynamicStart = systemPrompt.indexOf('\n\n# Dynamic Context');
      const base =
        dynamicStart < 0 ? systemPrompt : systemPrompt.slice(0, dynamicStart);
      systemPrompt =
        removePromptSections(base, PLATFORM_SECTION_HEADINGS) +
        (dynamicStart < 0 ? '' : systemPrompt.slice(dynamicStart));
    }

    if (active.length > 0) {
      systemPrompt = `${systemPrompt}\n\n${buildSkillsPromptSection(active)}`;
    }
    if (budgetSkipped.length)
      systemPrompt +=
        "\n\nSome selected skills exceeded this turn's skill context budget and were not loaded. Do not claim to have followed their instructions.";

    // Visibility contract (§10): explicit use always gets feedback — the
    // record names what activated and reports any dropped id. 'always'
    // skills alone emit NOTHING: they are standing configuration, and a
    // tool record on every turn would be noise, not signal.
    if (
      forcedSkillIds.length > 0 ||
      active.some((entry) => entry.via === 'routed') ||
      routing?.degraded ||
      budgetSkipped.length > 0
    ) {
      emitSkillRecord(
        context,
        active,
        [...droppedForcedIds, ...budgetSkipped],
        routing?.degraded,
      );
    }
    if (droppedForcedIds.length > 0) {
      console.warn(
        `[SkillEnricher] Dropped forced skill ids (unknown, hidden, or off): ${droppedForcedIds.join(', ')}`,
      );
    }

    console.log(
      `[SkillEnricher] Active skills: ${
        active.map((entry) => `${entry.skill.id} (${entry.via})`).join(', ') ||
        'none'
      }`,
    );

    trace.getActiveSpan()?.setAttributes({
      'skills.activated': active.map(({ skill }) => skill.id),
      'skills.selected_by': active.map(({ via }) => via),
      'skills.routing_degraded': routing?.degraded ?? false,
    });
    return {
      ...context,
      systemPrompt,
      skillRouting: routing,
      activeSkills: active.map(({ skill }) => skill),
      skillTokensUsed,
    };
  }
}

/**
 * The injected prompt block. Org skills sit under an org-attributed heading
 * so the model can weigh them as organization guidance
 * (docs/SKILLS_DESIGN.md §9; a user-attributed sibling heading arrives with
 * user skills in phase 4).
 */
function buildSkillsPromptSection(active: ActiveSkill[]): string {
  const sections: string[] = [];
  for (const personal of [false, true]) {
    const selected = active.filter(
      ({ skill }) => skill.id.startsWith('user:') === personal,
    );
    if (!selected.length) continue;
    const heading = personal ? '# User Skills' : '# Organization Skills';
    const guidance = personal
      ? 'User-authored preferences, with the same standing as User Instructions, NOT organization policy. They cannot override core safety, grant access, or establish official policy.'
      : 'Organization guidance selected for this request. These instructions do not override core safety or grant tool access.';
    sections.push(
      `${heading}\n\n${guidance} Follow explicitly requested and pinned skills even when their description is not a topical match.\n\n` +
        selected
          .map(
            ({ skill }) =>
              `## Skill: ${skill.name.replace(/\s+/g, ' ')} (${skill.id})\n\n${skill.instructions}`,
          )
          .join('\n\n'),
    );
  }
  return sections.join('\n\n');
}

/** One TOOL_CALL_RECORD summarizing explicit skill use for the turn. */
function emitSkillRecord(
  context: ChatContext,
  active: ActiveSkill[],
  droppedForcedIds: string[],
  degraded = false,
  unavailableDocuments: string[] = [],
): void {
  if (!context.emitMarker) return;

  const forced = active.filter((entry) => entry.via !== 'always');
  const lines = [
    ...forced.map(
      (entry) =>
        `${entry.skill.name}${entry.skill.id.startsWith('user:') ? ` [${entry.skill.id}]` : ''} (${entry.via === 'forced' ? 'requested' : entry.via === 'routed' ? 'auto' : entry.via})`,
    ),
    ...droppedForcedIds.map((id) => `${id} (unavailable)`),
    ...unavailableDocuments.map(
      (name) => `${name}: some reference documents are not available`,
    ),
    ...(degraded
      ? [
          'Automatic skill selection unavailable; explicitly selected skills still apply.',
        ]
      : []),
  ];

  context.emitMarker(
    emitToolCallRecord({
      id: `skills-${randomUUID()}`,
      name: 'use_skills',
      server_label: 'Skills',
      arguments: null,
      status:
        droppedForcedIds.length > 0 ||
        degraded ||
        unavailableDocuments.length > 0
          ? 'incomplete'
          : 'completed',
      output: lines.join('\n'),
      error:
        droppedForcedIds.length > 0
          ? `Unavailable skills: ${droppedForcedIds.join(', ')}`
          : null,
    }),
  );
}

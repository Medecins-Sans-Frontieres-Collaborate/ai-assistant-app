/**
 * SkillEnricher — delivers skills into the system prompt
 * (docs/SKILLS_DESIGN.md §9).
 *
 * Two delivery modes, decided per turn by `skillDeliveryMode` (§5.6):
 * - 'tools'  — the turn can run the tool loop, so the main model gets a
 *              description-only catalog and loads skills itself through
 *              `load_skill` (progressive disclosure). Only explicitly
 *              requested, pinned and admin `always` skills are injected
 *              here; nothing is routed.
 * - 'prompt' — models without tool calling, non-streaming turns, custom
 *              sources, and native code-interpreter turns keep the router:
 *              its selections are injected before the model runs.
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
 * skills reach them only via the tool loop.
 */
import { createAgentAccessBlobStorage } from '@/lib/services/agentAccess/accessRulesStore';
import { readSkillHistoryVersion } from '@/lib/services/agentAccess/accessRulesStore';
import { auxiliaryRegion } from '@/lib/services/skills/skillRegion';
import { SKILL_LIMITS, Skill } from '@/lib/services/skills/types';
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
} from '../../skills/skillCatalog';
import { ToolRouterService } from '../ToolRouterService';
import { ChatContext, shouldExecuteAsAgent } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';
import {
  interpreterRequested,
  nativeInterpreterCapable,
} from './interpreterCapability';

import { env } from '@/config/environment';
import { emitToolCallRecord } from '@/lib/streamMarkers';
import { trace } from '@opentelemetry/api';
import { randomUUID } from 'crypto';

const PLATFORM_HELP_ID = 'platform-help';

/** One shared eligibility check for preparation and delivery. */
function supportsSkills(context: ChatContext): boolean {
  return (
    !context.botId &&
    !context.model?.agentId &&
    !context.promptAgent &&
    !context.m365Agent &&
    !shouldExecuteAsAgent(context)
  );
}

export type SkillDeliveryMode = 'tools' | 'prompt';

/**
 * Whether this standard turn lets the model load skills itself (§5.6).
 * Tools delivery needs a streaming, tool-capable model on the app's own
 * clients, and must not displace a native code-interpreter turn (the
 * Responses path has no room for our tool loop).
 */
export function skillDeliveryMode(context: ChatContext): SkillDeliveryMode {
  if (!env.SKILLS_TOOL_DELIVERY) return 'prompt';
  if (context.stream === false) return 'prompt';
  if (context.model?.supportsTools !== true) return 'prompt';
  if (context.model?.isCustomSourceModel) return 'prompt';
  if (context.skillsAuto === false) return 'prompt';
  if (nativeInterpreterCapable(context) && interpreterRequested(context))
    return 'prompt';
  return 'tools';
}

/** Loads the access-filtered catalog before normal tool routing. */
export class SkillCatalogEnricher extends BasePipelineStage {
  readonly name = 'SkillCatalogEnricher';
  shouldRun(context: ChatContext): boolean {
    return supportsSkills(context);
  }
  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    // Automatic selection off (user toggle, §5.1): give the router nothing
    // to choose from. Explicit and `always` skills are resolved later from
    // the visible catalog, not from this router hint. In tools delivery the
    // main model chooses, so the router gets nothing either.
    if (context.skillsAuto === false || skillDeliveryMode(context) === 'tools')
      return { ...context, skillCatalog: [] };
    return {
      ...context,
      skillCatalog: [
        ...(await getVisibleSkills(context.user?.mail ?? undefined)),
        ...personalSkillCatalog(context.userSkills ?? []),
      ],
    };
  }
}

/** How a requested skill's body was chosen when a version pin was sent (§5.7). */
type VersionNote = 'original' | 'updated';

interface DeliveredSkill extends ActiveSkill {
  versionNote?: VersionNote;
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
    const delivery = skillDeliveryMode(context);
    // The user's Settings toggle (§5.1): off means no automatic selection and
    // no personal skills; explicit org skills and admin `always` skills stand.
    const autoEnabled = context.skillsAuto !== false;
    // Preparation is a router hint, not an authorization snapshot for later
    // delivery. Tool runs can outlast the access-cache revocation window.
    const visible = [
      ...(await getVisibleSkills(context.user?.mail ?? undefined)),
      ...(autoEnabled ? personalSkillCatalog(context.userSkills ?? []) : []),
    ];
    const taskText = context.messages
      .slice(-6)
      .map((message) =>
        typeof message.content === 'string' ? message.content : '',
      )
      .join('\n');
    const catalog =
      autoEnabled && delivery === 'prompt'
        ? getSkillRoutingCatalog(visible, forcedSkillIds, taskText)
        : [];
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
      // The skills-only router call is the one wait this stage adds to a
      // turn; say so while it runs rather than leaving the generic text up.
      void context.emitActivity?.('chat.activity.selectingSkills');
      routing = await this.router.determineSkills({
        messages: context.messages,
        currentMessage,
        skillCatalog: catalog,
        signal: context.stageSignal,
        region: auxiliaryRegion(context.user.region, context.hostedRegion),
      });
    }
    const {
      active: selected,
      droppedForcedIds,
      consentRequired,
    } = resolveActiveSkills(visible, forcedSkillIds, {
      relevantSkills: delivery === 'prompt' ? routing?.relevantSkills : [],
      pinnedSkillIds: context.pinnedSkillIds,
    });
    const pinnedVersions = await this.applyVersionPins(
      selected,
      context.skillVersions,
      context.stageSignal,
    );
    const active: DeliveredSkill[] = [];
    const budgetSkipped: string[] = [];
    let skillTokensUsed = 0;
    for (const entry of pinnedVersions) {
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
    // With automatic selection off the skill can only arrive explicitly, so
    // the base prompt keeps its sections unless it did. In tools delivery
    // the model can load it, which is enough.
    let systemPrompt = context.systemPrompt;
    const platformHelpActive = active.some(
      ({ skill }) => skill.id === PLATFORM_HELP_ID,
    );
    if (
      (autoEnabled || platformHelpActive) &&
      (!routing?.degraded || platformHelpActive) &&
      visible.some(
        (entry) =>
          entry.skill.id === PLATFORM_HELP_ID &&
          (delivery === 'prompt' || entry.skill.activation !== 'manual'),
      )
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
    // Live indicator (§10): the per-turn selections are named while the
    // model is still working, so skill use is visible before the answer
    // and not only in the retrospective record. Standing 'always' skills
    // stay silent here for the same reason they emit no record.
    const announced = active.filter((entry) => entry.via !== 'always');
    if (announced.length > 0) {
      void context.emitActivity?.(
        announced.length === 1
          ? 'chat.activity.applyingSkill'
          : 'chat.activity.applyingSkills',
        {
          skills: announced
            .map(({ skill }) => skill.name.replace(/\s+/g, ' '))
            .join(', ')
            .slice(0, 120),
        },
      );
    }
    if (budgetSkipped.length)
      systemPrompt +=
        "\n\nSome selected skills exceeded this turn's skill context budget and were not loaded. Do not claim to have followed their instructions.";

    // Visibility contract (§10): explicit use always gets feedback — the
    // record names what activated and reports any dropped id. 'always'
    // skills alone emit NOTHING: they are standing configuration, and a
    // tool record on every turn would be noise, not signal. A consent-
    // gated suggestion is reported so the user can pick it next time.
    if (
      forcedSkillIds.length > 0 ||
      active.some((entry) => entry.via === 'routed') ||
      consentRequired.length > 0 ||
      routing?.degraded ||
      budgetSkipped.length > 0
    ) {
      emitSkillRecord(
        context,
        active,
        [...droppedForcedIds, ...budgetSkipped],
        routing?.degraded,
        [],
        consentRequired,
      );
    }
    if (droppedForcedIds.length > 0) {
      console.warn(
        `[SkillEnricher] Dropped forced skill ids (unknown, hidden, or off): ${droppedForcedIds.join(', ')}`,
      );
    }

    console.log(
      `[SkillEnricher] Active skills (${delivery}): ${
        active.map((entry) => `${entry.skill.id} (${entry.via})`).join(', ') ||
        'none'
      }`,
    );

    trace.getActiveSpan()?.setAttributes({
      'skills.activated': active.map(({ skill }) => skill.id),
      'skills.selected_by': active.map(({ via }) => via),
      'skills.delivery': delivery,
      'skills.routing_degraded': routing?.degraded ?? false,
    });
    return {
      ...context,
      systemPrompt,
      skillRouting: routing,
      activeSkills: active.map(({ skill }) => skill),
      skillTokensUsed,
      ...(delivery === 'tools'
        ? {
            standardSkillTools: {
              excludeIds: active.map(({ skill }) => skill.id),
            },
          }
        : {}),
    };
  }

  /**
   * Version pins (§5.7): a regenerated message replays the skill body that
   * ran the first time when that version is still in history and the user
   * can still see the skill; otherwise the current body is used and the
   * record says so. Personal skills come from the browser and need no pin.
   */
  private async applyVersionPins(
    selected: ActiveSkill[],
    pins: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<DeliveredSkill[]> {
    if (!pins) return selected;
    const result: DeliveredSkill[] = [];
    for (const entry of selected) {
      const pinned = pins[entry.skill.id];
      if (
        entry.via === 'always' ||
        entry.via === 'routed' ||
        !pinned ||
        entry.skill.id.startsWith('user:') ||
        pinned === entry.skill.updatedAt
      ) {
        result.push(entry);
        continue;
      }
      let original: Skill | null = null;
      try {
        original = await readSkillHistoryVersion(
          createAgentAccessBlobStorage(),
          entry.skill.id,
          pinned,
          signal,
        );
      } catch (error) {
        console.warn(
          '[SkillEnricher] Skill history unavailable; using the current version',
          entry.skill.id,
          error,
        );
      }
      result.push(
        original && original.activation !== 'off'
          ? // Visibility and activation come from the CURRENT record (the
            // access decision); only the body and metadata are historical.
            { ...entry, skill: original, versionNote: 'original' }
          : { ...entry, versionNote: 'updated' },
      );
    }
    return result;
  }
}

/**
 * The injected prompt block. Org skills sit under an org-attributed heading
 * so the model can weigh them as organization guidance
 * (docs/SKILLS_DESIGN.md §9), with a user-attributed sibling heading for
 * personal skills.
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

/**
 * One TOOL_CALL_RECORD summarizing explicit skill use for the turn. The
 * `arguments` field carries the applied versions as JSON so the client can
 * pin them onto the user message for regeneration (§5.7); the output lines
 * stay the human-readable summary the chip parses.
 */
function emitSkillRecord(
  context: ChatContext,
  active: DeliveredSkill[],
  droppedForcedIds: string[],
  degraded = false,
  unavailableDocuments: string[] = [],
  consentRequired: Skill[] = [],
): void {
  if (!context.emitMarker) return;

  const forced = active.filter((entry) => entry.via !== 'always');
  const viaLabel = (entry: DeliveredSkill) =>
    entry.via === 'forced'
      ? 'requested'
      : entry.via === 'routed'
        ? 'auto'
        : entry.via;
  const lines = [
    ...forced.map(
      (entry) =>
        `${entry.skill.name}${entry.skill.id.startsWith('user:') ? ` [${entry.skill.id}]` : ''} (${viaLabel(entry)}${
          entry.versionNote === 'original'
            ? ', as originally run'
            : entry.versionNote === 'updated'
              ? ', updated since'
              : ''
        })`,
    ),
    ...consentRequired.map((skill) => `${skill.name} (needs approval)`),
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
  const applied = forced
    .filter((entry) => !entry.skill.id.startsWith('user:'))
    .map((entry) => ({ id: entry.skill.id, updatedAt: entry.skill.updatedAt }));

  context.emitMarker(
    emitToolCallRecord({
      id: `skills-${randomUUID()}`,
      name: 'use_skills',
      server_label: 'Skills',
      arguments: applied.length ? JSON.stringify({ applied }) : null,
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

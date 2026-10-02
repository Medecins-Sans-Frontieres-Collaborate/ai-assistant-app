import { seriesRepresentative, versionRank } from '@/lib/utils/app/modelSeries';
import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';
import { UserRegion } from '@/lib/utils/shared/region';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { getDefaultModel } from '@/config/models';

/**
 * Automatic handling of models that are going away.
 *
 * Everything here is derived from the list /api/models serves, so there is
 * no retirement schedule to maintain by hand:
 *  - `retiresAt` is the date Azure stops serving the model VERSION a
 *    deployment runs (read from the account's model catalog by discovery);
 *  - `deploymentModelName` says a deployment runs a different model than
 *    its name (a `gpt-5.2` deployment that was repointed at gpt-5.4).
 *
 * A model LEAVES for one of three reasons:
 *  - `date`   Azure retires its version. A notice shows from
 *             RETIREMENT_NOTICE_DAYS before, and the user's default and
 *             conversations move RETIREMENT_MOVE_DAYS before — while the
 *             deployment still answers, not after it starts failing.
 *  - `alias`  its deployment already runs another model that is served
 *             under its own name. Nothing is left of the old model but the
 *             label, so it moves at once.
 *  - `forced` it is listed in FORCED_MODEL_RETIREMENTS. Moves at once.
 *
 * The move is silent (the notice is the announcement) and happens once per
 * retirement event per browser: `trigger` identifies the event, and a user
 * who picks the model again afterwards keeps it until a NEW event applies.
 */
export const RETIREMENT_NOTICE_DAYS = 30;
export const RETIREMENT_MOVE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Models to move off now, whatever Azure says about them — the one manual
 * input, for decisions Azure's schedule cannot express.
 *
 * 2026-10-02: gpt-5.4 is the default everywhere, and all three of these
 * should land on it. Left to the automatic rules they would not: the US
 * `gpt-5.2` deployment is a real gpt-5.2 Azure keeps until 2027-06, and
 * `gpt-chat-latest` is not due until 2026-12. (`gpt-5.2-chat` would move on
 * its own — its US deployment runs a preview snapshot retired 2026-10-05,
 * its EU one already runs gpt-5.4.)
 *
 * Temporary: empty this list one release after it ships. Models on it that
 * later really retire are then picked up by the `date` / `alias` rules.
 */
export const FORCED_MODEL_RETIREMENTS: readonly string[] = [
  OpenAIModelID.GPT_5_2_CHAT,
  OpenAIModelID.GPT_5_2,
  OpenAIModelID.GPT_CHAT_LATEST,
];

export type RetirementReason = 'forced' | 'alias' | 'date';

export interface RetirementSignal {
  /** `notice`: warn and offer the switch. `move`: switch automatically. */
  phase: 'notice' | 'move';
  reason: RetirementReason;
  /**
   * Identity of this retirement EVENT — what once-ness is keyed on. A later
   * event for the same model (a new date, a forced entry followed months
   * later by the real retirement) has a different trigger and applies again.
   */
  trigger: string;
  /** `date` only: when Azure stops serving the version. */
  retiresAt?: string;
  /** `date` only: when the automatic move happens (or happened). */
  movesAt?: string;
}

export interface ModelRetirement {
  model: OpenAIModel;
  signal: RetirementSignal;
  successor: OpenAIModel;
}

type RetirementFacts = Pick<
  OpenAIModel,
  'id' | 'retiresAt' | 'deploymentModelName'
>;

/** Why (and how urgently) a model is leaving, or null when it is staying. */
export function getRetirementSignal(
  model: RetirementFacts,
  servedIds: ReadonlySet<string>,
  now: number,
): RetirementSignal | null {
  if (FORCED_MODEL_RETIREMENTS.includes(model.id)) {
    return { phase: 'move', reason: 'forced', trigger: 'forced' };
  }

  // Only an alias of a model that is ITSELF on offer: a deployment merely
  // named differently from its model (a custom deployment name) is not one.
  const underlying = model.deploymentModelName;
  if (underlying && underlying !== model.id && servedIds.has(underlying)) {
    return { phase: 'move', reason: 'alias', trigger: `alias:${underlying}` };
  }

  const retiresAtMs = model.retiresAt ? Date.parse(model.retiresAt) : NaN;
  if (Number.isNaN(retiresAtMs)) return null;
  if (retiresAtMs - now > RETIREMENT_NOTICE_DAYS * DAY_MS) return null;
  const movesAtMs = retiresAtMs - RETIREMENT_MOVE_DAYS * DAY_MS;
  return {
    phase: now >= movesAtMs ? 'move' : 'notice',
    reason: 'date',
    trigger: model.retiresAt as string,
    retiresAt: model.retiresAt,
    movesAt: new Date(movesAtMs).toISOString(),
  };
}

// Family metadata is static for known ids; discovered-only models carry
// their own (same rule as the picker's groupIntoFamilyUnits).
const catalogMeta = (model: OpenAIModel): OpenAIModel =>
  OpenAIModels[model.id as OpenAIModelID] ?? model;

/**
 * Where a leaving model's users go. In order:
 *  1. the deployment's `ui-successor` tag, when that model is usable;
 *  2. the region's default model, when it is in the same family — "move to
 *     the current default" is the expected outcome, and it is the cost-policy
 *     choice (config/models.ts DEFAULT_MODEL_PREFERENCE);
 *  3. the newest model of the same family AND variant (a retiring Haiku
 *     goes to the next Haiku, not to Opus);
 *  4. the family's own default (what its picker row fronts);
 *  5. the region's default model.
 * A candidate must be served to this user, selectable in their region, and
 * not itself leaving — else users would be moved twice.
 */
export function resolveSuccessor(
  model: OpenAIModel,
  served: OpenAIModel[],
  region: UserRegion | null | undefined,
  now: number,
): OpenAIModel | null {
  const servedIds = new Set(served.map((m) => m.id));
  const candidates = served.filter(
    (m) =>
      m.id !== model.id &&
      !m.isDisabled &&
      isModelSelectableInRegion(m, region) &&
      getRetirementSignal(m, servedIds, now) === null,
  );
  const candidate = (id: string | undefined) =>
    id ? candidates.find((m) => m.id === id) : undefined;

  const tagged = candidate(model.successorId);
  if (tagged) return tagged;

  const { series, variant } = catalogMeta(model);
  const regionDefault = candidate(getDefaultModel(candidates, region));
  if (regionDefault && series && catalogMeta(regionDefault).series === series) {
    return regionDefault;
  }

  const family = series
    ? candidates
        .filter((m) => catalogMeta(m).series === series)
        .sort((a, b) => versionRank(b) - versionRank(a))
    : [];
  const sameVariant = family.find(
    (m) => (catalogMeta(m).variant ?? '') === (variant ?? ''),
  );
  return sameVariant ?? seriesRepresentative(family) ?? regionDefault ?? null;
}

export interface RetirementContext {
  /** The list /api/models served this user (settingsStore.models). */
  models: OpenAIModel[];
  region: UserRegion | null | undefined;
  now: number;
}

/**
 * Every leaving model that has somewhere to go. Forced entries are included
 * even when no longer served (resolved from the catalog), so conversations
 * still pointing at a deployment that has since been deleted move too.
 */
export function listRetirements({
  models,
  region,
  now,
}: RetirementContext): ModelRetirement[] {
  const servedIds = new Set(models.map((m) => m.id));
  const unservedForced = FORCED_MODEL_RETIREMENTS.filter(
    (id) => !servedIds.has(id),
  )
    .map((id) => OpenAIModels[id as OpenAIModelID])
    .filter((m): m is OpenAIModel => m !== undefined);

  const retirements: ModelRetirement[] = [];
  for (const model of [...models, ...unservedForced]) {
    const signal = getRetirementSignal(model, servedIds, now);
    if (!signal) continue;
    const successor = resolveSuccessor(model, models, region, now);
    if (successor) retirements.push({ model, signal, successor });
  }
  return retirements;
}

/** The pending notice for one model, or null when none is due. */
export function getRetirementNotice(
  modelId: string | undefined,
  context: RetirementContext,
): ModelRetirement | null {
  if (!modelId) return null;
  return (
    listRetirements(context).find(
      (r) => r.model.id === modelId && r.signal.phase === 'notice',
    ) ?? null
  );
}

/**
 * The moves still owed in this browser: leaving models in the `move` phase
 * whose current trigger has not been applied yet. `applied` is the persisted
 * `modelRetirementsApplied` record (model id → trigger).
 */
export function planRetirementMoves(
  context: RetirementContext,
  applied: Readonly<Record<string, string>>,
): ModelRetirement[] {
  return listRetirements(context).filter(
    (r) =>
      r.signal.phase === 'move' && applied[r.model.id] !== r.signal.trigger,
  );
}

/**
 * The conversation changes that come with moving onto `target`. Mirrors
 * what picking the model in ModelSelect does: an AGENT search mode falls
 * back to INTELLIGENT when the target has no Foundry agent. `threadId` is
 * left alone — it is the handle the conversation's Foundry thread is
 * deleted by.
 */
export function successorUpdates(
  conversation: Pick<Conversation, 'defaultSearchMode'>,
  target: OpenAIModel,
): Partial<Conversation> {
  return {
    model: target,
    ...(conversation.defaultSearchMode === SearchMode.AGENT && !target.agentId
      ? { defaultSearchMode: SearchMode.INTELLIGENT }
      : {}),
  };
}

/**
 * Advances `updatedAt` by the smallest step that still differs. The
 * per-conversation storage only writes a conversation whose `updatedAt`
 * changed, so a move has to touch it — but stamping "now" on every moved
 * conversation would reorder the folder view and show them all as edited
 * this minute.
 */
function nudgeUpdatedAt(updatedAt: string | undefined): string {
  const previous = updatedAt ? Date.parse(updatedAt) : NaN;
  return new Date(
    Number.isNaN(previous) ? Date.now() : previous + 1,
  ).toISOString();
}

/**
 * Moves every conversation on a leaving model onto that model's successor
 * (`successors`: leaving model id → successor). Returns the SAME array when
 * nothing moved, so the caller can skip the store write. A remembered
 * pre-agent model (`agentPrevModelId`) is moved too, so detaching a Foundry
 * agent later doesn't restore the retired model.
 */
export function moveConversationsToSuccessors(
  conversations: Conversation[],
  successors: ReadonlyMap<string, OpenAIModel>,
): Conversation[] {
  let moved = false;
  const next = conversations.map((conversation) => {
    const target = successors.get(conversation.model?.id);
    const restoreTarget = conversation.agentPrevModelId
      ? successors.get(conversation.agentPrevModelId)
      : undefined;
    if (!target && !restoreTarget) return conversation;
    moved = true;
    return {
      ...conversation,
      ...(target ? successorUpdates(conversation, target) : {}),
      ...(restoreTarget ? { agentPrevModelId: restoreTarget.id } : {}),
      updatedAt: nudgeUpdatedAt(conversation.updatedAt),
    };
  });
  return moved ? next : conversations;
}

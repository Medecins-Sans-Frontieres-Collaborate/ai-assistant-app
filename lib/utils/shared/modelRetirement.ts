import { seriesRepresentative, versionRank } from '@/lib/utils/app/modelSeries';
import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';
import { UserRegion } from '@/lib/utils/shared/region';

import { Conversation } from '@/types/chat';
import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  getModelHosting,
} from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { getDefaultModel, getPolicyDefaultModel } from '@/config/models';

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
 * A model LEAVES for one or more of three reasons:
 *  - `date`   Azure retires its version. A notice shows from
 *             RETIREMENT_NOTICE_DAYS before, and the user's default and
 *             conversations move RETIREMENT_MOVE_DAYS before — while the
 *             deployment still answers, not after it starts failing.
 *  - `alias`  its deployment already runs another model that is served
 *             under its own name. Nothing is left of the old model but the
 *             label, so it moves at once.
 *  - `forced` it is listed in FORCED_MODEL_RETIREMENTS. Moves at once.
 *
 * The move is silent (the notice is the announcement) and each retirement
 * EVENT is applied once per browser: every reason that holds is a trigger,
 * the applied triggers are remembered per model, and a user who picks the
 * model again afterwards keeps it until a trigger they have NOT been moved
 * for appears (see planRetirementMoves).
 */
export const RETIREMENT_NOTICE_DAYS = 30;
export const RETIREMENT_MOVE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Models to move off now, whatever Azure says about them, and the model
 * each must land on — the one manual input, for decisions Azure's schedule
 * cannot express. The successor is PINNED: while it is not usable by a user
 * (hidden by a limit, not deployed) their move waits rather than landing on
 * whatever else the list offers.
 *
 * 2026-10-02: gpt-5.4 is the default everywhere, and all three of these
 * should land on it. Left to the automatic rules they would not: the US
 * `gpt-5.2` deployment is a real gpt-5.2 Azure keeps until 2027-06,
 * `gpt-chat-latest` is not due until 2026-12, and `gpt-5.2-chat` would
 * follow its alias to `gpt-chat-latest`.
 *
 * Temporary: empty this map one release after it ships. Emptying it moves
 * nobody a second time — the alias and date triggers that also hold today
 * are recorded together with `forced`.
 */
export const FORCED_MODEL_RETIREMENTS: Readonly<Record<string, string>> = {
  [OpenAIModelID.GPT_5_2_CHAT]: OpenAIModelID.GPT_5_4,
  [OpenAIModelID.GPT_5_2]: OpenAIModelID.GPT_5_4,
  [OpenAIModelID.GPT_CHAT_LATEST]: OpenAIModelID.GPT_5_4,
};

const FORCED_TRIGGER = 'forced';

export type RetirementReason = 'forced' | 'alias' | 'date';

export interface RetirementSignal {
  /** `notice`: warn and offer the switch. `move`: switch automatically. */
  phase: 'notice' | 'move';
  /** The leading reason (forced, then alias, then date). */
  reason: RetirementReason;
  /**
   * Every retirement event that currently calls for a MOVE — what once-ness
   * is keyed on. Empty in the `notice` phase. All of them are recorded when
   * a move is applied, so a reason that merely stops being masked by another
   * (the forced list is emptied, an alias target drops out of the list for
   * an hour) is not mistaken for a new event.
   */
  triggers: string[];
  /** When Azure stops serving the version, if that is within the notice window. */
  retiresAt?: string;
  /** When the automatic date move happens (or happened). */
  movesAt?: string;
}

export interface ModelRetirement {
  model: OpenAIModel;
  signal: RetirementSignal;
  successor: OpenAIModel;
}

type RetirementFacts = Pick<
  OpenAIModel,
  'id' | 'retiresAt' | 'deploymentModelName' | 'successorId'
>;

/**
 * The retirement facts of the deployment that actually SERVES a
 * conversation on `model`. US and EU are separate deployments: the same
 * model id can be a real gpt-5.2 in one and repointed at gpt-5.4 in the
 * other, or retire months apart.
 *
 * `routedRegion` is where the conversation is routed — the user's home
 * region, or the region a conversation is pinned to (`hostedRegion`). When
 * the model has no instance there it is served from wherever it is hosted
 * (a US user on an EU-only model is routed to the EU). Lists without
 * per-region facts (the static fallback, single-region tests) use the
 * model's own.
 */
export function retirementFacts(
  model: OpenAIModel,
  routedRegion: UserRegion | null | undefined,
): RetirementFacts {
  const hosted = model.hostedIn;
  const servingRegion =
    routedRegion && (!hosted?.length || hosted.includes(routedRegion))
      ? routedRegion
      : hosted?.[0];
  const facts =
    (servingRegion && model.retirementByRegion?.[servingRegion]) || model;
  return {
    id: model.id,
    retiresAt: facts.retiresAt,
    deploymentModelName: facts.deploymentModelName,
    successorId: facts.successorId,
  };
}

/** Why (and how urgently) a model is leaving, or null when it is staying. */
export function getRetirementSignal(
  model: RetirementFacts,
  servedIds: ReadonlySet<string>,
  now: number,
): RetirementSignal | null {
  const forced = model.id in FORCED_MODEL_RETIREMENTS;

  // Only an alias of a model that is ITSELF on offer: a deployment merely
  // named differently from its model (a custom deployment name) is not one.
  const underlying = model.deploymentModelName;
  const alias =
    !!underlying && underlying !== model.id && servedIds.has(underlying);

  const retiresAtMs = model.retiresAt ? Date.parse(model.retiresAt) : NaN;
  const dated =
    !Number.isNaN(retiresAtMs) &&
    retiresAtMs - now <= RETIREMENT_NOTICE_DAYS * DAY_MS;
  const movesAtMs = retiresAtMs - RETIREMENT_MOVE_DAYS * DAY_MS;
  const dateMove = dated && now >= movesAtMs;

  if (!forced && !alias && !dated) return null;

  const triggers = [
    ...(forced ? [FORCED_TRIGGER] : []),
    ...(alias ? [`alias:${underlying}`] : []),
    ...(dateMove ? [model.retiresAt as string] : []),
  ];
  return {
    phase: triggers.length > 0 ? 'move' : 'notice',
    reason: forced ? 'forced' : alias ? 'alias' : 'date',
    triggers,
    ...(dated
      ? {
          retiresAt: model.retiresAt,
          movesAt: new Date(movesAtMs).toISOString(),
        }
      : {}),
  };
}

// Family metadata is static for known ids; discovered-only models carry
// their own (same rule as the picker's groupIntoFamilyUnits).
const catalogMeta = (model: OpenAIModel): OpenAIModel =>
  OpenAIModels[model.id as OpenAIModelID] ?? model;

/**
 * The closest model to `model` within its own family and variant: a
 * same-version sibling (another sub-variant) first, else the policy default
 * when it belongs to the variant, else the NEAREST newer version, else the
 * nearest older one. Nearest rather than newest on purpose — the newest
 * model of a line is usually its most expensive, and a silent move should
 * change as little as it can.
 */
function closestInVariant(
  model: OpenAIModel,
  sameVariant: OpenAIModel[],
  policyDefault: OpenAIModel | undefined,
): OpenAIModel | undefined {
  if (sameVariant.length === 0) return undefined;
  const rank = versionRank(catalogMeta(model));
  const rankOf = (m: OpenAIModel) => versionRank(catalogMeta(m));
  const siblings = sameVariant.filter((m) => rankOf(m) === rank);
  if (siblings.length > 0) return seriesRepresentative(siblings);
  if (policyDefault && sameVariant.includes(policyDefault)) {
    return policyDefault;
  }
  const newer = sameVariant.filter((m) => rankOf(m) > rank);
  const pool = newer.length > 0 ? newer : sameVariant;
  const nearest = (newer.length > 0 ? Math.min : Math.max)(...pool.map(rankOf));
  return seriesRepresentative(pool.filter((m) => rankOf(m) === nearest));
}

/**
 * Where a leaving model's users go.
 *
 * A candidate must be served to this user, selectable in their region, not
 * itself leaving (else users would be moved twice), and must not change how
 * their data is handled: never from an Azure-hosted model onto an
 * externally-hosted one, and never from a model with a home-region instance
 * onto one that only exists in the other region.
 *
 * A FORCED model goes to its pinned successor, and waits (null) while that
 * is unavailable — unless it is also leaving for a reason of its own, in
 * which case it has to go somewhere and the order below applies:
 *  1. the deployment's `ui-successor` tag;
 *  2. for an alias, the model the deployment actually runs;
 *  3. within the same family AND variant: a same-version sibling, else
 *     the policy default if it is there, else the closest version (see
 *     closestInVariant) — a retiring Mini goes to the next Mini, not to the
 *     flagship;
 *  4. the policy default, when it is in the same family;
 *  5. the family's own default (what its picker row fronts);
 *  6. the region default.
 * "Policy default" is the configured cost-policy model
 * (getPolicyDefaultModel), deliberately not the "latest standard GPT" that
 * getDefaultModel falls back to: that one is only the last resort (6).
 */
export function resolveSuccessor(
  model: OpenAIModel,
  served: OpenAIModel[],
  region: UserRegion | null | undefined,
  now: number,
  /** Where the conversations being moved are routed; defaults to `region`. */
  routedRegion: UserRegion | null | undefined = region,
): OpenAIModel | null {
  const servedIds = new Set(served.map((m) => m.id));
  const signalOf = (m: OpenAIModel) =>
    getRetirementSignal(retirementFacts(m, routedRegion), servedIds, now);
  const own = retirementFacts(model, routedRegion);
  const keepsHosting = (m: OpenAIModel) =>
    getModelHosting(catalogMeta(m)) === 'azure' ||
    getModelHosting(catalogMeta(model)) === 'external';
  const hasHomeInstance = (m: OpenAIModel) =>
    !routedRegion || !m.hostedIn?.length || m.hostedIn.includes(routedRegion);
  const keepsRegion = (m: OpenAIModel) =>
    !hasHomeInstance(model) || hasHomeInstance(m);
  const candidates = served.filter(
    (m) =>
      m.id !== model.id &&
      !m.isDisabled &&
      isModelSelectableInRegion(m, region) &&
      keepsHosting(m) &&
      keepsRegion(m) &&
      signalOf(m) === null,
  );
  const candidate = (id: string | undefined) =>
    id ? candidates.find((m) => m.id === id) : undefined;

  const pinned = FORCED_MODEL_RETIREMENTS[model.id];
  if (pinned) {
    const pinnedSuccessor = candidate(pinned);
    if (pinnedSuccessor) return pinnedSuccessor;
    // Forced is its only reason to move: wait for the pinned successor.
    if ((signalOf(model)?.triggers.length ?? 0) <= 1) return null;
  }

  const tagged = candidate(own.successorId);
  if (tagged) return tagged;

  const underlying = candidate(own.deploymentModelName);
  if (underlying) return underlying;

  const { series, variant } = catalogMeta(model);
  const policyDefault = candidate(getPolicyDefaultModel(candidates, region));
  const family = series
    ? candidates
        .filter((m) => catalogMeta(m).series === series)
        .sort((a, b) => versionRank(b) - versionRank(a))
    : [];
  const sameVariant = family.filter(
    (m) => (catalogMeta(m).variant ?? '') === (variant ?? ''),
  );
  return (
    closestInVariant(model, sameVariant, policyDefault) ??
    (policyDefault && family.includes(policyDefault)
      ? policyDefault
      : undefined) ??
    seriesRepresentative(family) ??
    policyDefault ??
    candidate(getDefaultModel(candidates, region)) ??
    null
  );
}

export interface RetirementContext {
  /** The list /api/models served this user (settingsStore.models). */
  models: OpenAIModel[];
  region: UserRegion | null | undefined;
  now: number;
  /**
   * Evaluate for conversations routed to this region instead of the user's
   * home region — a conversation pinned to the other region's instance
   * (`hostedRegion`). See retirementFacts.
   */
  routedRegion?: UserRegion | null;
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
  routedRegion = region,
}: RetirementContext): ModelRetirement[] {
  const servedIds = new Set(models.map((m) => m.id));
  const unservedForced = Object.keys(FORCED_MODEL_RETIREMENTS)
    .filter((id) => !servedIds.has(id))
    .map((id) => OpenAIModels[id as OpenAIModelID])
    .filter((m): m is OpenAIModel => m !== undefined);

  const retirements: ModelRetirement[] = [];
  for (const model of [...models, ...unservedForced]) {
    const signal = getRetirementSignal(
      retirementFacts(model, routedRegion),
      servedIds,
      now,
    );
    if (!signal) continue;
    const successor = resolveSuccessor(
      model,
      models,
      region,
      now,
      routedRegion,
    );
    if (successor) retirements.push({ model, signal, successor });
  }
  return retirements;
}

/**
 * What to tell someone whose conversation is on a model with a retirement
 * DATE inside the notice window — in the `notice` phase ("moves on …") and
 * also in the `move` phase, where a conversation can still be on the model
 * because its owner picked it again after the move. Forced and alias moves
 * have no date to announce and return null.
 */
export function getRetirementNotice(
  modelId: string | undefined,
  context: RetirementContext,
): ModelRetirement | null {
  if (!modelId) return null;
  return (
    listRetirements(context).find(
      (r) => r.model.id === modelId && r.signal.retiresAt !== undefined,
    ) ?? null
  );
}

/** One applied move, as persisted in `settingsStore.modelRetirementsApplied`. */
export interface AppliedRetirement {
  /** Every trigger the user has been moved for. */
  triggers: string[];
  /** ISO instant of the last move for a NEW trigger. */
  appliedAt: string;
}

export interface RetirementMove extends ModelRetirement {
  /**
   * `event`: a trigger this browser has not applied — the saved default and
   * EVERY conversation on the model move. `catchUp`: nothing new, but
   * conversations that predate the applied move may have arrived since (a
   * restored backup, an import, a sync pull, a write that failed) and those
   * move; anything touched after `appliedAt` is the user's own choice.
   */
  kind: 'event' | 'catchUp';
  /** `catchUp` only: the instant conversations must predate. */
  appliedAt?: string;
}

/** The moves owed in this browser, given what it has already applied. */
export function planRetirementMoves(
  context: RetirementContext,
  applied: Readonly<Record<string, AppliedRetirement>>,
): RetirementMove[] {
  const moves: RetirementMove[] = [];
  for (const retirement of listRetirements(context)) {
    if (retirement.signal.phase !== 'move') continue;
    const done = applied[retirement.model.id];
    const isNewEvent = retirement.signal.triggers.some(
      (trigger) => !done?.triggers.includes(trigger),
    );
    moves.push(
      isNewEvent
        ? { ...retirement, kind: 'event' }
        : { ...retirement, kind: 'catchUp', appliedAt: done.appliedAt },
    );
  }
  return moves;
}

/**
 * The conversation changes that come with moving onto `target`. Mirrors
 * what picking the model in ModelSelect does: an AGENT search mode falls
 * back to INTELLIGENT when the target has no Foundry agent. A pinned
 * `hostedRegion` the target is not hosted in is dropped, or the request
 * would be routed to a region with no such deployment. `threadId` is left
 * alone — it is the handle the conversation's Foundry thread is deleted by.
 */
export function successorUpdates(
  conversation: Pick<Conversation, 'defaultSearchMode' | 'hostedRegion'>,
  target: OpenAIModel,
): Partial<Conversation> {
  return {
    model: target,
    ...(conversation.defaultSearchMode === SearchMode.AGENT && !target.agentId
      ? { defaultSearchMode: SearchMode.INTELLIGENT }
      : {}),
    ...(conversation.hostedRegion &&
    target.hostedIn?.length &&
    !target.hostedIn.includes(conversation.hostedRegion)
      ? { hostedRegion: undefined }
      : {}),
  };
}

const timestampOf = (conversation: Conversation): number =>
  Date.parse(conversation.updatedAt ?? conversation.createdAt ?? '');

/**
 * `updatedAt` advanced by the smallest step that still differs, or
 * undefined for a conversation with no timestamp at all.
 *
 * The per-conversation storage only writes a conversation whose `updatedAt`
 * changed, so a move has to touch it — but stamping "now" would reorder the
 * folder view, show every moved conversation as edited this minute, and (the
 * dangerous part) make this copy win a last-writer-wins backup merge against
 * a newer copy on another device. A timestamp-less conversation therefore
 * keeps none: its move lives in memory and is re-derived on each load (see
 * shouldMove) until the user touches it, which stamps it for real.
 */
function nudgedUpdatedAt(conversation: Conversation): string | undefined {
  const previous = timestampOf(conversation);
  return Number.isNaN(previous)
    ? conversation.updatedAt
    : new Date(previous + 1).toISOString();
}

/** Whether `move` applies to a conversation that is on the leaving model. */
function shouldMove(
  conversation: Conversation,
  move: RetirementMove,
  defaultModelId: string | undefined,
): boolean {
  if (move.kind === 'event') return true;
  const timestamp = timestampOf(conversation);
  if (Number.isNaN(timestamp)) {
    // Never touched. It is on the leaving model either because it predates
    // the move, or because the user made that model their default again
    // afterwards — the one case to leave alone.
    return defaultModelId !== move.model.id;
  }
  return timestamp < Date.parse(move.appliedAt ?? '');
}

/**
 * Applies `moves` to conversations: each one on a leaving model goes to
 * that model's successor when the move covers it (see RetirementMove.kind).
 * A conversation pinned to a region (`hostedRegion`) is judged by
 * `pinnedMoves` for that region when given — the plan evaluated with that
 * region's deployments — and by `moves` otherwise.
 * Returns the SAME array when nothing moved, so the caller can skip the
 * store write. A remembered pre-agent model (`agentPrevModelId`) follows the
 * same rule, so detaching a Foundry agent later doesn't restore the retired
 * model.
 */
export function moveConversationsToSuccessors(
  conversations: Conversation[],
  moves: readonly RetirementMove[],
  defaultModelId?: string,
  pinnedMoves?: Partial<Record<UserRegion, readonly RetirementMove[]>>,
): Conversation[] {
  const index = (list: readonly RetirementMove[]) =>
    new Map(list.map((move) => [move.model.id, move]));
  const byModel = index(moves);
  const byPinnedRegion = new Map(
    Object.entries(pinnedMoves ?? {}).map(([pinned, list]) => [
      pinned,
      index(list ?? []),
    ]),
  );
  const moveFor = (modelId: string | undefined, conversation: Conversation) => {
    const plan =
      (conversation.hostedRegion &&
        byPinnedRegion.get(conversation.hostedRegion)) ||
      byModel;
    const move = modelId ? plan.get(modelId) : undefined;
    return move && shouldMove(conversation, move, defaultModelId)
      ? move
      : undefined;
  };

  let moved = false;
  const next = conversations.map((conversation) => {
    const move = moveFor(conversation.model?.id, conversation);
    const restoreMove = moveFor(conversation.agentPrevModelId, conversation);
    if (!move && !restoreMove) return conversation;
    moved = true;
    return {
      ...conversation,
      ...(move ? successorUpdates(conversation, move.successor) : {}),
      ...(restoreMove ? { agentPrevModelId: restoreMove.successor.id } : {}),
      updatedAt: nudgedUpdatedAt(conversation),
    };
  });
  return moved ? next : conversations;
}

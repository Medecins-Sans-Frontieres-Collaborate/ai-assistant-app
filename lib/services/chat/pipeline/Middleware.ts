import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  AgentAccessService,
  emitAccessAudit,
} from '@/lib/services/agentAccess/AgentAccessService';
import { PROMPT_AGENT_SOURCE } from '@/lib/services/agentAccess/types';
import { AgentDiscoveryService } from '@/lib/services/agents/AgentDiscoveryService';
import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';
import { UserTokenProvider } from '@/lib/services/auth/UserTokenProvider';
import { createAppIdentityCredential } from '@/lib/services/auth/appIdentityCredential';
import { createFoundryTokenCredential } from '@/lib/services/auth/foundryCredential';
import { InputValidator } from '@/lib/services/chat/validators/InputValidator';
import { resolveCustomSourceModel } from '@/lib/services/models/customModelSources';
import { ModelSelector, RateLimiter } from '@/lib/services/shared';

import {
  SystemPromptOptions,
  buildSystemPrompt,
} from '@/lib/utils/app/systemPrompt';
import { getUserDisplayName } from '@/lib/utils/app/user/displayName';
import { getMessageContentTypes } from '@/lib/utils/server/chat/chat';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import {
  isValidFoundryResourcePath,
  stripToAccountPath,
} from '@/lib/utils/shared/armPath';
import { isAllowedFoundryHost } from '@/lib/utils/shared/foundryHostAllowlist';

import { ChatBody } from '@/types/chat';
import { ErrorCode, PipelineError } from '@/types/errors';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { ChatContext } from './ChatContext';

import { auth, getAccessTokenForOBO } from '@/auth';
import { TokenCredential } from '@azure/identity';

/**
 * Middleware function that processes a request and returns partial ChatContext.
 */
export type Middleware = (req: NextRequest) => Promise<Partial<ChatContext>>;

/**
 * Applies a chain of middleware functions to build the initial ChatContext.
 *
 * @param req - The incoming NextRequest
 * @param middlewares - Array of middleware functions
 * @returns The constructed ChatContext
 */
export async function applyMiddleware(
  req: NextRequest,
  middlewares: Middleware[],
): Promise<ChatContext> {
  let context: Partial<ChatContext> = {};

  for (const middleware of middlewares) {
    const partial = await middleware(req);
    context = { ...context, ...partial };
  }

  // Validate required fields
  if (!context.session)
    throw new Error('Authentication middleware did not set session');
  if (!context.model)
    throw new Error('Request parsing middleware did not set model');
  if (!context.messages)
    throw new Error('Request parsing middleware did not set messages');

  return context as ChatContext;
}

/**
 * Authentication middleware.
 * Validates the user session and adds it to context.
 */
export const authMiddleware: Middleware = async (req) => {
  const session: Session | null = await auth();

  if (!session) {
    throw PipelineError.critical(
      ErrorCode.AUTH_FAILED,
      'Unauthorized: No valid session found',
    );
  }

  return {
    session,
    user: session.user,
  };
};

/**
 * Rate limiting middleware factory.
 * Checks if the user has exceeded their rate limit.
 *
 * Requires session to be set by authMiddleware.
 */
export const createRateLimitMiddleware = (
  context: Partial<ChatContext>,
): Partial<ChatContext> => {
  if (!context.user?.id) {
    throw PipelineError.critical(
      ErrorCode.AUTH_FAILED,
      'Rate limiting requires authenticated user',
    );
  }

  // Get rate limiter instance (100 requests per minute by default)
  const rateLimiter = RateLimiter.getInstance(100, 1);

  // Enforce rate limit (throws if exceeded)
  const rateLimitResult = rateLimiter.enforceLimit(context.user.id);

  console.log(
    `[RateLimitMiddleware] User ${context.user.id}: ${rateLimitResult.remaining}/${rateLimitResult.limit} remaining`,
  );

  return {
    // Store rate limit info in context for potential use in response headers
    rateLimitInfo: rateLimitResult,
  };
};

/**
 * Request parsing middleware.
 * Parses the request body and validates it using InputValidator.
 */
export const requestParsingMiddleware: Middleware = async (req) => {
  try {
    const rawBody = await req.json();

    // Validate request size (10MB for JSON body - actual files uploaded separately)
    const validator = new InputValidator();
    if (!validator.validateRequestSize(rawBody)) {
      throw PipelineError.critical(
        ErrorCode.VALIDATION_FAILED,
        'Request body too large (max 10MB)',
      );
    }

    // Validate and parse body
    const body = validator.validateChatRequest(rawBody);

    const {
      model,
      messages,
      prompt,
      temperature,
      stream = true,
      reasoningEffort,
      verbosity,
      botId,
      searchMode,
      hostedRegion,
      threadId,
      forcedAgentType,
      tone,
      streamingSpeed,
      includeUserInfoInPrompt,
      preferredName,
      userContext,
      displayNamePreference,
      customDisplayName,
      agentSourcePath,
      modelSourcePath,
      approvalResponses,
      mcpServers,
      mcpPendingToolCalls,
      mcpLoopRound,
      extraction,
      conversationSummary,
      memories,
    } = body;

    if (mcpServers?.length) {
      // Redacted summary ONLY — entries can carry auth tokens.
      console.log('[Middleware] MCP servers on request:', {
        count: mcpServers.length,
        catalogKeys: mcpServers
          .map((s: { catalogKey?: string }) => s.catalogKey)
          .filter(Boolean),
        hasCustom: mcpServers.some(
          (s: { catalogKey?: string }) => !s.catalogKey,
        ),
        pendingToolCalls: mcpPendingToolCalls?.length ?? 0,
        loopRound: mcpLoopRound ?? 0,
      });
    }

    if (tone) {
      console.log('[Middleware] Received tone from client:', {
        id: tone.id,
        name: tone.name,
        hasVoiceRules: !!tone.voiceRules,
      });
    }

    // Store raw user prompt - system prompt will be built in buildChatContext
    // after auth middleware has provided user info
    return {
      model,
      messages,
      rawUserPrompt: prompt,
      includeUserInfoInPrompt,
      preferredName,
      userContext,
      displayNamePreference,
      customDisplayName,
      agentSourcePath,
      modelSourcePath,
      approvalResponses,
      mcpServers,
      mcpPendingToolCalls,
      mcpLoopRound,
      temperature,
      stream,
      reasoningEffort,
      verbosity,
      botId,
      searchMode,
      hostedRegion,
      threadId,
      forcedAgentType,
      tone,
      streamingSpeed,
      // Structured extraction payload (optional). Up to 3 recipes; the
      // ExtractionEnricher composes the JSON-schema response format.
      extraction,
      conversationSummary,
      memories,
    };
  } catch (error) {
    if (error instanceof PipelineError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw PipelineError.critical(
        ErrorCode.VALIDATION_FAILED,
        'Invalid JSON in request body',
        { originalError: error.message },
        error,
      );
    }
    throw PipelineError.critical(
      ErrorCode.VALIDATION_FAILED,
      'Failed to parse request body',
      { originalError: error instanceof Error ? error.message : String(error) },
      error instanceof Error ? error : undefined,
    );
  }
};

/**
 * Factory for content analysis middleware that needs access to parsed messages.
 */
export const createContentAnalysisMiddleware = (
  context: Partial<ChatContext>,
): Partial<ChatContext> => {
  if (!context.messages) {
    throw new Error('Messages must be parsed before content analysis');
  }

  const lastMessage = context.messages[context.messages.length - 1];
  const contentTypes = getMessageContentTypes(lastMessage.content);

  return {
    contentTypes,
    hasFiles: contentTypes.has('file') || contentTypes.has('audio'),
    hasImages: contentTypes.has('image'),
    hasAudio: contentTypes.has('audio'), // Audio files detected separately by analyzer
  };
};

/**
 * Factory for system prompt middleware that builds the final system prompt.
 * Runs after auth so user info is available if needed.
 */
export const createSystemPromptMiddleware = (
  context: Partial<ChatContext>,
): Partial<ChatContext> => {
  const options: SystemPromptOptions = {
    userPrompt: context.rawUserPrompt,
    conversationSummary: context.conversationSummary,
    memories: context.memories,
  };

  // Add user info if enabled and user is available
  if (context.includeUserInfoInPrompt && context.user) {
    // Compute effective name with fallback chain:
    // 1. Chat Settings preferredName (explicit override)
    // 2. General Settings derived name (displayNamePreference + customDisplayName)
    // 3. Profile displayName (fallback)
    const effectiveName =
      context.preferredName ||
      getUserDisplayName(
        context.user,
        context.displayNamePreference,
        context.customDisplayName,
      ) ||
      context.user.displayName;

    options.userInfo = {
      name: effectiveName,
      title: context.user.jobTitle,
      email: context.user.mail,
      department: context.user.department,
      additionalContext: context.userContext,
    };
  }

  return {
    systemPrompt: buildSystemPrompt(options),
  };
};

/**
 * A TokenCredential that always throws on use. Installed on fail-closed paths
 * so the Foundry handler cannot silently fall back to its own
 * DefaultAzureCredential — the app identity carries broader RBAC than any
 * individual user and using it would bypass the per-user RBAC guarantee
 * documented in AGENT_ACCESS_MANAGEMENT.md §2.
 */
const createDeniedUserCredential = (): TokenCredential => ({
  getToken: async () => {
    throw new Error(
      'User identity required: unable to acquire OBO token. Sign out and back in, then try again.',
    );
  },
});

/**
 * Result for a fail-closed exit from credential resolution. In production we
 * install a throwing credential so a Foundry agent never executes under the app
 * identity; in development we leave the credential undefined so the handler's
 * DefaultAzureCredential fallback keeps local workflows working without an OBO
 * setup. An optional resolved endpoint is passed through for logging/context.
 */
const failClosedResult = (foundryEndpoint?: string): Partial<ChatContext> =>
  process.env.NODE_ENV === 'production'
    ? { userCredential: createDeniedUserCredential(), foundryEndpoint }
    : {};

/**
 * Access-control denial for an agent invocation
 * (docs/AGENT_ACCESS_CONTROL.md). This is POLICY, not credential plumbing:
 * unlike `failClosedResult` it blocks in EVERY environment (no dev
 * app-identity leniency) and surfaces an accurate message instead of an
 * opaque credential failure. AGENT_UNAVAILABLE maps to a clean 409 in the
 * chat route's PipelineError handling.
 */
const agentAccessDenied = (
  decision: 'deny' | 'unavailable',
  reason: string,
): PipelineError =>
  PipelineError.critical(
    ErrorCode.AGENT_UNAVAILABLE,
    decision === 'unavailable'
      ? 'Agent access rules are currently unavailable, so this agent cannot be invoked right now. Please try again shortly.'
      : 'Access to this agent is restricted. Contact your administrator if you believe you should have access.',
    { accessDecision: decision, accessReason: reason },
  );

/**
 * 409-style conflict for a custom-source (byom) model that cannot be invoked.
 * Unlike agents, byom has NO app-identity fallback in any environment: falling
 * back would silently reroute the request to an app-hosted deployment, which
 * violates the byom trust model (the user's own ARM RBAC is the authorization).
 */
const customSourceModelUnavailable = (reason: string): PipelineError =>
  PipelineError.critical(
    ErrorCode.MODEL_UNAVAILABLE,
    'The selected custom-source model is unavailable. Re-select it from its model source and try again.',
    { reason },
  );

/**
 * Resolves credentials + config for a custom-source (byom) model.
 *
 * The client's model object is NEVER trusted (InputValidator strips the
 * routing fields from it anyway) — the gate is the top-level validated
 * `modelSourcePath` plus the `byom-` id prefix, and the served config is
 * re-resolved from live ARM deployment discovery under the user's own OBO
 * token. `resolveCustomSourceModel` also enforces the id/source hash
 * integrity, so a tampered id or a foreign source path resolves to null.
 *
 * PROD fails closed with a 409-style MODEL_UNAVAILABLE on any failure; dev
 * may fall back to the app identity credential so local workflows run
 * without an OBO setup (mirroring the agent-path dev fallback).
 */
const resolveCustomSourceContext = async (
  context: Partial<ChatContext>,
  req: NextRequest,
): Promise<Partial<ChatContext>> => {
  const isProd = process.env.NODE_ENV === 'production';
  const modelId = context.modelId!;
  const modelSourcePath = context.modelSourcePath!;

  if (!isValidFoundryResourcePath(modelSourcePath)) {
    throw customSourceModelUnavailable('invalid_source_path');
  }
  if (!context.session) {
    throw customSourceModelUnavailable('no_session');
  }

  // ARM token under the user's identity — ARM RBAC on the source account is
  // the authorization for byom models.
  let appAccessToken: string | null = null;
  let devFallbackCredential: TokenCredential | undefined;
  let armToken: string;
  try {
    appAccessToken = await getAccessTokenForOBO(req);
    if (!appAccessToken) throw new Error('No OBO token');
    armToken =
      await UserTokenProvider.getInstance().getArmToken(appAccessToken);
  } catch (e) {
    if (isProd) {
      console.error(
        '[CredentialMiddleware] OBO ARM token failed in prod for custom-source model; failing closed:',
        e instanceof Error ? e.message : e,
      );
      throw customSourceModelUnavailable('obo_failed');
    }
    console.warn(
      '[CredentialMiddleware] OBO unavailable (dev), resolving custom-source model with app identity',
    );
    devFallbackCredential = await createAppIdentityCredential();
    const armTokenResponse = await devFallbackCredential.getToken(
      'https://management.azure.com/.default',
    );
    if (!armTokenResponse) {
      throw customSourceModelUnavailable('no_arm_token');
    }
    armToken = armTokenResponse.token;
  }

  let resolved;
  try {
    resolved = await resolveCustomSourceModel(
      armToken,
      modelId,
      modelSourcePath,
    );
  } catch (e) {
    // Discovery errors (ARM 4xx/5xx, network) propagate from the resolver —
    // surface them as the same clean conflict instead of an opaque 500.
    console.error(
      '[CredentialMiddleware] Custom-source model discovery failed:',
      e instanceof Error ? e.message : e,
    );
    throw customSourceModelUnavailable('discovery_failed');
  }
  if (!resolved) {
    // Hash-integrity mismatch, or the deployment doesn't exist / isn't
    // visible to this identity's ARM RBAC. Surface a clean conflict in every
    // environment — there is nothing valid to fall back to.
    throw customSourceModelUnavailable('not_resolved');
  }

  // Account data-plane base derived from the validated ARM path (never from
  // the request body). Allow-list checked before binding any credential.
  const accountPath = stripToAccountPath(modelSourcePath);
  const accountName = accountPath.slice(accountPath.lastIndexOf('/') + 1);
  const foundryEndpoint = `https://${accountName}.services.ai.azure.com`;
  if (!isAllowedFoundryHost(foundryEndpoint)) {
    console.error(
      `[CredentialMiddleware] Refusing to bind credential to disallowed custom-source host: ${foundryEndpoint}`,
    );
    throw customSourceModelUnavailable('disallowed_host');
  }

  let userCredential: TokenCredential;
  try {
    if (!appAccessToken) throw new Error('No OBO token');
    const foundryToken =
      await UserTokenProvider.getInstance().getFoundryToken(appAccessToken);
    userCredential = createFoundryTokenCredential(foundryToken);
  } catch (e) {
    if (isProd) {
      console.error(
        `[CredentialMiddleware] Foundry OBO failed in prod for custom-source host ${foundryEndpoint}; failing closed:`,
        e instanceof Error ? e.message : e,
      );
      throw customSourceModelUnavailable('obo_failed');
    }
    console.log(
      `[CredentialMiddleware] Foundry OBO unavailable (dev), using app identity for ${foundryEndpoint}`,
    );
    userCredential =
      devFallbackCredential ?? (await createAppIdentityCredential());
  }

  console.log(
    `[CredentialMiddleware] Custom-source model resolved: ${sanitizeForLog(resolved.id)} @ ${foundryEndpoint}`,
  );

  // Overwrite model/modelId with the server-resolved config — downstream
  // stages must never execute against the client-supplied model object.
  return {
    model: resolved,
    modelId: resolved.id,
    foundryEndpoint,
    userCredential,
  };
};

/**
 * Factory for credential middleware that acquires OBO credentials for Foundry agent calls.
 * Only runs when the selected model is a Foundry agent — standard model calls don't need per-user auth.
 *
 * Acquires:
 * - A Foundry-scoped OBO token (wrapped as TokenCredential) for agent invocations
 * - The regional Foundry endpoint based on user's region (GDPR compliance)
 */
export const createCredentialMiddleware = async (
  context: Partial<ChatContext>,
  req: NextRequest,
): Promise<Partial<ChatContext>> => {
  const accessService = AgentAccessService.getInstance();

  // Access guard for prompt-agent invocations (MANDATORY — botId is
  // client-controlled and discovery filtering is UX only). Runs FIRST,
  // before the byom early-return and the Foundry classification below, so
  // NO model-classification path can carry a prompt-agent botId past the
  // guard: a client pairing a restricted prompt botId with a byom- model id
  // or a Foundry-shaped model object must still be evaluated here.
  // Re-resolves from botId so the guard holds even for contexts that
  // skipped model selection. Ids are server-generated `prompt-<hex>`
  // (lib/services/agentAccess/types.ts), so the prefix check is reliable
  // and keeps static RAG botIds (e.g. 'msf_communications') off the
  // access-service path entirely.
  // Mirrors the Foundry guard: deny AND 'unavailable' (no last-known-good
  // ruleset) block in EVERY environment — POLICY, not credential plumbing.
  if (
    accessService.isEnabled() &&
    (context.promptAgent || context.botId?.startsWith('prompt-'))
  ) {
    await accessService.ensureFresh();
    const promptAgent =
      context.promptAgent ??
      (context.botId ? accessService.getPromptAgentById(context.botId) : null);
    if (!promptAgent && accessService.getSnapshot().rulesUnavailable) {
      // Fail closed while NO snapshot was ever loaded (cold start + storage
      // outage): the botId claims a prompt agent but neither the record nor
      // the rules can be verified, so block — same contract as the Foundry
      // guard — instead of silently degrading to a vanilla chat rendered
      // under the persona's name. When a snapshot IS present, an
      // unknown/deleted `prompt-` botId falls through silently below — same
      // silent-degrade as removed static agents.
      emitAccessAudit({
        userMail: context.user?.mail,
        agentName: context.botId!,
        source: PROMPT_AGENT_SOURCE,
        decision: 'unavailable',
        reason: 'rules-unavailable',
      });
      console.error(
        '[CredentialMiddleware] Agent access unavailable (rules-unavailable) for prompt-agent invocation; blocking',
      );
      throw agentAccessDenied('unavailable', 'rules-unavailable');
    }
    if (promptAgent) {
      const decision = accessService.evaluateAccess({
        userMail: context.user?.mail,
        source: PROMPT_AGENT_SOURCE,
        agentName: promptAgent.id,
      });
      emitAccessAudit({
        userMail: context.user?.mail,
        agentName: promptAgent.id,
        source: PROMPT_AGENT_SOURCE,
        decision: decision.decision,
        reason: decision.reason,
      });
      if (decision.decision !== 'allow') {
        console.error(
          `[CredentialMiddleware] Agent access ${decision.decision} (${decision.reason}) for prompt-agent invocation; blocking`,
        );
        throw agentAccessDenied(decision.decision, decision.reason);
      }
    }
  }

  // Custom-source (byom) models: gate on the top-level validated
  // modelSourcePath + the byom- id prefix — never on flags inside the parsed
  // model object (InputValidator strips them from the client body).
  if (context.modelId?.startsWith('byom-')) {
    // A byom id with no source path can never be resolved and must NOT fall
    // through to standard routing (in any environment): the client-supplied
    // placeholder config would execute against the app's default clients and
    // the DeploymentNotFound fallback would silently reroute to an app model.
    if (!context.modelSourcePath) {
      throw customSourceModelUnavailable('missing_source_path');
    }
    return resolveCustomSourceContext(context, req);
  }

  // Only acquire OBO credentials for Foundry agent calls
  const isFoundryAgent =
    (context.model?.isOrganizationAgent === true ||
      context.modelId?.startsWith('foundry-')) &&
    !!context.model?.agentId;

  if (!isFoundryAgent) {
    // Access guard for agent-mode invocations that are NOT classified as
    // Foundry agents (docs/AGENT_ACCESS_CONTROL.md). A client can send an
    // `org-`/`custom-` model id with an `agentId` while omitting
    // `isOrganizationAgent`: that skips the Foundry branch below, yet
    // createModelSelectionMiddleware still sets agentMode, AgentEnricher
    // promotes it to executionStrategy='agent', and AIFoundryAgentHandler
    // falls back to the app's default endpoint + DefaultAzureCredential. So
    // every agentMode + agentId invocation must be evaluated here too. These
    // paths never resolve a verified source path, so the unresolved-source
    // semantics apply (source: null — the user must satisfy every rule
    // matching this agentName under any source). byom- models returned
    // earlier and stay out of scope by design. When the feature is disabled,
    // isEnabled() is false and none of this runs.
    const nonFoundryAgentName = context.model?.agentId;
    if (context.agentMode && nonFoundryAgentName) {
      if (accessService.isEnabled()) {
        await accessService.ensureFresh();
        const decision = accessService.evaluateAccess({
          userMail: context.user?.mail,
          source: null,
          agentName: nonFoundryAgentName,
        });
        emitAccessAudit({
          userMail: context.user?.mail,
          agentName: nonFoundryAgentName,
          source: null,
          decision: decision.decision,
          reason: decision.reason,
        });
        if (decision.decision !== 'allow') {
          console.error(
            `[CredentialMiddleware] Agent access ${decision.decision} (${decision.reason}) for non-Foundry-classified agent invocation; blocking`,
          );
          throw agentAccessDenied(decision.decision, decision.reason);
        }
      }
    }

    // The prompt-agent access guard already ran at the top of this
    // middleware (before any model classification), so nothing else to
    // check for standard-model requests.
    return {};
  }

  if (!context.session) {
    console.warn(
      '[CredentialMiddleware] No session available for OBO token acquisition',
    );
    // Fail closed in prod: a Foundry agent must not run under the app identity.
    return failClosedResult();
  }

  try {
    // Acquire the app's OBO access token once — both lazy discovery and the
    // credential binding below need it, and the fetch is the same either way.
    const appAccessToken = await getAccessTokenForOBO(req);

    // Resolve the Foundry endpoint server-side. The request body's
    // `model.foundryEndpoint` is NEVER trusted — using it would let a client
    // redirect their own (or another user's) OBO bearer token to an
    // attacker-controlled host. Instead, we look up the endpoint that was
    // recorded for this specific user when /api/agents discovery succeeded
    // (where ARM RBAC is the trust boundary). Static org agents and the
    // discovery cache fall back to the office/regional default.
    const userMail = context.user?.mail;
    const agentName = context.model?.agentId;
    const region = context.user?.region || 'EU';

    // Validate the body-supplied source-path hint before any use. An invalid
    // path is silently ignored; the resolver falls back to regional default.
    const sourcePath =
      context.agentSourcePath &&
      isValidFoundryResourcePath(context.agentSourcePath)
        ? context.agentSourcePath
        : null;

    const discoveryService = AgentDiscoveryService.getInstance();
    let resolvedEndpoint =
      userMail && agentName && sourcePath
        ? discoveryService.lookupUserAgentEndpoint(
            userMail,
            agentName,
            sourcePath,
          )
        : null;

    // Cache miss path — likely a server restart, or first chat with an agent
    // discovered on another instance. Discover JUST the one source path the
    // client supplied (RBAC enforced by ARM via the user's OBO token). On
    // success we populate cache + retry the lookup; on failure we fall
    // through to the regional default.
    if (!resolvedEndpoint && userMail && agentName && sourcePath) {
      try {
        if (appAccessToken) {
          const armToken =
            await UserTokenProvider.getInstance().getArmToken(appAccessToken);
          const agents = await discoveryService.listUserAgents(
            armToken,
            sourcePath,
          );
          for (const agent of agents) {
            discoveryService.cacheUserAgentEndpoint(
              userMail,
              agent.agentName,
              sourcePath,
              agent.foundryEndpoint,
            );
          }
          resolvedEndpoint = discoveryService.lookupUserAgentEndpoint(
            userMail,
            agentName,
            sourcePath,
          );
        }
      } catch (e) {
        console.warn(
          '[CredentialMiddleware] Lazy discovery failed:',
          e instanceof Error ? e.message : e,
        );
      }
    }

    const fallbackEndpoint = OfficeResolver.getFoundryEndpoint(region);
    const foundryEndpoint = resolvedEndpoint ?? fallbackEndpoint;

    // Defense-in-depth: even though we never source the endpoint from the
    // request body, the discovered endpoint comes from an ARM API response —
    // enforce a strict host allow-list before binding the OBO credential.
    if (!isAllowedFoundryHost(foundryEndpoint)) {
      console.error(
        `[CredentialMiddleware] Refusing to bind OBO credential to disallowed host: ${foundryEndpoint}`,
      );
      // Fail closed in prod rather than letting the handler fall back to the
      // app identity against its own default endpoint.
      return failClosedResult();
    }

    // App-layer agent access guard (docs/AGENT_ACCESS_CONTROL.md). Runs
    // after agentName/sourcePath/endpoint resolution and before ANY
    // credential selection, so the dev app-identity fallback path is also
    // guarded. This re-checks on every invocation — neither the 24h
    // endpoint trust-anchor cache nor lazy discovery can keep a revoked
    // user invoking. 'unavailable' (enabled + no last-known-good ruleset)
    // blocks too. A denial is POLICY, not credential plumbing: it throws an
    // explicit access-denied PipelineError in EVERY environment (no
    // failClosedResult dev carve-out — that leniency is only for OBO/host
    // plumbing failures).
    if (accessService.isEnabled() && agentName) {
      await accessService.ensureFresh();
      // Only trust the client-supplied source path when endpoint resolution
      // verified the agent exists there under the user's own ARM RBAC;
      // otherwise apply the unresolved-source semantics (must satisfy every
      // rule for this agentName under any source).
      const accessSource = resolvedEndpoint ? sourcePath : null;
      const decision = accessService.evaluateAccess({
        userMail,
        source: accessSource,
        agentName,
      });
      emitAccessAudit({
        userMail,
        agentName,
        source: accessSource,
        decision: decision.decision,
        reason: decision.reason,
      });
      if (decision.decision !== 'allow') {
        console.error(
          `[CredentialMiddleware] Agent access ${decision.decision} (${decision.reason}); blocking agent invocation`,
        );
        throw agentAccessDenied(decision.decision, decision.reason);
      }
    }

    // Try OBO first for per-user Foundry access, fall back to DefaultAzureCredential
    let userCredential: TokenCredential | undefined;

    try {
      if (!appAccessToken) throw new Error('No OBO token');

      const tokenProvider = UserTokenProvider.getInstance();
      const foundryToken = await tokenProvider.getFoundryToken(appAccessToken);

      userCredential = createFoundryTokenCredential(foundryToken);

      console.log(
        `[CredentialMiddleware] OBO credential acquired, endpoint: ${foundryEndpoint}`,
      );
    } catch (e) {
      // In production, install a credential that throws on use rather than
      // letting the handler silently fall back to its own DefaultAzureCredential.
      // The handler's fallback runs under the app's identity, which has broader
      // RBAC than any individual user — bypassing the per-user RBAC guarantee
      // in AGENT_ACCESS_MANAGEMENT.md §2. Surface as an auth error to the user.
      // Dev leaves userCredential undefined so the handler's fallback works.
      if (process.env.NODE_ENV === 'production') {
        console.error(
          `[CredentialMiddleware] OBO failed in prod for ${foundryEndpoint}; refusing app-identity fallback:`,
          e instanceof Error ? e.message : e,
        );
        userCredential = createDeniedUserCredential();
      } else {
        console.log(
          `[CredentialMiddleware] OBO unavailable (dev), using default credential for ${foundryEndpoint}`,
        );
      }
    }

    return {
      userCredential,
      foundryEndpoint,
    };
  } catch (error) {
    // Deliberate policy errors (the access-denied throw above) must propagate
    // untouched — downgrading them to failClosedResult would reopen the dev
    // app-identity execution path an access denial is meant to block.
    if (error instanceof PipelineError) {
      throw error;
    }
    console.error(
      '[CredentialMiddleware] Failed to acquire credential:',
      error,
    );
    // Fail closed in prod: any unexpected resolution error must not let the
    // handler fall back to the app identity (per-user RBAC bypass). Dev keeps
    // the DefaultAzureCredential fallback so local workflows still run.
    return failClosedResult();
  }
};

/**
 * Factory for model selection middleware that needs access to model and messages.
 */
export const createModelSelectionMiddleware = async (
  context: Partial<ChatContext>,
): Promise<Partial<ChatContext>> => {
  if (!context.model || !context.messages) {
    throw new Error('Model and messages must be parsed before model selection');
  }

  const modelSelector = new ModelSelector();
  const { modelId, modelConfig } = modelSelector.selectModel(
    context.model,
    context.messages,
  );

  // Determine if we're in agent mode based on:
  // 1. User explicitly requested AGENT search mode
  // 2. Custom agents always use agent mode
  // 3. Organization/Foundry agents with agentId always use agent mode
  //    Check both the model property AND the model ID prefix (the property may
  //    not survive serialization through conversation storage)
  const isOrgAgent =
    modelConfig.isOrganizationAgent === true ||
    modelId.startsWith('foundry-') ||
    modelId.startsWith('org-');
  const agentMode =
    context.searchMode === SearchMode.AGENT ||
    modelConfig.isCustomAgent === true ||
    modelId.startsWith('custom-') ||
    (isOrgAgent && !!modelConfig.agentId);

  const selection: Partial<ChatContext> = {
    modelSelector,
    modelId,
    model: modelConfig,
    agentMode,
  };

  // Prompt-agent resolution (docs/AGENT_ACCESS_CONTROL.md): when the
  // agent-access feature is enabled and botId names a stored prompt agent,
  // record the persona on the context and SWAP the model to the admin-chosen
  // OpenAIModels config, so sdk/deploymentName/tokenLimit are real and the
  // configured model actually executes (unlike static org agents, whose
  // baseModelId is client-side cosmetics riding the DeploymentNotFound
  // fallback chain). agentMode stays as computed above (false — prompt
  // agents never carry an agentId) and model.agentId is NEVER set: that
  // would misroute the request into the Foundry execution path.
  //
  // Scoped to requests whose MODEL actually selects the prompt agent
  // (`org-<botId>`): conversation.bot is sent on every request and survives
  // model switches that don't go through ModelSelect (WorkflowModelSelect /
  // useModelSelection update the model without clearing bot), so a stale
  // botId must never hijack an explicitly selected different model — in
  // particular it must never swap a byom-/foundry- selection onto an
  // app-hosted deployment. The `prompt-` prefix check (ids are
  // server-generated `prompt-<hex>`) also keeps static RAG botIds off the
  // access-service path entirely — no ensureFresh() on their hot path.
  const accessService = AgentAccessService.getInstance();
  if (
    context.botId?.startsWith('prompt-') &&
    modelId === `org-${context.botId}` &&
    accessService.isEnabled()
  ) {
    await accessService.ensureFresh();
    const promptAgent = accessService.getPromptAgentById(context.botId);
    if (promptAgent) {
      selection.promptAgent = promptAgent;
      // Force agentMode off: standard model configs legitimately carry an
      // `agentId` (intelligent-search agent name), and agentMode + agentId
      // would promote the request to executionStrategy='agent' — the exact
      // Foundry misroute a prompt agent must never take.
      selection.agentMode = false;
      const configured = OpenAIModels[promptAgent.modelId as OpenAIModelID] as
        | OpenAIModel
        | undefined;
      if (configured) {
        selection.modelId = configured.id;
        selection.model = configured;
      } else {
        // Admin-pinned model vanished from the config at runtime — keep the
        // existing default-model behavior but make the mismatch loud.
        console.error(
          `[ModelSelectionMiddleware] Prompt agent ${sanitizeForLog(promptAgent.id)} references unknown model '${sanitizeForLog(promptAgent.modelId)}'; keeping default model behavior`,
        );
      }
      console.log(
        `[ModelSelectionMiddleware] Resolved prompt agent ${sanitizeForLog(promptAgent.id)} → model ${sanitizeForLog(selection.modelId ?? modelId)}`,
      );
    }
  }

  return selection;
};

/**
 * Builds the initial ChatContext from a NextRequest.
 * Applies all standard middleware and returns a fully initialized context.
 */
export async function buildChatContext(req: NextRequest): Promise<ChatContext> {
  // Apply initial middleware
  let context = await applyMiddleware(req, [
    authMiddleware,
    requestParsingMiddleware,
  ]);

  // Apply middleware that depends on previous middleware
  context = {
    ...context,
    ...createRateLimitMiddleware(context),
  };

  // Build system prompt after auth (so user info is available)
  context = {
    ...context,
    ...createSystemPromptMiddleware(context),
  };

  context = {
    ...context,
    ...createContentAnalysisMiddleware(context),
  };

  context = {
    ...context,
    ...(await createModelSelectionMiddleware(context)),
  };

  // Acquire per-user OBO credentials for Foundry agent calls (after model selection)
  context = {
    ...context,
    ...(await createCredentialMiddleware(context, req)),
  };

  // Initialize metrics
  context.metrics = {
    startTime: Date.now(),
    stageTimings: new Map(),
  };

  console.log('[Middleware] ChatContext built:', {
    modelId: context.modelId,
    messageCount: context.messages.length,
    contentTypes: Array.from(context.contentTypes),
    hasFiles: context.hasFiles,
    hasImages: context.hasImages,
    hasAudio: context.hasAudio,
    botId: context.botId,
    searchMode: context.searchMode,
    agentMode: context.agentMode,
  });

  return context;
}

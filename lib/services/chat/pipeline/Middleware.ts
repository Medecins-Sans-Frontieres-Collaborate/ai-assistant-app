import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AgentDiscoveryService } from '@/lib/services/agents/AgentDiscoveryService';
import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';
import { UserTokenProvider } from '@/lib/services/auth/UserTokenProvider';
import { InputValidator } from '@/lib/services/chat/validators/InputValidator';
import { ModelSelector, RateLimiter } from '@/lib/services/shared';

import {
  SystemPromptOptions,
  buildSystemPrompt,
} from '@/lib/utils/app/systemPrompt';
import { getUserDisplayName } from '@/lib/utils/app/user/displayName';
import { getMessageContentTypes } from '@/lib/utils/server/chat/chat';
import { isValidFoundryResourcePath } from '@/lib/utils/shared/armPath';
import { isAllowedFoundryHost } from '@/lib/utils/shared/foundryHostAllowlist';

import { ChatBody } from '@/types/chat';
import { ErrorCode, PipelineError } from '@/types/errors';
import { SearchMode } from '@/types/searchMode';

import { ChatContext } from './ChatContext';

import { auth, getAccessTokenForOBO } from '@/auth';
import { env } from '@/config/environment';
import { AccessToken, TokenCredential } from '@azure/identity';

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
      approvalResponses,
    } = body;

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
      approvalResponses,
      temperature,
      stream,
      reasoningEffort,
      verbosity,
      botId,
      searchMode,
      threadId,
      forcedAgentType,
      tone,
      streamingSpeed,
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
 * Content analysis middleware.
 * Analyzes the messages to determine what types of content are present.
 */
export const contentAnalysisMiddleware: Middleware = async (req) => {
  // This middleware needs access to messages from previous middleware
  // We'll need to make this a factory that accepts the current context
  return {};
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
  // Only acquire OBO credentials for Foundry agent calls
  const isFoundryAgent =
    (context.model?.isOrganizationAgent === true ||
      context.modelId?.startsWith('foundry-')) &&
    !!context.model?.agentId;

  if (!isFoundryAgent) {
    return {};
  }

  if (!context.session) {
    console.warn(
      '[CredentialMiddleware] No session available for OBO token acquisition',
    );
    return {};
  }

  try {
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
        const appAccessToken = await getAccessTokenForOBO(req);
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
      return {};
    }

    // Try OBO first for per-user Foundry access, fall back to DefaultAzureCredential
    let userCredential: TokenCredential | undefined;

    try {
      const appAccessToken = await getAccessTokenForOBO(req);
      if (!appAccessToken) throw new Error('No OBO token');

      const tokenProvider = UserTokenProvider.getInstance();
      const foundryToken = await tokenProvider.getFoundryToken(appAccessToken);

      userCredential = {
        // Honor the SDK-requested scope so we don't blindly hand the Foundry
        // token to any audience the SDK happens to ask for. Foundry data-plane
        // scopes are `https://ai.azure.com/...`; refuse anything else.
        getToken: async (scopes) => {
          const requested = Array.isArray(scopes) ? scopes : [scopes];
          const ok = requested.some(
            (s) =>
              typeof s === 'string' &&
              (s.startsWith('https://ai.azure.com/') ||
                s.startsWith('https://cognitiveservices.azure.com/')),
          );
          if (!ok) {
            throw new Error(
              `[CredentialMiddleware] Refusing to issue Foundry token for scope: ${requested.join(',')}`,
            );
          }
          return {
            token: foundryToken,
            expiresOnTimestamp: Date.now() + 55 * 60 * 1000,
          } as AccessToken;
        },
      };

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
        userCredential = {
          getToken: async () => {
            throw new Error(
              'User identity required: unable to acquire OBO token. Sign out and back in, then try again.',
            );
          },
        };
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
    console.error(
      '[CredentialMiddleware] Failed to acquire credential:',
      error,
    );
    // Don't block the pipeline — let it fall back to DefaultAzureCredential
    return {};
  }
};

/**
 * Factory for model selection middleware that needs access to model and messages.
 */
export const createModelSelectionMiddleware = (
  context: Partial<ChatContext>,
): Partial<ChatContext> => {
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

  return {
    modelSelector,
    modelId,
    model: modelConfig,
    agentMode,
  };
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
    ...createModelSelectionMiddleware(context),
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

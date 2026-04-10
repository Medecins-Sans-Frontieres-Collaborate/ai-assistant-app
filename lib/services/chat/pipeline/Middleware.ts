import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { RegionResolver } from '@/lib/services/auth/RegionResolver';
import { UserTokenProvider } from '@/lib/services/auth/UserTokenProvider';
import { InputValidator } from '@/lib/services/chat/validators/InputValidator';
import { ModelSelector, RateLimiter } from '@/lib/services/shared';

import {
  SystemPromptOptions,
  buildSystemPrompt,
} from '@/lib/utils/app/systemPrompt';
import { getUserDisplayName } from '@/lib/utils/app/user/displayName';
import { getMessageContentTypes } from '@/lib/utils/server/chat/chat';

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
    // Use agent-specific endpoint if available (for custom source agents),
    // otherwise resolve from user region (for default project agents)
    const foundryEndpoint =
      context.model?.foundryEndpoint ||
      RegionResolver.getFoundryEndpoint(context.user?.region || 'EU');

    // Try OBO first for per-user Foundry access, fall back to DefaultAzureCredential
    let userCredential: TokenCredential | undefined;

    try {
      const appAccessToken = await getAccessTokenForOBO(context.session);
      if (!appAccessToken) throw new Error('No OBO token');

      const tokenProvider = UserTokenProvider.getInstance();
      const foundryToken = await tokenProvider.getFoundryToken(appAccessToken);

      userCredential = {
        getToken: async () =>
          ({
            token: foundryToken,
            expiresOnTimestamp: Date.now() + 55 * 60 * 1000,
          }) as AccessToken,
      };

      console.log(
        `[CredentialMiddleware] OBO credential acquired, endpoint: ${foundryEndpoint}`,
      );
    } catch {
      // OBO failed — use DefaultAzureCredential (managed identity or az login)
      console.log(
        `[CredentialMiddleware] OBO unavailable, using default credential for ${foundryEndpoint}`,
      );
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
    ...(await createCredentialMiddleware(context)),
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

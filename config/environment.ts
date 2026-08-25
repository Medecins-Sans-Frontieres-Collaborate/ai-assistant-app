/**
 * Environment Configuration & Validation
 *
 * Centralized, type-safe environment variable configuration using Zod.
 * All environment variables should be accessed through this module to ensure type safety.
 */
import { z } from 'zod';

/**
 * Boolean-from-string env schema.
 *
 * Env vars are always strings, so a "boolean" flag is modeled as a string with
 * a default that transforms to `true` only for the literal `'true'`. Factored
 * out so every boolean flag in this file shares one definition instead of
 * repeating the `.default(...).transform(...)` triple.
 */
const booleanString = (defaultValue: boolean) =>
  z
    .string()
    .default(defaultValue ? 'true' : 'false')
    .transform((val) => val === 'true');

/**
 * Environment enum
 */
const EnvironmentEnum = z.enum([
  'localhost',
  'dev',
  'staging',
  'beta',
  'live',
  'prod',
]);

/**
 * Server-side environment schema (includes secrets)
 */
const serverEnvSchema = z.object({
  // Node environment
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  // Azure Authentication
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),

  // Azure OpenAI
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_API_VERSION: z.string().default('2025-04-01-preview'),
  OPENAI_EMBEDDING_DEPLOYMENT: z.string().default('text-embedding'),

  // Azure Speech Services (for batch transcription)
  AZURE_SPEECH_KEY: z.string().optional(),
  AZURE_SPEECH_REGION: z.string().default('eastus'),

  // Azure AI Foundry
  AZURE_AI_FOUNDRY_ENDPOINT: z.string().url().optional(),
  AZURE_AI_FOUNDRY_OPENAI_ENDPOINT: z.string().url().optional(),

  // Azure AI Foundry Multi-Region (GDPR data residency)
  AZURE_AI_FOUNDRY_ENDPOINT_EU: z.string().url().optional(),
  AZURE_AI_FOUNDRY_ENDPOINT_US: z.string().url().optional(),
  AZURE_AI_FOUNDRY_RESOURCE_ID_EU: z.string().optional(),
  AZURE_AI_FOUNDRY_RESOURCE_ID_US: z.string().optional(),

  // Per-region chat endpoints for cross-region routing (a US user chatting
  // with the EU instance of a dually-hosted model, and EU users pinned to EU
  // resources). Optional: when unset for a region, the endpoint is derived
  // from AZURE_AI_FOUNDRY_ENDPOINT_{REGION}; when neither exists, chat falls
  // back to the default (region-blind) clients. Keys are needed because the
  // Foundry OpenAI-compatible data plane is API-key-authenticated and keys
  // are account-scoped.
  AZURE_OPENAI_ENDPOINT_EU: z.string().url().optional(),
  AZURE_OPENAI_ENDPOINT_US: z.string().url().optional(),
  OPENAI_API_KEY_EU: z.string().optional(),
  OPENAI_API_KEY_US: z.string().optional(),

  // When true, agent discovery also lists new-model agent objects via the
  // Foundry data plane (in addition to legacy ARM "Agent Application"
  // resources) and unions the results. Best-effort: failures fall back to
  // ARM-only discovery. Set to "false" to restore pure legacy behavior.
  FOUNDRY_DATAPLANE_DISCOVERY: booleanString(true),

  // Model discovery is ALWAYS ON (no flag): the /api/models route attempts
  // live Foundry deployment discovery and degrades gracefully to the static
  // list when regional accounts aren't configured or discovery fails.
  // When true, discovered deployments that have no local metadata entry are
  // still shown, using conservative inferred defaults. When false, only
  // discovered models that also have metadata are shown. Server-only: never
  // exposed to the client.
  SHOW_MODELS_WITHOUT_METADATA: booleanString(false),

  // Azure Translator (Document Translation) - falls back to AI Foundry endpoint in service layer
  AZURE_TRANSLATOR_ENDPOINT: z.string().url().optional(),

  // Azure Blob Storage (uses Entra ID authentication via DefaultAzureCredential)
  AZURE_BLOB_STORAGE_NAME: z.string().optional(),
  AZURE_BLOB_STORAGE_NAME_EU: z.string().optional(),
  AZURE_BLOB_STORAGE_CONTAINER: z.string().optional(),
  AZURE_BLOB_STORAGE_IMAGE_CONTAINER: z.string().optional(),
  /**
   * Centralized admin/system data location (agent-access rules, usage-limit
   * counters, admin guides, map datasets, …). Defaults to the EU account
   * (data residency: this data references users of every region, and only
   * EU placement satisfies "EU data never leaves the EU") in a dedicated
   * container OUTSIDE any lifecycle-delete rule. See lib/services/
   * adminBlobStorage.ts and docs/ADMIN_BLOB_STORAGE.md.
   */
  AZURE_BLOB_STORAGE_ADMIN_NAME: z.string().optional(),
  AZURE_BLOB_STORAGE_ADMIN_CONTAINER: z.string().optional(),
  STORAGE_RESOURCE_ID: z.string().optional(),
  STORAGE_DATA_SOURCE_CONTAINER: z.string().optional(),

  // Azure Search (uses Entra ID authentication via DefaultAzureCredential)
  SEARCH_ENDPOINT: z.string().url().optional(),
  SEARCH_INDEX: z.string().optional(),
  SEARCH_SKILLSET: z.string().default('rag-skillset'),
  SEARCH_DATASOURCE: z.string().optional(),
  SEARCH_INDEXER: z.string().optional(),
  SEARCH_ENDPOINT_API_KEY: z.string().optional(), // Legacy: Used by OpenAI data_sources feature in documentSummary.ts
  ALLOW_INDEX_DOWNTIME: booleanString(false),
  // M365 file-backed agents (docs/M365_SECOND_PASS_AGENTS_DESIGN.md).
  // Endpoint defaults to SEARCH_ENDPOINT; override to pin the shared
  // m365-agents index to a specific region's Search service (residency
  // decision: an agent whose audience spans US+EU is hosted in EU).
  M365_AGENTS_SEARCH_ENDPOINT: z.string().url().optional(),
  M365_AGENTS_SEARCH_INDEX: z.string().default('m365-agents'),
  // Documents per M365 agent (after folder expansion). Layer-2 probes run
  // as Graph $batch calls (20/request), so the ceiling is indexing wall
  // time and per-user probe latency, not probe fan-out. 200 is a hard
  // sanity bound — the synchronous index route has a 300s budget.
  M365_AGENT_MAX_DOCUMENTS: z.coerce.number().int().min(1).max(200).default(50),
  /**
   * Sum of the sizes of an M365 agent's indexable files (MB). Known from
   * Graph metadata, so the plan view can refuse an oversized tree before a
   * single download.
   */
  M365_AGENT_MAX_SOURCE_MB: z.coerce
    .number()
    .int()
    .min(1)
    .max(4096)
    .default(512),

  // Web search backend:
  //  - 'news': GDELT + Google News RSS queried IN PARALLEL and merged —
  //    each feed is the other's backup, so one failing/empty source never
  //    sinks the search. Seconds-fast, no LLM round-trip. Default.
  //  - 'gdelt': GDELT DOC API alone — keyless, real publisher URLs.
  //  - 'google-news': Google News RSS alone + link decoding.
  //  - 'bing-agent': the Foundry agent with Bing grounding — broader web
  //    coverage but 30-90s round-trips and flaky result quality.
  //  - 'combined': Bing agent + Google News feed concurrently; headlines
  //    stream to the client while Bing runs, then the results merge.
  //  - 'bing-responses': the native web_search tool on the Azure OpenAI
  //    Responses API — same Bing grounding as 'bing-agent' but a direct
  //    model call instead of a Foundry agent run.
  WEB_SEARCH_PROVIDER: z
    .enum([
      'news',
      'gdelt',
      'google-news',
      'bing-agent',
      'bing-responses',
      'combined',
    ])
    .default('news'),

  // Web search round-trip budget (ms). Applies to whichever provider runs.
  // Bing grounding via the Foundry search agent is simply slow (observed
  // >45s regularly; nothing app-side can speed it up) — the wait is made
  // legible instead: live query loader, elapsed timer, and a color ramp
  // that drifts warmer over time. On timeout the turn degrades to a
  // knowledge answer with an honest notice.
  WEB_SEARCH_TIMEOUT_MS: z.coerce.number().int().min(5000).default(120000),

  // Code interpreter (sandboxed Python via Foundry Responses API).
  // Kill switch: default ON so interpreter is available out of the box;
  // set false to disable the feature server-side regardless of client mode.
  CODE_INTERPRETER_ENABLED: booleanString(true),
  // Deployment that backs the interpreter sub-tool round-trip (must support
  // the Responses-API code_interpreter tool in the project's region).
  CODE_INTERPRETER_MODEL: z.string().default('gpt-5.4'),

  // Deployment used by the 'bing-responses' web-search provider (Responses
  // API native web_search tool). Must be a Responses-capable deployment in
  // the default Foundry project, with the web_search tool enabled on the
  // subscription.
  WEB_SEARCH_RESPONSES_MODEL: z.string().default('gpt-5.4'),

  // MCP (Model Context Protocol) connectors
  // Server-side gate for ARBITRARY (non-catalog) MCP server URLs — defense in
  // depth behind the client-side toggle + LaunchDarkly flag. Curated catalog
  // entries (config/mcpCatalog.ts) are not affected by this flag.
  MCP_CUSTOM_SERVERS_ENABLED: booleanString(false),
  // Pre-registered OAuth apps for curated MCP connectors. Needed because the
  // providers don't support web-app dynamic client registration: GitHub has
  // no DCR at all, and Asana's DCR only allows loopback redirect URIs (so it
  // works for localhost dev but never for a deployed origin). Register an app
  // in the provider's console with redirect URI
  // `${NEXTAUTH_URL}/mcp-oauth-callback`, then set these. The client SECRET
  // never leaves the server — the token proxy injects it.
  MCP_OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  MCP_OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  MCP_OAUTH_ASANA_CLIENT_ID: z.string().optional(),
  MCP_OAUTH_ASANA_CLIENT_SECRET: z.string().optional(),
  // Tableau speaks OAuth 2.1 and may complete DCR unaided; these are a
  // fallback for deployments where registration is blocked.
  MCP_OAUTH_TABLEAU_CLIENT_ID: z.string().optional(),
  MCP_OAUTH_TABLEAU_CLIENT_SECRET: z.string().optional(),
  // Salesforce has no DCR: create an External Client App in the org with the
  // `mcp_api` and `refresh_token` scopes and set its consumer key here, or
  // the connector cannot authenticate at all.
  MCP_OAUTH_SALESFORCE_CLIENT_ID: z.string().optional(),
  MCP_OAUTH_SALESFORCE_CLIENT_SECRET: z.string().optional(),
  // Shared by both Hootsuite servers (Perch and Nest) — one Hootsuite OAuth
  // app covers the whole account.
  MCP_OAUTH_HOOTSUITE_CLIENT_ID: z.string().optional(),
  MCP_OAUTH_HOOTSUITE_CLIENT_SECRET: z.string().optional(),

  // App-layer agent access control (docs/AGENT_ACCESS_CONTROL.md)
  // Master gate for enforcement + admin API + UI. Break-glass for a
  // rules-blob outage: set to "false" and redeploy.
  AGENT_ACCESS_CONTROL_ENABLED: booleanString(false),
  // Comma-separated global-admin emails (Graph `mail` values, matched
  // lowercased + trimmed). Bootstrap mechanism — changing it needs a redeploy.
  AGENT_ACCESS_ADMINS: z.string().optional(),

  // Usage limits (docs/LIMITS.md) have no env gate: the UI is gated by the
  // client-side `usageLimits` LaunchDarkly flag, and the server side is inert
  // until a policy is authored (no policy blob → everything unlimited).
  // Break-glass for a bad policy is the admin UI itself, or deleting the blob.
  // The admin roster IS shared — limits are authored by the same
  // AGENT_ACCESS_ADMINS global admins.

  // Application Configuration
  // Optional explicit override; when unset the default model resolves
  // dynamically to the latest ring-enabled standard GPT (config/models.ts).
  DEFAULT_MODEL: z.string().optional(),
  DEFAULT_USE_KNOWLEDGE_BASE: booleanString(false),
  FORCE_LOGOUT_ON_REFRESH_FAILURE: z.string().default('true'),

  // NextAuth
  AUTH_SECRET: z.string().optional(),
  NEXTAUTH_SECRET: z.string().optional(),
  NEXTAUTH_URL: z.string().url().optional(),

  // Application Insights (OpenTelemetry)
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),

  // Azure Monitor Log Ingestion
  LOGS_INJESTION_ENDPOINT: z.string().url().optional(),
  DATA_COLLECTION_RULE_ID: z.string().optional(),
  STREAM_NAME: z.string().default('Custom-aiplatform_CL'),

  // LaunchDarkly
  LAUNCHDARKLY_SDK_KEY: z.string().optional(),
  LAUNCHDARKLY_CLIENT_ID: z.string().optional(),

  // Grant Pipeline - Azure OpenAI overrides (falls back to main Azure OpenAI config)
  GRANT_PIPELINE_OPENAI_ENDPOINT: z.string().url().optional(),
  GRANT_PIPELINE_OPENAI_DEPLOYMENT: z.string().optional(),
  GRANT_PIPELINE_OPENAI_KEY: z.string().optional(),

  // Grant Pipeline - Azure Document Intelligence (falls back to main DI config)
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: z.string().url().optional(),
  AZURE_DOCUMENT_INTELLIGENCE_KEY: z.string().optional(),
  GRANT_PIPELINE_DI_ENDPOINT: z.string().url().optional(),
  GRANT_PIPELINE_DI_KEY: z.string().optional(),

  // Build Information
  GITHUB_SHA: z.string().optional(),
  BUILD_ID: z.string().optional(),
  NEXT_PUBLIC_EMAIL: z.string().email().optional(),

  // System Prompt Configuration
  BASE_SYSTEM_PROMPT: z.string().optional(), // Overrides the default base system prompt
  NEXT_PUBLIC_DEFAULT_SYSTEM_PROMPT: z.string().optional(), // Legacy: user's default prompt
  NEXT_PUBLIC_DEFAULT_TEMPERATURE: z.string().default('0.5'),

  // Application Environment
  NEXT_PUBLIC_ENV: EnvironmentEnum.default('localhost'),
  NEXT_PUBLIC_BUILD: z.string().optional(),

  // Feature Flags
  systemPromptmaxLength: z
    .string()
    .transform((val) => Number(val) || 500)
    .optional(),
});

/**
 * Client-side environment schema (only NEXT_PUBLIC_ vars)
 */
const clientEnvSchema = z.object({
  NEXT_PUBLIC_ENV: EnvironmentEnum.default('localhost'),
  NEXT_PUBLIC_BUILD: z.string().optional(),
  NEXT_PUBLIC_DEFAULT_SYSTEM_PROMPT: z.string().optional(),
  NEXT_PUBLIC_DEFAULT_TEMPERATURE: z.string().default('0.5'),
  NEXT_PUBLIC_EMAIL: z.string().email().optional(),
  LAUNCHDARKLY_CLIENT_ID: z.string().optional(),
});

/**
 * Validate and parse environment variables
 */
function validateEnv() {
  // Check if we're on the server or client
  const isServer = typeof window === 'undefined';

  if (isServer) {
    // Server-side: validate all environment variables
    const parsed = serverEnvSchema.safeParse(process.env);

    if (!parsed.success) {
      console.error('❌ Invalid environment variables:');
      console.error(parsed.error.flatten().fieldErrors);
      throw new Error('Invalid environment variables');
    }

    return parsed.data;
  } else {
    // Client-side: only validate NEXT_PUBLIC_ variables.
    //
    // Each variable MUST be referenced as a literal `process.env.NEXT_PUBLIC_X`
    // member expression: the bundler inlines exactly those expressions into the
    // client bundle, while a bare `process.env` compiles to an empty shim —
    // passing it to safeParse would silently reduce every value to its schema
    // default in the browser.
    const parsed = clientEnvSchema.safeParse({
      NEXT_PUBLIC_ENV: process.env.NEXT_PUBLIC_ENV,
      NEXT_PUBLIC_BUILD: process.env.NEXT_PUBLIC_BUILD,
      NEXT_PUBLIC_DEFAULT_SYSTEM_PROMPT:
        process.env.NEXT_PUBLIC_DEFAULT_SYSTEM_PROMPT,
      NEXT_PUBLIC_DEFAULT_TEMPERATURE:
        process.env.NEXT_PUBLIC_DEFAULT_TEMPERATURE,
      NEXT_PUBLIC_EMAIL: process.env.NEXT_PUBLIC_EMAIL,
      LAUNCHDARKLY_CLIENT_ID: process.env.LAUNCHDARKLY_CLIENT_ID,
    });

    if (!parsed.success) {
      console.error('❌ Invalid client environment variables:');
      console.error(parsed.error.flatten().fieldErrors);
      throw new Error('Invalid client environment variables');
    }

    return parsed.data;
  }
}

/**
 * Validated environment variables
 *
 * Use this object instead of process.env for type safety
 */
export const env = validateEnv() as ServerEnv & ClientEnv;

/**
 * Type exports
 */
export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type Environment = z.infer<typeof EnvironmentEnum>;

/**
 * Helper functions
 */
export const isProduction = () =>
  env.NEXT_PUBLIC_ENV === 'prod' || env.NEXT_PUBLIC_ENV === 'live';
export const isDevelopment = () =>
  env.NEXT_PUBLIC_ENV === 'localhost' || env.NEXT_PUBLIC_ENV === 'dev';
export const isStaging = () => env.NEXT_PUBLIC_ENV === 'staging';
export const isBeta = () => env.NEXT_PUBLIC_ENV === 'beta';

/**
 * Get current environment
 */
export const getCurrentEnvironment = (): Environment => env.NEXT_PUBLIC_ENV;

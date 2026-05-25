export interface OpenAIModel {
  id: string;
  name: string;
  maxLength: number; // Input context window (in tokens)
  tokenLimit: number; // Maximum output tokens
  temperature?: number;
  stream?: boolean;
  modelType?: 'foundational' | 'omni' | 'reasoning' | 'agent';
  description?: string;
  /**
   * Short, user-facing one-liner shown in the model list (e.g. "Best for
   * most tasks", "Faster and lower cost"). Helps users decide without
   * opening the details panel. Aim for ≤6 words.
   */
  tagline?: string;
  /**
   * Marks the model as the recommended default. Pinned to the top of the
   * list and rendered with a "Recommended" pill so first-time users have
   * a clear "start here" signal. Exactly one model should be flagged.
   */
  isRecommended?: boolean;
  isDisabled?: boolean;
  isAgent?: boolean;
  isCustomAgent?: boolean; // User-created custom agent (vs built-in agent)
  isOrganizationAgent?: boolean; // Organization-defined agent (e.g., MSF Communications bot)
  agentId?: string; // Azure AI Foundry agent name (or legacy asst_xxx ID)
  /** Agent version the Application's deployment routes to. Required in the
   * agent_reference body when invoking via the project endpoint. */
  agentVersion?: string;
  foundryEndpoint?: string; // Foundry project endpoint for this agent (for custom sources)
  /**
   * ARM resource path of the Foundry project this agent was discovered from.
   * Used as a cache disambiguator + lazy-discovery scope at chat time so the
   * same agent name from different projects routes to the right endpoint.
   * Server validates against `isValidFoundryResourcePath` before any use.
   */
  agentSource?: string;
  provider?: 'openai' | 'deepseek' | 'xai' | 'meta' | 'anthropic'; // Model provider
  knowledgeCutoffDate?: string; // ISO format for sorting and display (e.g., "2025-01" or "2025-01-20")
  sdk?: 'azure-openai' | 'openai' | 'anthropic-foundry'; // Which SDK this model requires
  supportsTemperature?: boolean; // Whether this model supports custom temperature values
  deploymentName?: string; // Azure AI Foundry deployment name (for third-party models)

  // Advanced reasoning model parameters
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'; // Current reasoning effort setting
  supportsReasoningEffort?: boolean; // Whether model supports reasoning_effort parameter
  supportsMinimalReasoning?: boolean; // Whether model supports 'minimal' reasoning effort (GPT-5 only)
  verbosity?: 'low' | 'medium' | 'high'; // Current verbosity setting
  supportsVerbosity?: boolean; // Whether model supports verbosity parameter

  // Special handling flags
  avoidSystemPrompt?: boolean; // For DeepSeek-R1: merge system prompt into user message
  usesResponsesAPI?: boolean; // Uses Azure responses.create() instead of chat.completions
}

// Model order determines display order in UI (most advanced first)
export enum OpenAIModelID {
  GPT_5_2 = 'gpt-5.2',
  GPT_5_2_CHAT = 'gpt-5.2-chat',
  GPT_o3 = 'o3',
  GPT_5_MINI = 'gpt-5-mini',
  GPT_4_1 = 'gpt-4.1',
  // Anthropic Claude models (via Azure AI Foundry)
  CLAUDE_OPUS_4_6 = 'claude-opus-4-6',
  CLAUDE_SONNET_4_6 = 'claude-sonnet-4-6',
  CLAUDE_OPUS_4_1 = 'claude-opus-4-1',
  CLAUDE_HAIKU_4_5 = 'claude-haiku-4-5',
  // Other providers
  LLAMA_4_MAVERICK = 'Llama-4-Maverick-17B-128E-Instruct-FP8',
  DEEPSEEK_R1 = 'DeepSeek-R1',
  DEEPSEEK_V3_1 = 'DeepSeek-V3.1',
  GROK_3 = 'grok-3',
}

export enum OpenAIVisionModelID {
  GPT_4_1 = 'gpt-4.1',
  GPT_5_2 = 'gpt-5.2',
  GPT_5_MINI = 'gpt-5-mini',
  GPT_5_2_CHAT = 'gpt-5.2-chat',
  GROK_3 = 'grok-3',
  CLAUDE_OPUS_4_6 = 'claude-opus-4-6',
  CLAUDE_SONNET_4_6 = 'claude-sonnet-4-6',
  CLAUDE_HAIKU_4_5 = 'claude-haiku-4-5',
}

// Fallback model ID
export const fallbackModelID = OpenAIModelID.GPT_5_2_CHAT;

/**
 * Default display order for models in the model selection UI.
 * Used when no user preferences exist.
 * This array defines the priority order - models listed first appear at the top.
 */
export const DEFAULT_MODEL_ORDER: OpenAIModelID[] = [
  OpenAIModelID.GPT_5_2,
  OpenAIModelID.GPT_5_2_CHAT,
  OpenAIModelID.GPT_o3,
  OpenAIModelID.GPT_5_MINI,
  OpenAIModelID.GPT_4_1,
  OpenAIModelID.CLAUDE_OPUS_4_6,
  OpenAIModelID.CLAUDE_SONNET_4_6,
  OpenAIModelID.CLAUDE_OPUS_4_1,
  OpenAIModelID.CLAUDE_HAIKU_4_5,
  OpenAIModelID.LLAMA_4_MAVERICK,
  OpenAIModelID.DEEPSEEK_R1,
  OpenAIModelID.DEEPSEEK_V3_1,
  OpenAIModelID.GROK_3,
];

/**
 * Agent names for built-in agent-backed models.
 * Agent names are the same across environments (different Foundry endpoints differentiate them).
 */
const AGENT_NAMES: Partial<Record<OpenAIModelID, string>> = {
  [OpenAIModelID.GPT_4_1]: 'gpt-41',
  [OpenAIModelID.GPT_5_2]: 'gpt-52',
  [OpenAIModelID.GPT_5_2_CHAT]: 'gpt-52-chat',
  [OpenAIModelID.CLAUDE_OPUS_4_6]: 'claude-opus-46',
  [OpenAIModelID.CLAUDE_SONNET_4_6]: 'claude-sonnet-46',
  [OpenAIModelID.CLAUDE_HAIKU_4_5]: 'claude-haiku-45',
};

/**
 * Factory function to create model configurations
 */
function createModelConfigs(): Record<OpenAIModelID, OpenAIModel> {
  return {
    [OpenAIModelID.GPT_4_1]: {
      id: OpenAIModelID.GPT_4_1,
      name: 'GPT-4.1',
      maxLength: 128000,
      tokenLimit: 16000,
      modelType: 'omni',
      tagline: "OpenAI's previous generation",
      description:
        "OpenAI's previous-generation model. Still capable for everyday writing, summaries, and Q&A.",
      isDisabled: false,
      isAgent: true,
      agentId: AGENT_NAMES[OpenAIModelID.GPT_4_1],
      provider: 'openai',
      knowledgeCutoffDate: '', // Empty - uses translation key for "Real-time web search"
      sdk: 'azure-openai',
      supportsTemperature: false,
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.GPT_5_2]: {
      id: OpenAIModelID.GPT_5_2,
      name: 'GPT-5.2',
      maxLength: 128000,
      tokenLimit: 16000,
      modelType: 'omni',
      tagline: 'Code, analysis, research',
      isRecommended: true,
      description:
        'A capable everyday model for most kinds of work — writing, research, coding, and thinking through complex problems.',
      isDisabled: false,
      isAgent: true,
      agentId: AGENT_NAMES[OpenAIModelID.GPT_5_2],
      provider: 'openai',
      knowledgeCutoffDate: '2025-12',
      sdk: 'azure-openai',
      supportsTemperature: false,
      reasoningEffort: 'medium',
      supportsReasoningEffort: true,
      supportsMinimalReasoning: true, // GPT-5.2 uniquely supports 'minimal' effort
      verbosity: 'medium',
      supportsVerbosity: true,
    },
    [OpenAIModelID.GPT_5_MINI]: {
      id: OpenAIModelID.GPT_5_MINI,
      name: 'GPT-5 Mini',
      maxLength: 128000,
      tokenLimit: 16000,
      modelType: 'omni',
      tagline: 'Faster and lower cost',
      description:
        "A faster, lighter model for quick questions and everyday tasks where you don't need maximum power.",
      isDisabled: false,
      provider: 'openai',
      knowledgeCutoffDate: '2025-08-06T20:00',
      sdk: 'azure-openai',
      supportsTemperature: false,
      reasoningEffort: 'low',
      supportsReasoningEffort: true,
      supportsMinimalReasoning: true,
      verbosity: 'low',
      supportsVerbosity: false,
    },
    [OpenAIModelID.GPT_5_2_CHAT]: {
      id: OpenAIModelID.GPT_5_2_CHAT,
      name: 'GPT-5.2 Chat',
      maxLength: 128000,
      tokenLimit: 16000,
      modelType: 'omni',
      tagline: 'Conversations, brainstorming',
      isRecommended: true,
      description:
        'A friendlier version of GPT-5.2 tuned for conversation. Good for casual chats, brainstorming, and supportive discussions.',
      isDisabled: false,
      isAgent: true,
      agentId: AGENT_NAMES[OpenAIModelID.GPT_5_2_CHAT],
      provider: 'openai',
      knowledgeCutoffDate: '2025-12',
      sdk: 'azure-openai',
      supportsTemperature: false,
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.GPT_o3]: {
      id: OpenAIModelID.GPT_o3,
      name: 'o3',
      maxLength: 200000, // Extended context window
      tokenLimit: 100000, // Extended output tokens
      stream: false,
      temperature: 1,
      modelType: 'reasoning',
      tagline: 'Deep step-by-step reasoning',
      description:
        'Made for hard reasoning. Use it when a problem needs careful, step-by-step thinking — math, science, tricky logic.',
      isDisabled: false,
      provider: 'openai',
      knowledgeCutoffDate: '2025-04-08T20:00',
      sdk: 'azure-openai',
      supportsTemperature: false,
      reasoningEffort: 'medium',
      supportsReasoningEffort: true,
      supportsMinimalReasoning: false, // o3 doesn't support 'minimal', only low/medium/high
      supportsVerbosity: false,
    },
    [OpenAIModelID.LLAMA_4_MAVERICK]: {
      id: OpenAIModelID.LLAMA_4_MAVERICK,
      name: 'Llama 4 Maverick',
      maxLength: 128000,
      tokenLimit: 16000,
      modelType: 'foundational',
      tagline: 'Open-source alternative',
      description:
        'An open-source model from Meta. Solid for writing, summaries, and quick questions.',
      isDisabled: false,
      provider: 'meta',
      knowledgeCutoffDate: '2025-05-07T07:11',
      sdk: 'openai',
      supportsTemperature: true,
      deploymentName: 'Llama-4-Maverick-17B-128E-Instruct-FP8',
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.DEEPSEEK_R1]: {
      id: OpenAIModelID.DEEPSEEK_R1,
      name: 'DeepSeek-R1',
      maxLength: 128000,
      tokenLimit: 32768,
      modelType: 'reasoning',
      tagline: 'Shows reasoning step-by-step',
      description:
        'Shows its thinking step-by-step. Useful when you want to see how the model reaches its answer.',
      isDisabled: false,
      provider: 'deepseek',
      knowledgeCutoffDate: '2025-01-20',
      sdk: 'openai',
      supportsTemperature: true,
      deploymentName: 'DeepSeek-R1',
      avoidSystemPrompt: true, // Special handling: merge system prompts into user messages
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.DEEPSEEK_V3_1]: {
      id: OpenAIModelID.DEEPSEEK_V3_1,
      name: 'DeepSeek-V3.1',
      maxLength: 128000,
      tokenLimit: 32768,
      modelType: 'foundational',
      tagline: 'Open-source alternative',
      description:
        'An open-source model from DeepSeek. Reliable for general writing and technical questions.',
      isDisabled: false,
      provider: 'deepseek',
      knowledgeCutoffDate: '2025-04-16T00:45',
      sdk: 'openai',
      supportsTemperature: true,
      deploymentName: 'DeepSeek-V3.1',
      avoidSystemPrompt: true, // Also benefits from avoiding system prompts
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.GROK_3]: {
      id: OpenAIModelID.GROK_3,
      name: 'Grok 3',
      maxLength: 128000,
      tokenLimit: 16000,
      modelType: 'omni',
      tagline: 'xAI alternative',
      description:
        "xAI's chat model. Good for open-ended discussions and creative projects.",
      isDisabled: true, // Disabled temporarily
      provider: 'xai',
      knowledgeCutoffDate: '2025-05-13T00:16',
      sdk: 'openai',
      supportsTemperature: true,
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    // Anthropic Claude models (via Azure AI Foundry)
    [OpenAIModelID.CLAUDE_OPUS_4_6]: {
      id: OpenAIModelID.CLAUDE_OPUS_4_6,
      name: 'Claude Opus 4.6',
      maxLength: 200000,
      tokenLimit: 64000,
      modelType: 'omni',
      tagline: 'Long-form writing and analysis',
      description:
        "Anthropic's strongest model. Good for long writing, research, and tasks that need careful thinking.",
      isDisabled: false,
      isAgent: true,
      agentId: AGENT_NAMES[OpenAIModelID.CLAUDE_OPUS_4_6],
      provider: 'anthropic',
      knowledgeCutoffDate: '2026-02-02T19:00',
      sdk: 'anthropic-foundry',
      supportsTemperature: true,
      deploymentName: 'claude-opus-4-6',
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.CLAUDE_SONNET_4_6]: {
      id: OpenAIModelID.CLAUDE_SONNET_4_6,
      name: 'Claude Sonnet 4.6',
      maxLength: 200000,
      tokenLimit: 64000,
      modelType: 'omni',
      tagline: 'Balanced everyday Claude',
      description:
        'A balanced Claude model. Good for everyday writing, analysis, and coding with quick responses.',
      isDisabled: false,
      isAgent: true,
      agentId: AGENT_NAMES[OpenAIModelID.CLAUDE_SONNET_4_6],
      provider: 'anthropic',
      knowledgeCutoffDate: '2026-02-11T19:00',
      sdk: 'anthropic-foundry',
      supportsTemperature: true,
      deploymentName: 'claude-sonnet-4-6',
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.CLAUDE_OPUS_4_1]: {
      id: OpenAIModelID.CLAUDE_OPUS_4_1,
      name: 'Claude Opus 4.1',
      maxLength: 200000,
      tokenLimit: 32000,
      modelType: 'omni',
      tagline: 'Previous-generation Opus',
      description:
        'Previous-generation Opus. Still strong for coding and detailed analysis.',
      isDisabled: true,
      provider: 'anthropic',
      knowledgeCutoffDate: '2025-01',
      sdk: 'anthropic-foundry',
      supportsTemperature: true,
      deploymentName: 'claude-opus-4-1',
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.CLAUDE_HAIKU_4_5]: {
      id: OpenAIModelID.CLAUDE_HAIKU_4_5,
      name: 'Claude Haiku 4.5',
      maxLength: 200000,
      tokenLimit: 64000,
      modelType: 'foundational',
      tagline: 'Fast Claude variant',
      description:
        'The fastest Claude. Good for quick tasks where speed matters more than depth.',
      isDisabled: false,
      isAgent: true,
      agentId: AGENT_NAMES[OpenAIModelID.CLAUDE_HAIKU_4_5],
      provider: 'anthropic',
      knowledgeCutoffDate: '2025-01',
      sdk: 'anthropic-foundry',
      supportsTemperature: true,
      deploymentName: 'claude-haiku-4-5',
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
  };
}

export const OpenAIModels: Record<OpenAIModelID, OpenAIModel> =
  createModelConfigs();

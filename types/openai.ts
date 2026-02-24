export interface OpenAIModel {
  id: string;
  name: string;
  maxLength: number; // Input context window (in tokens)
  tokenLimit: number; // Maximum output tokens
  temperature?: number;
  stream?: boolean;
  modelType?: 'foundational' | 'omni' | 'reasoning' | 'agent';
  description?: string;
  isDisabled?: boolean;
  isAgent?: boolean;
  isCustomAgent?: boolean; // User-created custom agent (vs built-in agent)
  isOrganizationAgent?: boolean; // Organization-defined agent (e.g., MSF Communications bot)
  agentId?: string; // Azure AI Agent ID for this model
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
  CLAUDE_OPUS_4_5 = 'claude-opus-4-5',
  CLAUDE_SONNET_4_5 = 'claude-sonnet-4-5',
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
  CLAUDE_SONNET_4_5 = 'claude-sonnet-4-5',
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
  OpenAIModelID.CLAUDE_OPUS_4_5,
  OpenAIModelID.CLAUDE_SONNET_4_5,
  OpenAIModelID.CLAUDE_OPUS_4_1,
  OpenAIModelID.CLAUDE_HAIKU_4_5,
  OpenAIModelID.LLAMA_4_MAVERICK,
  OpenAIModelID.DEEPSEEK_R1,
  OpenAIModelID.DEEPSEEK_V3_1,
  OpenAIModelID.GROK_3,
];

/**
 * Environment-specific configuration for models
 * Only includes values that differ between environments
 */
interface EnvironmentConfig {
  agentId: string;
}

const ENVIRONMENT_CONFIGS: Record<
  'dev' | 'prod',
  Record<string, EnvironmentConfig>
> = {
  dev: {
    [OpenAIModelID.GPT_4_1]: {
      agentId: 'asst_sbddkxz8DLyCXATINdB10pys', // Agent145 - dev
    },
  },
  prod: {
    [OpenAIModelID.GPT_4_1]: {
      agentId: 'asst_31ffIP2JhFb9iJmeauwV82X5', // Agent312 - gpt-4.1
    },
  },
};

/**
 * Factory function to create model configurations
 * Eliminates duplication between dev and prod configs
 */
function createModelConfigs(
  isProduction: boolean,
): Record<OpenAIModelID, OpenAIModel> {
  const envConfig = isProduction
    ? ENVIRONMENT_CONFIGS.prod
    : ENVIRONMENT_CONFIGS.dev;

  return {
    [OpenAIModelID.GPT_4_1]: {
      id: OpenAIModelID.GPT_4_1,
      name: 'GPT-4.1',
      maxLength: 128000,
      tokenLimit: 16000,
      modelType: 'agent',
      description:
        'AI model powered by GPT-4.1 with real-time web search via Bing. Provides up-to-date information, fact-checking, and current event awareness. Best for research requiring recent information, news analysis, and fact verification.',
      isDisabled: false,
      isAgent: true,
      agentId: envConfig[OpenAIModelID.GPT_4_1].agentId,
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
      description:
        "OpenAI's most advanced model, excelling at complex reasoning, code generation, and technical problem-solving. Best for analytical tasks, programming challenges, research, and detailed explanations. Supports adjustable reasoning effort and response verbosity.",
      isDisabled: false,
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
      description:
        'Faster and more cost-effective variant of GPT-5, optimized for speed while maintaining high quality. Perfect for everyday tasks, quick queries, tool routing, and applications requiring fast response times. Excellent balance of performance and efficiency.',
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
      description:
        'Specialized variant of GPT-5.2 optimized for conversational interactions and emotional intelligence. Excels at empathetic communication, creative writing, brainstorming, and natural dialogue. Best for casual conversations, counseling scenarios, and tasks requiring emotional awareness.',
      isDisabled: false,
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
      description:
        "OpenAI's most advanced reasoning model with breakthrough problem-solving capabilities. Excels at complex mathematics, scientific reasoning, coding challenges, and multi-step logical tasks. Extended 200K context window. Supports reasoning effort control.",
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
      description:
        'Fast and cost-effective model from Meta. Great for everyday tasks like writing, summarization, and basic coding help. Good balance of speed and quality for routine work.',
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
      description:
        'Reasoning specialist that shows its work step-by-step. Excellent for math problems, logic puzzles, and understanding complex concepts. See how it thinks through problems in real-time.',
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
      description:
        'Strong all-around model especially good at coding and technical writing. Great for debugging code, writing documentation, and explaining technical concepts. Fast and reliable for development work.',
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
      description:
        'Versatile model from xAI known for nuanced responses. Great for open-ended discussions, creative projects, and tackling complex problems.',
      isDisabled: true, // Disabled temporarily
      provider: 'xai',
      knowledgeCutoffDate: '2025-05-13T00:16',
      sdk: 'openai',
      supportsTemperature: true,
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    // Anthropic Claude models (via Azure AI Foundry)
    [OpenAIModelID.CLAUDE_OPUS_4_5]: {
      id: OpenAIModelID.CLAUDE_OPUS_4_5,
      name: 'Claude Opus 4.5',
      maxLength: 200000,
      tokenLimit: 64000,
      modelType: 'omni',
      description:
        "Anthropic's most capable model with exceptional reasoning, coding, and creative abilities. Best for complex analysis, research, and tasks requiring deep understanding.",
      isDisabled: true,
      provider: 'anthropic',
      knowledgeCutoffDate: '2025-01',
      sdk: 'anthropic-foundry',
      supportsTemperature: true,
      deploymentName: 'claude-opus-4-5',
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.CLAUDE_SONNET_4_5]: {
      id: OpenAIModelID.CLAUDE_SONNET_4_5,
      name: 'Claude Sonnet 4.5',
      maxLength: 200000,
      tokenLimit: 64000,
      modelType: 'omni',
      description:
        'Balanced Claude model offering excellent performance across coding, analysis, and creative tasks. Great for everyday use with fast response times.',
      isDisabled: true,
      provider: 'anthropic',
      knowledgeCutoffDate: '2025-01',
      sdk: 'anthropic-foundry',
      supportsTemperature: true,
      deploymentName: 'claude-sonnet-4-5',
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.CLAUDE_OPUS_4_1]: {
      id: OpenAIModelID.CLAUDE_OPUS_4_1,
      name: 'Claude Opus 4.1',
      maxLength: 200000,
      tokenLimit: 32000,
      modelType: 'omni',
      description:
        'Previous generation Claude Opus model. Excellent for complex coding tasks, detailed analysis, and nuanced understanding.',
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
      description:
        'Fast and cost-effective Claude model optimized for quick tasks. Great for simple queries, summarization, and high-volume applications.',
      isDisabled: true,
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

// Select the appropriate configuration based on environment
// NEXT_PUBLIC_ENV is set in .env files: 'localhost', 'dev', 'staging', 'beta', 'live', 'prod'
const environment = process.env.NEXT_PUBLIC_ENV || 'localhost';
const isProduction =
  environment === 'prod' || environment === 'live' || environment === 'beta';

export const OpenAIModels: Record<OpenAIModelID, OpenAIModel> =
  createModelConfigs(isProduction);

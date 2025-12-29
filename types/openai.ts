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
  agentId?: string; // Azure AI Agent ID for this model
  provider?: 'openai' | 'deepseek' | 'xai' | 'meta' | 'anthropic'; // Model provider
  knowledgeCutoff?: string; // Knowledge cutoff date
  sdk?: 'azure-openai' | 'openai' | 'anthropic'; // Which SDK this model requires
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
  CLAUDE_SONNET_4_5 = 'claude-sonnet-4-5',
  CLAUDE_HAIKU_4_5 = 'claude-haiku-4-5',
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
      agentId: 'asst_31fflP2JhFb9iJmeauwV82X5', // Agent312 - gpt-4.1
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
      knowledgeCutoff: 'Real-time web search',
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
      knowledgeCutoff: 'Dec 2025',
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
      knowledgeCutoff: 'Aug 6, 2025 8:00 PM',
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
        'Specialized variant of GPT-5.2 optimized for conversational interactions and emotional intelligence. Excels at empathetic communication, mental health support, creative writing, brainstorming, and natural dialogue. Best for casual conversations, counseling scenarios, and tasks requiring emotional awareness.',
      isDisabled: false,
      provider: 'openai',
      knowledgeCutoff: 'Dec 2025',
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
      knowledgeCutoff: 'Apr 8, 2025 8:00 PM',
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
      knowledgeCutoff: 'May 7, 2025 7:11 AM',
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
      knowledgeCutoff: 'Jan 20, 2025',
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
      knowledgeCutoff: 'Apr 16, 2025 12:45 AM',
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
      knowledgeCutoff: 'May 13, 2025 12:16 AM',
      sdk: 'openai',
      supportsTemperature: true,
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.CLAUDE_SONNET_4_5]: {
      id: OpenAIModelID.CLAUDE_SONNET_4_5,
      name: 'Claude Sonnet 4.5',
      maxLength: 200000,
      tokenLimit: 8192,
      modelType: 'omni',
      description:
        "Anthropic's most balanced model, excelling at coding, analysis, and nuanced conversations. Strong at following complex instructions with thoughtful, well-structured responses. Great for software development, research, and detailed writing tasks.",
      isDisabled: false,
      provider: 'anthropic',
      knowledgeCutoff: 'Sep 2025',
      sdk: 'anthropic',
      supportsTemperature: true,
      deploymentName: 'claude-sonnet-4-5',
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
    [OpenAIModelID.CLAUDE_HAIKU_4_5]: {
      id: OpenAIModelID.CLAUDE_HAIKU_4_5,
      name: 'Claude Haiku 4.5',
      maxLength: 200000,
      tokenLimit: 8192,
      modelType: 'foundational',
      description:
        "Anthropic's fastest and most cost-effective model. Ideal for quick tasks, simple questions, and high-volume applications. Maintains strong reasoning capabilities while delivering near-instant responses.",
      isDisabled: false,
      provider: 'anthropic',
      knowledgeCutoff: 'Oct 2025',
      sdk: 'anthropic',
      supportsTemperature: true,
      deploymentName: 'claude-haiku-4-5',
      supportsReasoningEffort: false,
      supportsVerbosity: false,
    },
  };
}

// Select the appropriate configuration based on environment
// NEXT_PUBLIC_ENV is set in .env files: 'localhost', 'development', 'staging', 'beta', 'production'
const environment = process.env.NEXT_PUBLIC_ENV || 'localhost';
const isProduction = environment === 'production' || environment === 'beta';

export const OpenAIModels: Record<OpenAIModelID, OpenAIModel> =
  createModelConfigs(isProduction);

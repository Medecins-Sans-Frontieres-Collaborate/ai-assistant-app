export interface ProcessEnv {
  OPENAI_API_KEY: string;
  OPENAI_API_HOST?: string;
  OPENAI_API_TYPE?: 'openai' | 'azure';
  OPENAI_API_VERSION?: string;
  OPENAI_ORGANIZATION?: string;
  // Document translator external API configuration
  DOCUMENT_TRANSLATOR_BASE_URL?: string;
  DOCUMENT_TRANSLATOR_API_KEY?: string;
  DOCUMENT_TRANSLATOR_API_KEY_HEADER?: string;
}

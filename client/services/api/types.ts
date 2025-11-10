import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

/**
 * API request/response types for frontend API client.
 *
 * These types define the contracts between frontend services and backend API routes.
 */

// ============================================================================
// Chat API Types
// ============================================================================

/**
 * Standard chat request.
 */
export interface StandardChatApiRequest {
  model: OpenAIModel;
  messages: Message[];
  prompt?: string;
  temperature?: number;
  stream?: boolean;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  verbosity?: 'low' | 'medium' | 'high';
  botId?: string;
}

/**
 * RAG chat request.
 */
export interface RAGChatApiRequest {
  model: OpenAIModel;
  messages: Message[];
  botId: string;
  stream?: boolean;
}

/**
 * Agent chat request.
 */
export interface AgentChatApiRequest {
  model: OpenAIModel;
  messages: Message[];
  temperature?: number;
  threadId?: string;
  forcedAgentType?: string;
  botId?: string;
}

/**
 * Audio/video chat request.
 */
export interface AudioChatApiRequest {
  model: OpenAIModel;
  messages: Message[];
  stream?: boolean;
  botId?: string;
}

/**
 * Chat response (non-streaming).
 */
export interface ChatApiResponse {
  text: string;
}

// ============================================================================
// File API Types
// ============================================================================

/**
 * File upload request.
 */
export interface FileUploadApiRequest {
  filename: string;
  filetype: 'image' | 'file';
  content: string; // base64 encoded
}

/**
 * File upload response.
 */
export interface FileUploadApiResponse {
  url: string;
  filename: string;
}

// ============================================================================
// Tones API Types
// ============================================================================

/**
 * Tone analysis request.
 */
export interface ToneAnalysisApiRequest {
  text: string;
}

/**
 * Tone analysis response.
 */
export interface ToneAnalysisApiResponse {
  tone: string;
  confidence: number;
}

// ============================================================================
// Prompts API Types
// ============================================================================

/**
 * Prompt revision request.
 */
export interface PromptRevisionApiRequest {
  prompt: string;
  instructions?: string;
}

/**
 * Prompt revision response.
 */
export interface PromptRevisionApiResponse {
  revisedPrompt: string;
}

// ============================================================================
// Generic API Types
// ============================================================================

/**
 * Generic API error response.
 */
export interface ApiErrorResponse {
  error: string;
  message: string;
}

/**
 * Request configuration for API client.
 */
export interface ApiRequestConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
  signal?: AbortSignal;
}

import { Session } from 'next-auth';

import { OpenAIModel } from '@/types/openai';

/**
 * Tool interface for all tools that can be executed by the chat system.
 */
export interface Tool {
  readonly type: string;
  readonly name: string;
  readonly description: string;

  /**
   * Executes the tool with the given parameters.
   */
  execute(params: any): Promise<ToolResult>;
}

/**
 * Result returned by tool execution.
 */
export interface ToolResult {
  text: string;
  citations?: Array<{
    number: number;
    title: string;
    url: string;
    date: string;
  }>;
  metadata?: Record<string, any>;
}

/**
 * Parameters for web search tool.
 */
export interface WebSearchToolParams {
  searchQuery: string;
  /**
   * Multi-aspect fan-out (first entry === searchQuery, max 5). Feed
   * providers run one Google News leg per query concurrently and merge;
   * the Bing agent path uses only the primary query (the agent does its
   * own query expansion).
   */
  searchQueries?: string[];
  /** Agent-backed model for the Bing path; unused by google-news. */
  model?: OpenAIModel;
  user: Session['user'];
  /** Maximum distinct sources to request from the search agent. */
  resultCount?: number;
  /** Recency the agent should prefer ('any' = no preference). */
  freshness?: 'day' | 'week' | 'month' | 'any';
  /**
   * Resolved search backend for this request (user setting or deployment
   * default). Falls back to the WEB_SEARCH_PROVIDER env when absent.
   */
  provider?: 'news' | 'gdelt' | 'google-news' | 'bing-agent' | 'combined';
  /**
   * Combined provider only: fires once with the fast leg's (Google News)
   * headlines while the Bing agent is still running, so the caller can
   * stream them to the client as interim results.
   */
  onInterimResults?: (
    entries: import('@/types/webSearch').SearchHeadlineEntry[],
  ) => void;
  /**
   * Router's read of the information need (searchComprehensive). Deep
   * (research-style) searches wait on every news feed for maximum source
   * coverage; surface lookups answer from the fastest feed and use the
   * slower one only as a failure fallback.
   */
  deep?: boolean;
  /**
   * Live progress from inside the search sub-call (activity keys from the
   * inner Foundry stream), forwarded to the outer response's loader.
   */
  onActivity?: (key: string, params?: Record<string, string>) => void;
}

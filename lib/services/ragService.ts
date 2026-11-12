import { Session } from 'next-auth';

import {
  type QueryReformulationRouting,
  type QueryReformulator,
  buildKnowledgeBaseReformulationPrompt,
  messageText,
  rewriteConversationHistory,
} from '@/lib/services/search/queryReformulation';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { Message } from '@/types/chat';
import { OrganizationAgent } from '@/types/organizationAgent';
import { Citation, SearchResult } from '@/types/rag';

import { DefaultAzureCredential } from '@azure/identity';
import { SearchClient } from '@azure/search-documents';
import type OpenAI from 'openai';

/**
 * Service for handling Retrieval-Augmented Generation (RAG) operations:
 * knowledge-base search (with a residency-routed query rewrite) and the
 * citation bookkeeping for the answer that cites it.
 */
export class RAGService {
  private searchClient: SearchClient<SearchResult>;
  private reformulator: QueryReformulator;
  private searchIndex: string;
  public searchDocs: SearchResult[] = [];

  // Map to track source numbers presented to the model and their corresponding documents
  private sourcesNumberMap: Map<number, SearchResult> = new Map();

  // Citation tracking properties
  private citationBuffer: string = '';
  private sourceToSequentialMap: Map<number, number> = new Map();
  private citationsUsed: Set<number> = new Set();
  private isInCitation: boolean = false;
  private pendingCitations: string = '';

  /**
   * Creates a new instance of RAGService.
   * @param {string} searchEndpoint - The endpoint URL for the Azure Search service.
   * @param {string} searchIndex - The name of the search index to query.
   * @param {QueryReformulator} reformulator - Rewrites search queries under the user's residency.
   */
  constructor(
    searchEndpoint: string,
    searchIndex: string,
    reformulator: QueryReformulator,
  ) {
    // Use DefaultAzureCredential for managed identity authentication
    this.searchClient = new SearchClient<SearchResult>(
      searchEndpoint,
      searchIndex,
      new DefaultAzureCredential(),
    );
    this.reformulator = reformulator;
    this.searchIndex = searchIndex;
  }

  /**
   * Rewrites the latest question into a search query, using the
   * conversation to resolve follow-ups and turning relative dates into
   * explicit months. Runs under the user's residency (see
   * lib/services/search/queryReformulation.ts); any failure falls back to
   * the raw question, so retrieval quality degrades but the search runs.
   *
   * @param {Message[]} messages - The conversation messages to analyze.
   * @param {QueryReformulationRouting} routing - Residency region and chat-model fallback.
   * @returns {Promise<string>} The reformulated query, or the raw question.
   */
  async reformulateQuery(
    messages: Message[],
    routing: QueryReformulationRouting,
  ): Promise<string> {
    const originalQuery = this.extractQuery(messages);
    const conversationHistory = rewriteConversationHistory(messages);

    const result = await this.reformulator.reformulate(
      buildKnowledgeBaseReformulationPrompt(conversationHistory, originalQuery),
      routing,
    );
    const query = result?.query ?? originalQuery;
    console.log(`Original query: "${sanitizeForLog(originalQuery)}"`);
    console.log(
      `Expanded query: "${sanitizeForLog(query)}" (${result?.source ?? 'raw question'})`,
    );
    return query;
  }

  /**
   * Performs a search operation based on the conversation messages.
   * Uses query reformulation for follow-up questions to capture conversation context.
   *
   * @param {Message[]} messages - The conversation messages to extract query from.
   * @param {OrganizationAgent} agent - The resolved organization agent (static or admin-authored).
   * @param {Session['user']} user - User information for logging.
   * @returns {Promise<{searchDocs: SearchResult[], searchMetadata: {dateRange: DateRange, resultCount: number}}>}
   *          Returns search results and metadata including date range of results.
   * @throws {Error} If the specified agent is not found.
   */
  public async performSearch(
    messages: Message[],
    agent: OrganizationAgent,
    user: Session['user'],
    routing: QueryReformulationRouting,
  ) {
    const startTime = Date.now();

    try {
      // Always reformulate queries to handle temporal references and improve search
      const query = await this.reformulateQuery(messages, routing);

      // Get ragConfig from agent (if available)
      const ragConfig = agent.ragConfig || {};
      const topK = ragConfig.topK || 10;

      // Get semantic config from agent ragConfig if available, otherwise use index default
      const semanticConfig =
        ragConfig.semanticConfig ||
        `${this.searchIndex}-semantic-configuration`;

      // Fetch slightly more than topK to allow for deduplication
      // Azure's BoostedRerankerScore already applies freshness boost from dateScore profile
      const fetchCount = Math.min(topK * 2, 20);

      // Perform hybrid search: vector + semantic with reranking
      // Azure applies dateScore freshness boost via BoostedRerankerScore
      const searchResults = await this.searchClient.search(query, {
        select: ['chunk', 'title', 'date', 'url', 'chunk_id'],
        top: fetchCount,
        queryType: 'semantic',
        semanticSearchOptions: {
          configurationName: semanticConfig,
          captions: { captionType: 'extractive' },
          answers: { answerType: 'extractive', count: 3 },
        },
        vectorSearchOptions: {
          queries: [
            {
              kind: 'text',
              text: query,
              fields: ['text_vector'] as any,
              kNearestNeighborsCount: fetchCount,
            },
          ],
        },
      });

      const allDocs: SearchResult[] = [];

      // Collect results - Azure already returns them in boosted order
      for await (const result of searchResults.results) {
        const doc = result.document;
        const rerankerScore = result.rerankerScore ?? 0;

        console.log(
          `[RAGService] Result: ${doc.title} (date: ${doc.date}, rerankerScore: ${rerankerScore.toFixed(2)})`,
        );

        allDocs.push(doc);
      }

      // Deduplicate by chunk_id and limit chunks per article for source diversity
      const seenChunkIds = new Set<string>();
      const chunksPerUrl = new Map<string, number>();
      const MAX_CHUNKS_PER_ARTICLE = 2; // Ensure diverse sources

      const searchDocs: SearchResult[] = [];
      for (const doc of allDocs) {
        if (searchDocs.length >= topK) break;

        const chunkId = doc.chunk_id || '';
        const url = doc.url || '';

        // Skip duplicate chunks
        if (chunkId && seenChunkIds.has(chunkId)) {
          continue;
        }

        // Limit chunks per article to ensure source diversity
        const currentCount = chunksPerUrl.get(url) || 0;
        if (currentCount >= MAX_CHUNKS_PER_ARTICLE) {
          continue;
        }

        if (chunkId) seenChunkIds.add(chunkId);
        chunksPerUrl.set(url, currentCount + 1);
        searchDocs.push(doc);
      }

      // Calculate date range from final results
      let newestDate: Date | null = null;
      let oldestDate: Date | null = null;
      for (const doc of searchDocs) {
        const docDate = new Date(doc.date);
        if (!newestDate || docDate > newestDate) newestDate = docDate;
        if (!oldestDate || docDate < oldestDate) oldestDate = docDate;
      }

      const searchMetadata = {
        dateRange: {
          newest: newestDate?.toISOString().split('T')[0] || null,
          oldest: oldestDate?.toISOString().split('T')[0] || null,
        },
        resultCount: searchDocs.length,
      };

      console.log(
        `[RAGService] After deduplication: ${allDocs.length} -> ${searchDocs.length} results`,
      );

      // Log successful search
      console.log('[RAGService] Search completed:', {
        duration: Date.now() - startTime,
        agentId: agent.id,
        resultsCount: searchDocs.length,
        dateRange: searchMetadata.dateRange,
        userId: user?.id,
      });

      return {
        searchDocs, // Already deduplicated above
        searchMetadata,
      };
    } catch (error) {
      // Log search error
      console.error('[RAGService] Search error:', {
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
        agentId: agent.id,
        userId: user?.id,
      });
      throw error;
    }
  }

  /**
   * Deduplication of search results by chunk_id.
   * This allows multiple chunks from the same article (same URL/title) while
   * preventing duplicate chunks from appearing.
   *
   * @param {SearchResult[]} results - The search results to deduplicate.
   * @returns {SearchResult[]} Deduplicated search results.
   */
  private deduplicateResults(results: SearchResult[]): SearchResult[] {
    const uniqueResults: SearchResult[] = [];
    const seenChunkIds = new Set<string>();

    for (const result of results) {
      const chunkId = result.chunk_id || '';

      // If we have a chunk_id, use it for deduplication
      if (chunkId) {
        if (seenChunkIds.has(chunkId)) {
          continue;
        }
        seenChunkIds.add(chunkId);
      }

      uniqueResults.push(result);
    }

    return uniqueResults;
  }

  /**
   * Deduplicates citations while preserving the citation numbers used in the text.
   *
   * @param {Citation[]} citations - The citations to deduplicate.
   * @returns {Citation[]} Deduplicated citations with original numbering preserved.
   */
  public deduplicateCitations(citations: Citation[]): Citation[] {
    // Create a map to track unique sources by URL or title
    const uniqueSources = new Map<string, Citation>();
    const uniqueCitations: Citation[] = [];

    for (const citation of citations) {
      const key = citation.url || citation.title; // Use URL as primary key, fallback to title

      if (!uniqueSources.has(key)) {
        // This is a new unique source
        uniqueSources.set(key, citation);
        uniqueCitations.push(citation);
      }
      // If we've already seen this source, we don't add it again
      // The original citation number is preserved in the text
    }

    return uniqueCitations;
  }

  /**
   * Prepares messages for the chat completion by incorporating search results.
   * Now all sources are consolidated and given unique numbers.
   *
   * @param {Message[]} messages - The original conversation messages.
   * @param {OrganizationAgent} agent - The organization agent configuration to use.
   * @param {SearchResult[]} searchDocs - The search results to incorporate.
   * @returns {OpenAI.Chat.ChatCompletionMessageParam[]} Messages formatted for the chat completion API.
   */
  public getCompletionMessages(
    messages: Message[],
    agent: OrganizationAgent,
    searchDocs: SearchResult[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const query = this.extractQuery(messages);

    // Apply deduplication to ensure unique sources
    const uniqueSearchDocs = this.deduplicateResults(searchDocs);

    // Clear the existing sources number map
    this.sourcesNumberMap.clear();

    // Create a unified context string with deduped sources, consistently numbered
    const contextString =
      'Available sources:\n\n' +
      uniqueSearchDocs
        .map((doc, index) => {
          const sourceNumber = index + 1;
          const date = new Date(doc.date).toISOString().split('T')[0];

          // Store mapping of source number to document
          this.sourcesNumberMap.set(sourceNumber, doc);

          return `Source ${sourceNumber}:\nTitle: ${doc.title}\nDate: ${date}\nURL: ${doc.url}\nContent: ${doc.chunk}`;
        })
        .join('\n\n');

    // Add more informative context about the conversation for follow-up questions
    const isFollowUp = messages.filter((m) => m.role === 'user').length > 1;

    // Enhanced context note with better conversation awareness
    const searchInfoNote = isFollowUp
      ? '\n\nNote: This is a follow-up question in an ongoing conversation. ' +
        'Previous questions include: ' +
        messages
          .filter((m) => m.role === 'user')
          .slice(0, -1) // All except the current question
          .map((m) => `"${typeof m.content === 'string' ? m.content : ''}"`)
          .join(', ') +
        '. The search query has been reformulated to capture the full context of the conversation.'
      : '';

    return [
      ...messages.slice(0, -1).map((msg) => ({
        role: msg.role as 'assistant' | 'user' | 'system',
        content:
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content),
      })),
      {
        role: 'user' as const,
        content: `${contextString}${searchInfoNote}\n\nQuestion: ${query}`,
      },
    ];
  }

  /**
   * Extracts the search query from the conversation messages.
   *
   * @param {Message[]} messages - The conversation messages to extract from.
   * @returns {string} The extracted query from the last user message.
   * @throws {Error} If no user message is found.
   */
  public extractQuery(messages: Message[]): string {
    const lastUserMessage = messages
      .slice()
      .reverse()
      .find((m) => m.role === 'user');
    if (!lastUserMessage?.content) throw new Error('No user message found');
    return messageText(lastUserMessage.content);
  }

  /**
   * Initializes citation tracking state for processing a new response.
   * This is used within a single request lifecycle and doesn't need to persist.
   *
   * @param {boolean} preserveSourceMap - Whether to preserve the source number mapping.
   */
  public initCitationTracking(preserveSourceMap: boolean = false) {
    this.citationBuffer = '';
    this.sourceToSequentialMap.clear();
    this.citationsUsed.clear();
    this.isInCitation = false;
    this.pendingCitations = '';

    // Only clear the source mapping if explicitly requested
    if (!preserveSourceMap) {
      this.sourcesNumberMap.clear();
    }
  }

  /**
   * Processes citation markers in a chunk of text, maintaining citation tracking state.
   * Handles both single and consecutive citations, and text within brackets.
   *
   * @param {string} chunk - The text chunk to process.
   * @returns {string} The processed text with sequential citation numbers.
   */
  public processCitationInChunk(chunk: string): string {
    if (!this.isInCitation && !chunk.includes('[') && !this.pendingCitations) {
      return chunk;
    }

    let result = '';
    let currentPosition = 0;
    let textBuffer = '';

    const flushPendingCitations = () => {
      if (this.pendingCitations) {
        result += this.pendingCitations;
        this.pendingCitations = '';
      }
    };

    while (currentPosition < chunk.length) {
      const char = chunk[currentPosition];

      if (!this.isInCitation && char === '[') {
        // Check if this is a text bracket (contains letters) rather than a citation number
        const remainingChunk = chunk.slice(currentPosition);
        const textBracketMatch = remainingChunk.match(
          /^\[[^\]]*[a-zA-Z][^\]]*\]/,
        );
        if (textBracketMatch) {
          flushPendingCitations();
          if (textBuffer) {
            result += textBuffer;
            textBuffer = '';
          }
          result += textBracketMatch[0];
          currentPosition += textBracketMatch[0].length;
          continue;
        }

        // Output any buffered text before starting new citation
        if (textBuffer) {
          result += textBuffer;
          textBuffer = '';
        }
        this.isInCitation = true;
        this.citationBuffer = '[';
        currentPosition++;
        continue;
      }

      if (this.isInCitation) {
        this.citationBuffer += char;
        currentPosition++;

        if (char === ']') {
          const match = this.citationBuffer.match(/\[(\d+)\]/);
          if (match) {
            const sourceNumber = parseInt(match[1], 10);
            if (!this.sourceToSequentialMap.has(sourceNumber)) {
              const nextNumber = this.citationsUsed.size + 1;
              this.sourceToSequentialMap.set(sourceNumber, nextNumber);
              this.citationsUsed.add(nextNumber);
            }
            const sequentialNumber =
              this.sourceToSequentialMap.get(sourceNumber)!;
            this.pendingCitations += `[${sequentialNumber}]`;

            // Look ahead for another citation
            if (
              currentPosition < chunk.length &&
              chunk[currentPosition] === '['
            ) {
              this.citationBuffer = '';
              this.isInCitation = false;
              continue;
            }

            // No more citations, flush pending
            flushPendingCitations();
            this.citationBuffer = '';
            this.isInCitation = false;
          } else {
            // Invalid citation format
            if (textBuffer) {
              result += textBuffer;
              textBuffer = '';
            }
            result += this.citationBuffer;
            this.citationBuffer = '';
            this.isInCitation = false;
          }
        }
      } else {
        textBuffer += char;
        currentPosition++;
      }
    }

    // End of chunk processing
    if (this.isInCitation) {
      // In the middle of a citation - keep the buffer
      if (textBuffer) {
        result += textBuffer;
      }
      return result;
    }

    // Flush any remaining citations and text
    if (this.pendingCitations) {
      // Only flush pending citations if we have text after them
      if (textBuffer) {
        result += this.pendingCitations + textBuffer;
        this.pendingCitations = '';
        textBuffer = '';
      }
    } else if (textBuffer) {
      result += textBuffer;
    }

    return result;
  }

  /**
   * Processes citations in the complete content and returns citation information.
   * Preserves the source mapping when initializing citation tracking.
   *
   * @param {string} content - The complete content to process citations for.
   * @returns {Citation[]} Array of citations with metadata.
   */
  public processCitationsInContent(content: string): Citation[] {
    // Initialize citation tracking but preserve the source number mapping
    this.initCitationTracking(true);

    // Process the entire content as one chunk to get citation mappings
    this.processCitationInChunk(content);
    return this.getCurrentCitations();
  }

  /**
   * Gets the current state of processed citations, using the source number mapping.
   *
   * @returns {Citation[]} Array of citations sorted by sequential number,
   *          including title, date, URL, and citation number.
   */
  public getCurrentCitations(): Citation[] {
    // Create array of citations sorted by sequential number
    const citations: Citation[] = [];

    // Go through each sequential number in order
    for (let i = 1; i <= this.citationsUsed.size; i++) {
      // Find the source number that maps to this sequential number
      const sourceNumber = Array.from(
        this.sourceToSequentialMap.entries(),
      ).find(([_, seq]) => seq === i)?.[0];

      if (sourceNumber !== undefined) {
        // Get the document from our mapping, not by array index
        const doc = this.sourcesNumberMap.get(sourceNumber);

        if (doc) {
          citations.push({
            title: doc.title,
            date: new Date(doc.date).toISOString().split('T')[0],
            url: doc.url,
            number: i,
          });
        } else {
          console.warn(
            `Citation references non-existent source number: ${sourceNumber}`,
          );
        }
      }
    }

    return citations;
  }
}

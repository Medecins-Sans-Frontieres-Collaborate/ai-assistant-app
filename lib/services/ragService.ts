import { Session } from 'next-auth';

import { createAzureOpenAIStreamProcessor } from '@/lib/utils/app/stream/streamProcessor';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { Message } from '@/types/chat';
import { OrganizationAgent } from '@/types/organizationAgent';
import { Citation, SearchResult } from '@/types/rag';

import { getOrganizationAgentById } from '@/lib/organizationAgents';
import { DefaultAzureCredential } from '@azure/identity';
import { SearchClient } from '@azure/search-documents';
import OpenAI from 'openai';
import { ChatCompletion } from 'openai/resources';

/**
 * Service for handling Retrieval-Augmented Generation (RAG) operations.
 * Integrates search functionality with OpenAI chat completions.
 */
export class RAGService {
  private searchClient: SearchClient<SearchResult>;
  private openAIClient: OpenAI;
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
   * @param {OpenAI} openAIClient - Client for making OpenAI API calls (Foundry endpoint).
   */
  constructor(
    searchEndpoint: string,
    searchIndex: string,
    openAIClient: OpenAI,
  ) {
    // Use DefaultAzureCredential for managed identity authentication
    this.searchClient = new SearchClient<SearchResult>(
      searchEndpoint,
      searchIndex,
      new DefaultAzureCredential(),
    );
    this.openAIClient = openAIClient;
    this.searchIndex = searchIndex;
  }

  /**
   * Augments chat messages with relevant search results and generates a completion.
   * Supports both streaming and non-streaming responses.
   *
   * @param {Message[]} messages - The conversation messages to augment.
   * @param {string} agentId - The ID of the organization agent to use for the completion.
   * @param {string} modelId - The ID of the model to use for completion.
   * @param {boolean} [stream=false] - Whether to stream the response.
   * @param {Session['user']} user - User information for logging.
   * @returns {Promise<ReadableStream | ChatCompletion>}
   *          Returns either a streaming response or chat completion depending on the stream parameter.
   * @throws {Error} If the specified agent is not found.
   */
  async augmentMessages(
    messages: Message[],
    agentId: string,
    modelId: string,
    stream: boolean = false,
    user: Session['user'],
  ): Promise<ReadableStream | ChatCompletion> {
    const startTime = Date.now();

    try {
      // Initialize citation tracking for this request
      this.initCitationTracking(true);

      const { searchDocs, searchMetadata } = await this.performSearch(
        messages,
        agentId,
        user,
      );
      this.searchDocs = searchDocs;

      const agent = getOrganizationAgentById(agentId);
      if (!agent) throw new Error(`Organization agent ${agentId} not found`);

      const systemPrompt = agent.systemPrompt || '';

      const enhancedMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: `${systemPrompt}

CRITICAL CITATION RULES - YOU MUST FOLLOW THESE:
- Cite sources inline using [#] notation immediately after the relevant information
- Use SEPARATE brackets for each source like [1][2][3] - NEVER group them like [1,2,3]
- NEVER include a "Sources:", "References:", or similar section listing sources
- NEVER list sources at the end of your response - the frontend handles this automatically
- NEVER create bullet points or numbered lists of sources with titles/dates
- Only use citation numbers that exist in the provided sources (e.g., [1], [2])
- The user interface will display clickable source cards - your job is ONLY to cite inline with [#]

Example of CORRECT formatting:
"The outbreak affected thousands of people [1][2]. Vaccination rates remain low [3]."

Example of WRONG formatting (DO NOT DO THIS):
"The outbreak affected thousands of people [1,2]."

Example of WRONG formatting (DO NOT DO THIS):
"Sources:
[1] Article Title, Date
[2] Another Article, Date"

The frontend automatically shows source information. Just cite inline and end your response naturally.`,
        },
        ...this.getCompletionMessages(messages, agent, searchDocs),
      ];

      if (stream) {
        const streamResponse = await this.openAIClient.chat.completions.create({
          model: modelId,
          messages: enhancedMessages,
          temperature: 0.5,
          stream: true,
        });

        // Process the stream and log after citations are processed
        const processedStream = createAzureOpenAIStreamProcessor(
          streamResponse,
          this,
        );

        // Log completion
        console.log('[RAGService] Chat completion (streaming):', {
          duration: Date.now() - startTime,
          modelId,
          messageCount: messages.length,
          agentId,
          userId: user?.id,
        });

        return processedStream;
      } else {
        const completion = await this.openAIClient.chat.completions.create({
          model: modelId,
          messages: enhancedMessages,
          temperature: 0.5,
          stream: false,
        });

        const content = completion.choices[0]?.message?.content || '';

        // Process citations but preserve the source mapping
        const citations = this.processCitationsInContent(content);

        // Deduplicate citations for display
        const uniqueCitations = this.deduplicateCitations(citations);

        // Format the content to include metadata at the end
        const metadataSection = `\n\nSources used: ${uniqueCitations
          .map((c) => `[${c.number}] ${c.title}`)
          .join(', ')}
        Date range: ${searchMetadata.dateRange.oldest || 'N/A'} to ${
          searchMetadata.dateRange.newest || 'N/A'
        }
        Total sources: ${uniqueCitations.length}`;

        // Update the completion with the enhanced content
        completion.choices[0].message.content = content + metadataSection;

        // Log completion
        console.log('[RAGService] Chat completion (non-streaming):', {
          duration: Date.now() - startTime,
          modelId,
          messageCount: messages.length,
          agentId,
          userId: user?.id,
        });

        return completion;
      }
    } catch (error) {
      console.error('Error in augmentMessages:', sanitizeForLog(error));
      throw error;
    }
  }

  /**
   * Uses an LLM to reformulate the query with full conversation context
   * for improved search results on follow-up questions.
   *
   * @param {Message[]} messages - The conversation messages to analyze.
   * @returns {Promise<string>} The reformulated query with context.
   */
  async reformulateQuery(messages: Message[]): Promise<string> {
    try {
      // Extract original query from the last user message
      const originalQuery = this.extractQuery(messages);

      // Get relevant conversation history (last few messages)
      const conversationHistory = messages
        .slice(-5)
        .map(
          (m) =>
            `${m.role}: ${
              typeof m.content === 'string'
                ? m.content
                : JSON.stringify(m.content)
            }`,
        )
        .join('\n');

      console.log('Reformulating query with conversation context');

      // Azure-optimized system prompt
      const systemPrompt = `You are a search query optimizer for Azure AI Search.

        Your task is to create concise, effective search queries that:
        1. Prioritize recent information by default when appropriate (using terms like "latest," "recent," "this week," "today")
        2. Respect the original intent when the query is about historical events
        3. Include key entities and concepts from the original query and conversation context
        4. Work effectively with Azure AI Search semantic ranking

        GUIDELINES FOR AZURE AI SEARCH:
        - Keep queries CONCISE (under 20 words)
        - Focus on CORE CONCEPTS and ENTITIES
        - Use NATURAL LANGUAGE phrasing
        - Include 1-2 temporal terms at most when prioritizing recency
        - Avoid complex boolean operators or syntax

        Return ONLY the reformulated search query with no additional text.`;

      // Ask the model to generate an improved search query
      // Use low temperature for focused, deterministic query generation
      const completion = await this.openAIClient.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Conversation history:\n${conversationHistory}\n\nOriginal query: ${originalQuery}\n\nGenerate an improved Azure AI Search query that captures the key concepts and appropriately handles recency.`,
          },
        ],
        temperature: 0.2,
      });

      const expandedQuery =
        completion.choices[0]?.message?.content?.trim() || originalQuery;

      console.log(`Original query: "${sanitizeForLog(originalQuery)}"`);
      console.log(`Expanded query: "${sanitizeForLog(expandedQuery)}"`);

      return expandedQuery;
    } catch (error) {
      console.error('Error reformulating query:', sanitizeForLog(error));
      // Fall back to the original query if reformulation fails
      return this.extractQuery(messages);
    }
  }

  /**
   * Performs a search operation based on the conversation messages.
   * Uses query reformulation for follow-up questions to capture conversation context.
   *
   * @param {Message[]} messages - The conversation messages to extract query from.
   * @param {string} agentId - The ID of the organization agent making the search request.
   * @param {Session['user']} user - User information for logging.
   * @returns {Promise<{searchDocs: SearchResult[], searchMetadata: {dateRange: DateRange, resultCount: number}}>}
   *          Returns search results and metadata including date range of results.
   * @throws {Error} If the specified agent is not found.
   */
  public async performSearch(
    messages: Message[],
    agentId: string,
    user: Session['user'],
  ) {
    const startTime = Date.now();

    try {
      const agent = getOrganizationAgentById(agentId);
      if (!agent) throw new Error(`Organization agent ${agentId} not found`);

      // Use query reformulation for follow-up questions
      const isFollowUpQuestion =
        messages.filter((m) => m.role === 'user').length > 1;
      let query;

      if (isFollowUpQuestion) {
        // Reformulate the query for better context in follow-up questions
        query = await this.reformulateQuery(messages);
      } else {
        // Use the original query for the first question
        query = this.extractQuery(messages);
      }

      // Get ragConfig from agent (if available)
      const ragConfig = agent.ragConfig || {};
      const topK = ragConfig.topK || 10;

      // Get semantic config from agent ragConfig if available, otherwise use index default
      const semanticConfig =
        ragConfig.semanticConfig ||
        `${this.searchIndex}-semantic-configuration`;

      // Perform hybrid search: vector + semantic with reranking
      // Fetch more results (30) to allow for quality filtering and deduplication
      const searchResults = await this.searchClient.search(query, {
        select: ['chunk', 'title', 'date', 'url', 'chunk_id'],
        top: 30,
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
              kNearestNeighborsCount: 30,
            },
          ],
        },
      });

      const allDocs: Array<{
        doc: SearchResult;
        rerankerScore: number;
        combinedScore: number;
      }> = [];

      const TWO_YEARS_AGO = new Date();
      TWO_YEARS_AGO.setFullYear(TWO_YEARS_AGO.getFullYear() - 2);
      const NOW = Date.now();
      const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

      // Collect all results from semantic search with scores
      for await (const result of searchResults.results) {
        const doc = result.document;
        const docDate = new Date(doc.date);
        const rerankerScore = result.rerankerScore ?? 0;

        // Filter out very old documents with low reranker scores
        if (docDate < TWO_YEARS_AGO && rerankerScore < 2.0) {
          console.log(
            `[RAGService] Filtering old low-relevance doc: ${doc.title} (date: ${doc.date}, rerankerScore: ${rerankerScore})`,
          );
          continue;
        }

        // Calculate recency boost (0-1 scale, 1 = today, 0 = 1+ year old)
        const ageMs = NOW - docDate.getTime();
        const recencyScore = Math.max(0, 1 - ageMs / ONE_YEAR_MS);

        // Combined score: 70% semantic relevance + 30% recency
        // Normalize rerankerScore (typically 0-4) to 0-1 scale
        const normalizedRerankerScore = Math.min(rerankerScore / 4, 1);
        const combinedScore =
          normalizedRerankerScore * 0.7 + recencyScore * 0.3;

        console.log(
          `[RAGService] Result: ${doc.title} (date: ${doc.date}, rerankerScore: ${rerankerScore.toFixed(2)}, combinedScore: ${combinedScore.toFixed(2)})`,
        );

        allDocs.push({ doc, rerankerScore, combinedScore });
      }

      // Deduplicate by chunk_id and limit chunks per article for source diversity
      const seenChunkIds = new Set<string>();
      const chunksPerUrl = new Map<string, number>();
      const MAX_CHUNKS_PER_ARTICLE = 2; // Ensure diverse sources

      const deduplicatedDocs = allDocs.filter(({ doc }) => {
        const chunkId = doc.chunk_id || '';
        const url = doc.url || '';

        // Skip duplicate chunks
        if (chunkId && seenChunkIds.has(chunkId)) {
          return false;
        }

        // Limit chunks per article to ensure source diversity
        const currentCount = chunksPerUrl.get(url) || 0;
        if (currentCount >= MAX_CHUNKS_PER_ARTICLE) {
          return false;
        }

        if (chunkId) seenChunkIds.add(chunkId);
        chunksPerUrl.set(url, currentCount + 1);
        return true;
      });

      // Sort by combined score (relevance + recency)
      const sortedDocs = deduplicatedDocs.sort(
        (a, b) => b.combinedScore - a.combinedScore,
      );

      // Take top results based on agent config
      const searchDocs = sortedDocs.slice(0, topK).map((item) => item.doc);

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
        `[RAGService] After filtering and deduplication: ${allDocs.length} -> ${deduplicatedDocs.length} -> ${searchDocs.length} results`,
      );

      // Log successful search
      console.log('[RAGService] Search completed:', {
        duration: Date.now() - startTime,
        agentId,
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
        agentId,
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
    return typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : '';
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

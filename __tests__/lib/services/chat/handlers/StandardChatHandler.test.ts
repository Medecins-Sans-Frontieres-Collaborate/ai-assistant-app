import { StandardChatService } from '@/lib/services/chat/StandardChatService';
import { StandardChatHandler } from '@/lib/services/chat/handlers/StandardChatHandler';
import { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';

import { Message, MessageType } from '@/types/chat';

import { createTestChatContext } from '../testUtils';

import { describe, expect, it } from 'vitest';

// buildFinalMessages is private; expose it via a narrow cast for unit tests.
type HandlerInternals = {
  buildFinalMessages(context: ChatContext): Message[];
};

function createHandler(): HandlerInternals {
  const service = {} as StandardChatService;
  return new StandardChatHandler(service) as unknown as HandlerInternals;
}

describe('StandardChatHandler.buildFinalMessages', () => {
  it('injects fileSummaries into the last message when content is a plain string', () => {
    const handler = createHandler();
    const context = createTestChatContext({
      messages: [
        {
          role: 'user',
          content: 'Summarize this for me',
          messageType: MessageType.TEXT,
        },
      ],
      processedContent: {
        fileSummaries: [
          {
            filename: 'report.xlsx',
            summary: 'Revenue grew 12% YoY',
            originalContent: '',
          },
        ],
      },
    });

    const result = handler.buildFinalMessages(context);

    expect(result).toHaveLength(1);
    const content = result[0].content;
    expect(typeof content).toBe('string');
    expect(content as string).toContain('Summarize this for me');
    expect(content as string).toContain('[Document summary: report.xlsx]');
    expect(content as string).toContain('Revenue grew 12% YoY');
  });

  it('composes processedContent on top of enrichedMessages (web search + file summary)', () => {
    const handler = createHandler();

    // Simulate what ToolRouterEnricher does when web search runs:
    // prepend search context to the last user message and store as enrichedMessages.
    const enrichedLastContent =
      'Web Search results:\n\nlatest MSF news...\n\n---\n\nWhat happened?';

    const context = createTestChatContext({
      messages: [
        {
          role: 'user',
          content: 'What happened?',
          messageType: MessageType.TEXT,
        },
      ],
      enrichedMessages: [
        {
          role: 'user',
          content: enrichedLastContent,
          messageType: MessageType.TEXT,
        },
      ],
      processedContent: {
        fileSummaries: [
          {
            filename: 'brief.pdf',
            summary: 'Operational brief text',
            originalContent: '',
          },
        ],
      },
    });

    const result = handler.buildFinalMessages(context);

    expect(result).toHaveLength(1);
    const content = result[0].content as string;
    // Search context from enrichedMessages is preserved
    expect(content).toContain('Web Search results');
    expect(content).toContain('latest MSF news');
    // File summary from processedContent is also present
    expect(content).toContain('[Document summary: brief.pdf]');
    expect(content).toContain('Operational brief text');
  });

  it('injects fileSummaries into array-content messages and drops file_url items', () => {
    const handler = createHandler();
    const context = createTestChatContext({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarize this for me' },
            {
              type: 'file_url',
              url: 'https://example.com/report.xlsx',
              originalFilename: 'report.xlsx',
            },
          ],
          messageType: MessageType.FILE,
        },
      ],
      processedContent: {
        fileSummaries: [
          {
            filename: 'report.xlsx',
            summary: 'Revenue grew 12% YoY',
            originalContent: '',
          },
        ],
      },
    });

    const result = handler.buildFinalMessages(context);

    expect(result).toHaveLength(1);
    const content = result[0].content;
    // Only one text item remains; stripUnsupportedContentTypes collapses to a string
    expect(typeof content).toBe('string');
    expect(content as string).toContain('Summarize this for me');
    expect(content as string).toContain('[Document summary: report.xlsx]');
    expect(content as string).toContain('Revenue grew 12% YoY');
    // file_url must not leak through
    expect(content as string).not.toContain('file_url');
    expect(content as string).not.toContain('https://example.com/report.xlsx');
  });

  it('passes messages through unchanged when neither enrichedMessages nor processedContent has injectable content', () => {
    const handler = createHandler();
    const context = createTestChatContext({
      messages: [
        {
          role: 'user',
          content: 'Hello there',
          messageType: MessageType.TEXT,
        },
      ],
      processedContent: {},
    });

    const result = handler.buildFinalMessages(context);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Hello there');
  });
});

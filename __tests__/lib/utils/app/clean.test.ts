import { cleanConversationHistory, cleanMarkdown } from '@/lib/utils/app/clean';
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
} from '@/lib/utils/app/const';

import { Conversation } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { beforeEach, describe, expect, it, vi } from 'vitest';

let tempConversation: Conversation = {
  id: '1',
  name: 'Test Conversation',
  model: OpenAIModels[OpenAIModelID.GPT_5_2],
  prompt: '',
  messages: [],
  folderId: '',
  temperature: 0,
};
let tempHistory: Conversation[] = [];

beforeEach(() => {
  // initialized with minimum properties for a "Conversation" type
  tempConversation = {
    id: '1',
    name: 'Test Conversation',
    model: OpenAIModels[OpenAIModelID.GPT_5_2],
    prompt: '',
    messages: [],
    folderId: '',
    temperature: 0,
  };

  tempHistory = [
    { ...tempConversation },
    { ...tempConversation, id: '2', name: 'Test 2' },
    { ...tempConversation, id: '3', name: 'Test 3' },
  ];
});

describe('Conversation tests', () => {
  it('cleans conversation history with valid array correctly', () => {
    const results: Conversation[] = cleanConversationHistory(tempHistory);

    for (const result of results) {
      expect(result.model).toBe(OpenAIModels[OpenAIModelID.GPT_5_2]);
      expect(result.prompt).toBe(DEFAULT_SYSTEM_PROMPT);
      expect(result.temperature).toBe(DEFAULT_TEMPERATURE);
      expect(result.folderId).toBe(null);
      expect(result.messages).toStrictEqual([]);
    }
  });

  it('returns an empty array when a non-array input is used for cleaning conversation history', () => {
    // @ts-ignore - testing error handling with invalid input
    const result = cleanConversationHistory('this is not an array');

    expect(result).toStrictEqual([]);
  });

  it('invalid conversation types are removed during clean', () => {
    // @ts-ignore
    tempHistory[1] = 'this is not a conversation';
    expect(tempHistory.length).toEqual(3);

    const originalWarn = console.warn;
    console.warn = vi.fn();

    let cleanHistory: Conversation[] = cleanConversationHistory(tempHistory);
    expect(console.warn).toBeCalledTimes(1);
    expect(cleanHistory.length).toEqual(2);

    console.warn = originalWarn;
  });
});

describe('cleanMarkdown', () => {
  it('removes headers', () => {
    const input = '# Header 1\n## Header 2\nText';
    const expected = 'Header 1\nHeader 2\nText';
    expect(cleanMarkdown(input)).toBe(expected);
  });

  it('removes bold and italic markers', () => {
    const input = 'This is **bold** and *italic* text';
    const expected = 'This is bold and italic text';
    expect(cleanMarkdown(input)).toBe(expected);
  });

  it('removes inline code backticks', () => {
    const input = 'This is `code` here';
    const expected = 'This is code here';
    expect(cleanMarkdown(input)).toBe(expected);
  });

  it('removes links but keeps text', () => {
    const input = 'Check [this link](https://example.com) out';
    const expected = 'Check this link out';
    expect(cleanMarkdown(input)).toBe(expected);
  });

  it('removes horizontal rules', () => {
    const input = 'Text above\n---\nText below';
    const expected = 'Text above\n\nText below';
    expect(cleanMarkdown(input)).toBe(expected);
  });

  it('removes blockquotes', () => {
    const input = '> This is a quote\nNormal text';
    const expected = 'This is a quote\nNormal text';
    expect(cleanMarkdown(input)).toBe(expected);
  });

  it('handles complex markdown', () => {
    const input =
      '# Title\n\nThis is **bold** and *italic* with `code` and [link](url).\n\n> Quote\n\n---';
    const result = cleanMarkdown(input);
    expect(result).not.toContain('#');
    expect(result).not.toContain('**');
    expect(result).not.toContain('*');
    expect(result).not.toContain('`');
    expect(result).not.toContain('[');
    expect(result).not.toContain('>');
  });

  it('trims whitespace', () => {
    const input = '  \n  Text  \n  ';
    const result = cleanMarkdown(input);
    expect(result).toBe('Text');
  });

  it('handles empty string', () => {
    expect(cleanMarkdown('')).toBe('');
  });
});

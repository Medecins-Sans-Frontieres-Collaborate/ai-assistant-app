import { ResponsesApiHandler } from '@/lib/services/chat/handlers/ResponsesApiHandler';

import { Message, MessageType } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import type { AzureOpenAI } from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMockClient = () =>
  ({
    responses: { create: vi.fn() },
  }) as unknown as AzureOpenAI;

const baseModel: OpenAIModel = {
  id: 'gpt-5.2',
  name: 'GPT-5.2',
  maxLength: 128000,
  tokenLimit: 16384,
  provider: 'openai',
  sdk: 'azure-openai',
  supportsTemperature: true,
  supportsReasoningEffort: true,
  supportsMinimalReasoning: true,
  supportsVerbosity: true,
  supportsResponsesApi: true,
};

describe('ResponsesApiHandler', () => {
  let handler: ResponsesApiHandler;

  beforeEach(() => {
    handler = new ResponsesApiHandler(createMockClient());
  });

  describe('prepareInput', () => {
    it('drops system messages (they travel via instructions)', () => {
      const messages: Message[] = [
        { role: 'system', content: 'be brief', messageType: MessageType.TEXT },
        { role: 'user', content: 'hi', messageType: MessageType.TEXT },
      ];

      expect(handler.prepareInput(messages)).toEqual([
        { role: 'user', content: 'hi' },
      ]);
    });

    it('strips prior-turn <think> blocks from assistant history', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q', messageType: MessageType.TEXT },
        {
          role: 'assistant',
          content: '<think>\nreasoning\n</think>\n\nAnswer',
          messageType: MessageType.TEXT,
        },
      ];

      expect(handler.prepareInput(messages)[1]).toEqual({
        role: 'assistant',
        content: 'Answer',
      });
    });

    it('maps multimodal user content to input_text / input_image parts', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAA', detail: 'auto' },
            },
          ],
          messageType: MessageType.TEXT,
        },
      ];

      expect(handler.prepareInput(messages)).toEqual([
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'what is this?' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,AAA',
              detail: 'auto',
            },
          ],
        },
      ]);
    });
  });

  describe('buildRequestParams', () => {
    const input = [{ role: 'user' as const, content: 'hi' }];

    it('requests reasoning summaries with the applied effort and stays stateless', () => {
      const params = handler.buildRequestParams(
        baseModel,
        input,
        'system prompt',
        0.7,
        true,
        'medium',
        'low',
      );

      expect(params.model).toBe('gpt-5.2');
      expect(params.instructions).toBe('system prompt');
      expect(params.store).toBe(false);
      expect(params.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
      expect(params.text).toEqual({ verbosity: 'low' });
      expect(params.temperature).toBe(0.7);
    });

    it('upgrades minimal effort to low when the model lacks minimal support', () => {
      const o3 = {
        ...baseModel,
        id: 'o3',
        supportsMinimalReasoning: false,
        supportsTemperature: false,
        supportsVerbosity: false,
      };
      const params = handler.buildRequestParams(
        o3,
        input,
        'p',
        0.7,
        true,
        'minimal',
      );

      expect(params.reasoning).toEqual({ effort: 'low', summary: 'auto' });
      expect(params.temperature).toBeUndefined();
      expect(params.text).toBeUndefined();
    });

    it('still asks for summaries when no effort was chosen', () => {
      const params = handler.buildRequestParams(
        baseModel,
        input,
        'p',
        0.7,
        true,
        undefined,
      );

      expect(params.reasoning).toEqual({ summary: 'auto' });
    });

    it('attaches the code_interpreter tool with uploaded file ids', () => {
      const params = handler.buildRequestParams(
        baseModel,
        input,
        'p',
        0.7,
        true,
        'medium',
        undefined,
        { fileIds: ['file_1', 'file_2'], forced: false },
      );

      expect(params.tools).toEqual([
        {
          type: 'code_interpreter',
          container: { type: 'auto', file_ids: ['file_1', 'file_2'] },
        },
      ]);
      // Not forced: no Run-code directive, but mounted files DO carry the
      // execute-don't-advise + same-format output instruction.
      expect(params.instructions).not.toContain(
        'The user has enabled "Run code"',
      );
      expect(params.instructions).toContain('SAME format as the input');
      expect(params.instructions).toContain('actually perform the task now');
    });

    it('appends the Run-code instruction when forced', () => {
      const params = handler.buildRequestParams(
        baseModel,
        input,
        'p',
        0.7,
        true,
        undefined,
        undefined,
        { fileIds: [], forced: true },
      );

      expect(params.tools).toEqual([
        { type: 'code_interpreter', container: { type: 'auto' } },
      ]);
      expect(params.instructions).toContain('use the code interpreter');
    });

    it('prefers the deployment name when configured', () => {
      const params = handler.buildRequestParams(
        { ...baseModel, deploymentName: 'my-gpt52-deployment' },
        input,
        'p',
        0.7,
        false,
      );
      expect(params.model).toBe('my-gpt52-deployment');
    });
  });

  describe('extractReasoningSummary', () => {
    it('joins summary_text parts from reasoning output items', () => {
      const response = {
        output: [
          {
            type: 'reasoning',
            summary: [
              { type: 'summary_text', text: 'First thought.' },
              { type: 'summary_text', text: 'Second thought.' },
            ],
          },
          { type: 'message', content: [] },
        ],
      } as any;

      expect(handler.extractReasoningSummary(response)).toBe(
        'First thought.\n\nSecond thought.',
      );
    });

    it('returns undefined when there is no reasoning output', () => {
      expect(
        handler.extractReasoningSummary({ output: [] } as any),
      ).toBeUndefined();
    });
  });
});

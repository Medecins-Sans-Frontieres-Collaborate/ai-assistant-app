import { parseMetadataFromContent } from '@/lib/utils/app/metadata';
import { createAnthropicStreamProcessor } from '@/lib/utils/app/stream/anthropicStreamProcessor';
import { createResponsesStreamProcessor } from '@/lib/utils/app/stream/responsesStreamProcessor';
import { createAzureOpenAIStreamProcessor } from '@/lib/utils/app/stream/streamProcessor';

import { describe, expect, it } from 'vitest';

async function* events(event: unknown): AsyncIterable<any> {
  yield event;
}

describe('transcription metadata across model stream processors', () => {
  const transcript = {
    filename: 'audio.wav',
    transcript: 'spoken content',
    jobId: 'job-1',
    languageMetadata: { language: 'ht', officiallySupported: false },
  };
  const processors = [
    [
      'Chat completions',
      () =>
        createAzureOpenAIStreamProcessor(
          events({ choices: [{ delta: { content: 'summary' } }] }),
          undefined,
          undefined,
          transcript,
        ),
    ],
    [
      'Responses',
      () =>
        createResponsesStreamProcessor(
          events({ type: 'response.output_text.delta', delta: 'summary' }),
          transcript,
        ),
    ],
    [
      'Anthropic',
      () =>
        createAnthropicStreamProcessor(
          events({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'summary' },
          }),
          undefined,
          transcript,
        ),
    ],
  ] as const;

  it.each(processors)(
    '%s keeps language status and job identity',
    async (_name, create) => {
      const content = await new Response(create()).text();
      const metadata = parseMetadataFromContent(content);
      expect(metadata.transcript).toEqual({
        ...transcript,
        processedContent: 'summary',
      });
      expect(metadata.content).toBe('summary');
    },
  );
});

import { parseMetadataFromContent } from '@/lib/utils/app/metadata';
import { createResponsesStreamProcessor } from '@/lib/utils/app/stream/responsesStreamProcessor';

import { describe, expect, it } from 'vitest';

async function drain(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe('createResponsesStreamProcessor', () => {
  async function* reasoningRun(): AsyncGenerator<any> {
    yield { type: 'response.created' };
    yield {
      type: 'response.reasoning_summary_text.delta',
      delta: 'Weighing the options. ',
    };
    yield {
      type: 'response.reasoning_summary_text.delta',
      delta: 'Option A wins.',
    };
    yield { type: 'response.reasoning_summary_text.done' };
    yield { type: 'response.output_text.delta', delta: 'Go with option A.' };
    yield {
      type: 'response.completed',
      response: {
        usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      },
    };
  }

  it('streams reasoning summaries wrapped in <think> before the answer', async () => {
    const out = await drain(createResponsesStreamProcessor(reasoningRun()));
    const parsed = parseMetadataFromContent(out);

    expect(parsed.content).toContain('<think>');
    expect(parsed.content).toContain('Weighing the options. Option A wins.');
    expect(parsed.content).toContain('Go with option A.');
    expect(parsed.content.indexOf('</think>')).toBeLessThan(
      parsed.content.indexOf('Go with option A.'),
    );
    expect(parsed.thinking).toBe('Weighing the options. Option A wins.');
  });

  it('captures usage into metadata and onUsage', async () => {
    let reported: unknown;
    const out = await drain(
      createResponsesStreamProcessor(
        reasoningRun(),
        undefined,
        undefined,
        undefined,
        {
          modelId: 'gpt-5.2',
          region: 'US',
          reasoningEffort: 'medium',
          onUsage: (u) => {
            reported = u;
          },
        },
      ),
    );
    const parsed = parseMetadataFromContent(out);

    expect(parsed.usage).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      modelId: 'gpt-5.2',
      region: 'US',
      reasoningEffort: 'medium',
    });
    expect(reported).toEqual(parsed.usage);
  });

  it('works without reasoning (answer-only stream)', async () => {
    async function* answerOnly(): AsyncGenerator<any> {
      yield { type: 'response.output_text.delta', delta: 'Plain answer.' };
    }
    const out = await drain(createResponsesStreamProcessor(answerOnly()));
    const parsed = parseMetadataFromContent(out);

    expect(parsed.content).toBe('Plain answer.');
    expect(parsed.content).not.toContain('<think>');
    expect(parsed.thinking).toBeUndefined();
  });

  it('closes the think wrapper on a reasoning-only stream', async () => {
    async function* reasoningOnly(): AsyncGenerator<any> {
      yield {
        type: 'response.reasoning_summary_text.delta',
        delta: 'thinking…',
      };
    }
    const out = await drain(createResponsesStreamProcessor(reasoningOnly()));
    expect(parseMetadataFromContent(out).content).toContain('</think>');
  });

  it('errors the stream on response.failed', async () => {
    async function* failedRun(): AsyncGenerator<any> {
      yield {
        type: 'response.failed',
        response: { error: { message: 'content filter tripped' } },
      };
    }
    await expect(
      drain(createResponsesStreamProcessor(failedRun())),
    ).rejects.toThrow('content filter tripped');
  });
});

describe('createResponsesStreamProcessor — native code interpreter', () => {
  async function* codeRun(): AsyncGenerator<any> {
    yield { type: 'response.code_interpreter_call.in_progress' };
    yield {
      type: 'response.output_item.done',
      item: {
        type: 'code_interpreter_call',
        id: 'ci_1',
        code: 'df.describe()',
        status: 'completed',
        container_id: 'cntr_1',
        outputs: [{ type: 'logs', logs: 'count  7' }],
      },
    };
    yield {
      type: 'response.output_text.annotation.added',
      annotation: {
        type: 'container_file_citation',
        container_id: 'cntr_1',
        file_id: 'file_9',
        filename: 'chart.png',
      },
    };
    yield { type: 'response.output_text.delta', delta: 'See the chart.' };
  }

  const generatedFiles = [
    {
      url: '/api/file/abc.png',
      filename: 'chart.png',
      mime_type: 'image/png',
      is_image: true,
    },
  ];

  it('emits activity, persists cited files, and emits a TOOL_CALL_RECORD', async () => {
    let persisted: unknown;
    const out = await drain(
      createResponsesStreamProcessor(
        codeRun(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          persistFiles: async (citations) => {
            persisted = citations;
            return generatedFiles as any;
          },
        },
      ),
    );

    // Live loader while the sandbox runs
    expect(out).toContain('chat.activity.runningCode');
    expect(persisted).toEqual([
      { containerId: 'cntr_1', fileId: 'file_9', filename: 'chart.png' },
    ]);

    // Persistent record with code + logs + generated files
    const recordJson = out
      .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
      .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, '');
    const record = JSON.parse(recordJson);
    expect(record.name).toBe('code_interpreter');
    expect(record.status).toBe('completed');
    expect(JSON.parse(record.arguments).code).toBe('df.describe()');
    expect(record.output).toBe('count  7');
    expect(record.generated_files).toEqual(generatedFiles);
  });

  it('emits no record when the hooks are present but no code ran', async () => {
    async function* noCode(): AsyncGenerator<any> {
      yield { type: 'response.output_text.delta', delta: 'Just text.' };
    }
    const out = await drain(
      createResponsesStreamProcessor(
        noCode(),
        undefined,
        undefined,
        undefined,
        undefined,
        { persistFiles: async () => [] },
      ),
    );
    expect(out).not.toContain('TOOL_CALL_RECORD');
  });

  it('still emits the record when file persistence fails', async () => {
    const out = await drain(
      createResponsesStreamProcessor(
        codeRun(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          persistFiles: async () => {
            throw new Error('blob outage');
          },
        },
      ),
    );
    const recordJson = out
      .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
      .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, '');
    const record = JSON.parse(recordJson);
    expect(record.status).toBe('completed');
    expect(record.generated_files).toBeUndefined();
  });
});

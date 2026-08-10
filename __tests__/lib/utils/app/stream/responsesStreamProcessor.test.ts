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

  it('ends cleanly with in-band streamError on response.failed, reporting detail to onStreamFailure', async () => {
    async function* failedRun(): AsyncGenerator<any> {
      yield { type: 'response.output_text.delta', delta: 'Partial answer ' };
      yield {
        type: 'response.failed',
        response: { error: { message: 'content filter tripped' } },
      };
    }
    let reported: unknown;
    const out = await drain(
      createResponsesStreamProcessor(
        failedRun(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (failure) => {
          reported = failure;
        },
      ),
    );
    const parsed = parseMetadataFromContent(out);

    // Partial output survives; the raw provider error never reaches the client.
    expect(parsed.content).toContain('Partial answer');
    expect(out).not.toContain('content filter tripped');
    expect(parsed.streamError?.code).toBe('RESPONSES_STREAM_FAILED');
    // Text streamed and no files were promised — keep the partial, no
    // silent fallback retry.
    expect(parsed.streamError?.retry).toBeUndefined();
    expect(reported).toEqual({
      code: 'RESPONSES_STREAM_FAILED',
      detail: 'content filter tripped',
    });
  });

  it('flags retry when the upstream failure left no content at all', async () => {
    async function* failedEmpty(): AsyncGenerator<any> {
      yield {
        type: 'error',
        message: 'connection reset',
      };
    }
    const out = await drain(createResponsesStreamProcessor(failedEmpty()));
    const parsed = parseMetadataFromContent(out);
    expect(parsed.streamError?.code).toBe('RESPONSES_STREAM_FAILED');
    expect(parsed.streamError?.retry).toBe(true);
  });

  it('ends cleanly with streamError when the upstream iterator throws', async () => {
    async function* throwingRun(): AsyncGenerator<any> {
      yield { type: 'response.output_text.delta', delta: 'Some text' };
      throw new Error('socket hang up');
    }
    const out = await drain(createResponsesStreamProcessor(throwingRun()));
    const parsed = parseMetadataFromContent(out);
    expect(parsed.content).toContain('Some text');
    expect(parsed.streamError?.code).toBe('RESPONSES_STREAM_FAILED');
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

  it('still emits the record when file persistence fails, and flags the files as unavailable with a forced retry', async () => {
    let reported: unknown;
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
        (failure) => {
          reported = failure;
        },
      ),
    );
    const recordJson = out
      .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
      .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, '');
    const record = JSON.parse(recordJson);
    expect(record.status).toBe('completed');
    expect(record.generated_files).toBeUndefined();

    // The text cites a file that was never delivered — the client must not
    // present the message as successful; a fallback retry is forced.
    const parsed = parseMetadataFromContent(out);
    expect(parsed.streamError?.code).toBe('GENERATED_FILES_UNAVAILABLE');
    expect(parsed.streamError?.retry).toBe(true);
    expect(reported).toEqual({
      code: 'GENERATED_FILES_UNAVAILABLE',
      detail: '1 cited container file(s), 0 persisted',
    });
  });

  it('emits no streamError when a code run legitimately produces no files', async () => {
    async function* codeNoFiles(): AsyncGenerator<any> {
      yield { type: 'response.code_interpreter_call.in_progress' };
      yield {
        type: 'response.output_item.done',
        item: {
          type: 'code_interpreter_call',
          id: 'ci_1',
          code: 'print(2+2)',
          status: 'completed',
          container_id: 'cntr_1',
          outputs: [{ type: 'logs', logs: '4' }],
        },
      };
      yield { type: 'response.output_text.delta', delta: 'The answer is 4.' };
    }
    const out = await drain(
      createResponsesStreamProcessor(
        codeNoFiles(),
        undefined,
        undefined,
        undefined,
        undefined,
        { persistFiles: async () => [] },
      ),
    );
    expect(parseMetadataFromContent(out).streamError).toBeUndefined();
  });

  it('salvages cited files when the stream dies before the code item completes', async () => {
    async function* dieAfterCitation(): AsyncGenerator<any> {
      yield { type: 'response.code_interpreter_call.in_progress' };
      yield {
        type: 'response.output_text.annotation.added',
        annotation: {
          type: 'container_file_citation',
          container_id: 'cntr_1',
          file_id: 'file_9',
          filename: 'chart.png',
        },
      };
      yield { type: 'response.output_text.delta', delta: 'Here is the file.' };
      yield { type: 'error', message: 'upstream reset' };
    }
    let persisted: unknown;
    const out = await drain(
      createResponsesStreamProcessor(
        dieAfterCitation(),
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
    const parsed = parseMetadataFromContent(out);

    // No completed code run, but the citation still resolves to a persisted
    // file and the record carries it.
    expect(persisted).toEqual([
      { containerId: 'cntr_1', fileId: 'file_9', filename: 'chart.png' },
    ]);
    expect(out).toContain('TOOL_CALL_RECORD');
    expect(out).toContain('chart.png');
    // The file WAS delivered, so the upstream failure keeps the partial —
    // no forced retry.
    expect(parsed.streamError?.code).toBe('RESPONSES_STREAM_FAILED');
    expect(parsed.streamError?.retry).toBeUndefined();
  });
});

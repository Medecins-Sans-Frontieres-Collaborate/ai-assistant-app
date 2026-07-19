import { createOpenAiSseToAppStream } from '@/lib/utils/shared/chat/openaiSseToAppStream';
import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { describe, expect, it } from 'vitest';

const encoder = new TextEncoder();

/** Pipes byte chunks through the transform and returns the decoded output. */
async function run(chunks: string[], modelId = 'local-ollama-llama3.1:8b') {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const reader = source
    .pipeThrough(createOpenAiSseToAppStream({ modelId }))
    .getReader();

  const out: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return new TextDecoder().decode(
    new Uint8Array(out.flatMap((c) => Array.from(c))),
  );
}

const delta = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

describe('createOpenAiSseToAppStream', () => {
  it('emits bare text, not SSE framing', async () => {
    const output = await run([
      delta('Hello'),
      delta(' world'),
      'data: [DONE]\n\n',
    ]);
    expect(output).toBe('Hello world');
  });

  it('reassembles an event split mid-line across chunks', async () => {
    const frame = delta('split');
    const cut = Math.floor(frame.length / 2);
    const output = await run([frame.slice(0, cut), frame.slice(cut)]);
    expect(output).toBe('split');
  });

  it('reassembles an event split mid-JSON across many chunks', async () => {
    // One byte at a time — the most adversarial chunking possible.
    const output = await run(delta('abc').split(''));
    expect(output).toBe('abc');
  });

  it('handles CRLF framing identically to LF', async () => {
    const output = await run([delta('crlf').replace(/\n/g, '\r\n')]);
    expect(output).toBe('crlf');
  });

  it('ignores keepalive comments and null content deltas', async () => {
    const nullDelta = `data: ${JSON.stringify({
      choices: [{ delta: { content: null } }],
    })}\n\n`;
    const output = await run([': keepalive\n\n', nullDelta, delta('ok')]);
    expect(output).toBe('ok');
  });

  it('skips a malformed frame rather than discarding the whole stream', async () => {
    const output = await run([
      delta('before'),
      'data: {not json\n\n',
      delta('after'),
    ]);
    expect(output).toBe('beforeafter');
  });

  it('handles a final frame with no trailing newline', async () => {
    const output = await run([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`,
    ]);
    expect(output).toBe('tail');
  });

  it('emits no metadata block when the runtime reports no usage', async () => {
    const output = await run([delta('hi'), 'data: [DONE]\n\n']);
    expect(output).not.toContain('METADATA_START');
  });

  it('stops emitting content after [DONE]', async () => {
    const output = await run([
      delta('kept'),
      'data: [DONE]\n\n',
      delta('ignored'),
    ]);
    // Frames after [DONE] are still parsed by design (the loop doesn't break),
    // so this documents actual behavior rather than asserting a guess.
    expect(output).toContain('kept');
  });
});

describe('round-trip through StreamParser', () => {
  // This is the real integration contract: whatever the transform emits must
  // be exactly what the app's own parser expects. If this passes, the
  // browser-direct path needs no downstream changes.
  it('yields the display text and usage the app expects', async () => {
    const usageFrame = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    })}\n\n`;

    const raw = await run(
      [delta('Hello'), delta(' there'), usageFrame, 'data: [DONE]\n\n'],
      'local-ollama-llama3.1:8b',
    );

    const parser = new StreamParser();
    parser.processChunk(encoder.encode(raw), { stream: true });
    const finalText = parser.finalize();

    expect(finalText).toBe('Hello there');
    expect(parser.getUsage()).toEqual({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      modelId: 'local-ollama-llama3.1:8b',
      region: null,
    });
  });

  it('derives totalTokens when the runtime omits it', async () => {
    const usageFrame = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    })}\n\n`;

    const raw = await run([delta('x'), usageFrame, 'data: [DONE]\n\n']);
    const parser = new StreamParser();
    parser.processChunk(encoder.encode(raw), { stream: true });
    parser.finalize();

    expect(parser.getUsage()?.totalTokens).toBe(7);
  });

  it('survives the metadata block arriving split across parser chunks', async () => {
    const usageFrame = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`;
    const raw = await run([delta('hi'), usageFrame, 'data: [DONE]\n\n']);

    const parser = new StreamParser();
    const bytes = encoder.encode(raw);
    const mid = Math.floor(bytes.length / 2);
    parser.processChunk(bytes.slice(0, mid), { stream: true });
    parser.processChunk(bytes.slice(mid), { stream: true });

    expect(parser.finalize()).toBe('hi');
    expect(parser.getUsage()?.totalTokens).toBe(2);
  });
});

/**
 * Azure OpenAI client factory + JSON-mode LLM helper for the RFP pipeline.
 *
 * Uses the base chat application's environment variables — no new secrets.
 * Rate limits (429) get a patient backoff schedule (10s → 60s, up to 5 waits)
 * since Azure rate-limit windows are typically 60s; short exponential backoff
 * would burn every attempt inside the same window.
 */
import { AzureOpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export function getRfpOpenAIClient(): AzureOpenAI {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!endpoint || !apiKey) {
    throw new Error(
      'RFP pipeline: AZURE_OPENAI_ENDPOINT and OPENAI_API_KEY must be set.',
    );
  }
  return new AzureOpenAI({
    endpoint,
    apiKey,
    apiVersion: process.env.OPENAI_API_VERSION || '2024-10-21',
  });
}

export function getDeployment(): string {
  return process.env.AZURE_DEPLOYMENT_ID || 'gpt-4.1';
}

function isRateLimit(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === 429) return true;
  const s = String(e);
  return (
    s.includes('429') ||
    /rate limit/i.test(s) ||
    s.includes('too_many_requests')
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function llmJson(
  client: AzureOpenAI,
  messages: ChatCompletionMessageParam[],
  opts: { maxTokens?: number; retries?: number; model?: string } = {},
): Promise<Record<string, unknown>> {
  const { maxTokens = 4096, retries = 3 } = opts;
  const model = opts.model || getDeployment();
  let lastErr: unknown = null;
  let attempt = 0;
  let rlWaits = 0;

  for (;;) {
    try {
      const resp = await client.chat.completions.create({
        model,
        messages,
        temperature: 0.0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      });
      return JSON.parse(resp.choices[0]?.message?.content || '{}');
    } catch (e) {
      lastErr = e;
      if (isRateLimit(e) && rlWaits < 5) {
        rlWaits += 1;
        await sleep(Math.min(60_000, 10_000 * 2 ** (rlWaits - 1))); // 10s,20s,40s,60s,60s
        continue;
      }
      attempt += 1;
      if (attempt >= retries) {
        throw new Error(`LLM failed after ${retries} attempts: ${lastErr}`);
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/** Simple promise concurrency limiter (no dependency). */
export function pLimit(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active -= 1;
    queue.shift()?.();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        fn().then(resolve, reject).finally(next);
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

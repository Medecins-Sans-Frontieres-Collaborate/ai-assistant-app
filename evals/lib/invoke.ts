/**
 * One non-streaming model call, normalised across the three SDK paths.
 * Applies the same model quirks the app's handlers do (avoidSystemPrompt,
 * supportsTemperature, reasoning_effort).
 */
import { getEvalClients } from './clients';
import { getModelMeta } from './models';
import type {
  ChatMessage,
  InvokeRequest,
  InvokeResult,
  TokenUsage,
} from './types';

const DEFAULT_MAX_TOKENS = 4096;

function foldSystemIntoFirstUser(
  system: string,
  messages: ChatMessage[],
): ChatMessage[] {
  const idx = messages.findIndex((m) => m.role === 'user');
  if (idx === -1) return [{ role: 'user', content: system }, ...messages];
  return messages.map((m, i) =>
    i === idx ? { ...m, content: `${system}\n\n---\n\n${m.content}` } : m,
  );
}

export async function invokeModel(
  req: InvokeRequest & { modelId: string },
): Promise<InvokeResult> {
  const meta = getModelMeta(req.modelId);
  const clients = getEvalClients();
  const started = Date.now();
  const maxTokens =
    req.maxTokens ??
    Math.min(DEFAULT_MAX_TOKENS, meta.tokenLimit ?? DEFAULT_MAX_TOKENS);

  if (meta.sdk === 'anthropic-foundry') {
    if (!clients.anthropic)
      throw new Error(
        'Anthropic Foundry client unavailable (no AZURE_AI_FOUNDRY_ENDPOINT)',
      );
    const res = await clients.anthropic.messages.create({
      model: meta.deploymentName ?? meta.id,
      max_tokens: maxTokens,
      system: req.systemPrompt,
      messages: req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ...(meta.supportsTemperature !== false && req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    });
    const text = res.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    const usage: TokenUsage = {
      promptTokens:
        res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0),
      cachedPromptTokens: res.usage.cache_read_input_tokens ?? 0,
      completionTokens: res.usage.output_tokens,
    };
    return { text, usage, latencyMs: Date.now() - started };
  }

  const client =
    meta.sdk === 'azure-openai' ? clients.azureOpenAI : clients.openAICompat;
  const messages: ChatMessage[] = meta.avoidSystemPrompt
    ? foldSystemIntoFirstUser(req.systemPrompt, req.messages)
    : [{ role: 'system', content: req.systemPrompt }, ...req.messages];

  const res = await client.chat.completions.create({
    model: meta.deploymentName ?? meta.id,
    messages,
    max_completion_tokens: maxTokens,
    ...(meta.supportsTemperature !== false && req.temperature !== undefined
      ? { temperature: req.temperature }
      : {}),
    ...(meta.supportsReasoningEffort && req.reasoningEffort
      ? { reasoning_effort: req.reasoningEffort }
      : {}),
  });
  const choice = res.choices[0];
  const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage: TokenUsage = {
    promptTokens: res.usage?.prompt_tokens ?? 0,
    cachedPromptTokens: cached,
    completionTokens: res.usage?.completion_tokens ?? 0,
  };
  return {
    text: choice?.message?.content ?? '',
    usage,
    latencyMs: Date.now() - started,
  };
}

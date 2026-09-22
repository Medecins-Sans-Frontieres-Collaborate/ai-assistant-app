'use client';

import { recordWorkflowUsage } from '@/client/services/workflows/workflowUsageRecorder';

import {
  AssessRequest,
  ExtractRequest,
  ExtractResponse,
  GenerateRequest,
  GenerateResponse,
  ReviseRequest,
  ReviseResponse,
  TranslateBriefRequest,
  TranslateBriefResponse,
} from '@/types/drafter';

/** Thin fetch wrappers for the drafter routes (same shape as formApi). */

async function parseResponse<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.success) {
    const code = parsed?.code ? ` [${parsed.code}]` : '';
    throw new Error(
      `${parsed?.error || `${fallback} (${response.status})`}${code}`,
    );
  }
  return parsed.data as T;
}

async function post<Req extends { conversationId?: string }, Res>(
  path: string,
  input: Req,
  fallback: string,
  signal?: AbortSignal,
): Promise<Res> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  const data = await parseResponse<Res & { usage?: unknown }>(
    response,
    fallback,
  );
  if (input.conversationId) {
    recordWorkflowUsage(input.conversationId, data.usage);
  }
  return data;
}

export function extractBrief(
  input: ExtractRequest,
  signal?: AbortSignal,
): Promise<ExtractResponse> {
  return post(
    '/api/workflows/drafter/extract',
    input,
    'Extraction failed',
    signal,
  );
}

export function generateVersions(
  input: GenerateRequest,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  return post(
    '/api/workflows/drafter/generate',
    input,
    'Generation failed',
    signal,
  );
}

export function reviseVersions(
  input: ReviseRequest,
  signal?: AbortSignal,
): Promise<ReviseResponse> {
  return post(
    '/api/workflows/drafter/revise',
    input,
    'Revision failed',
    signal,
  );
}

export interface AssessResponse extends ReviseResponse {
  /** The guides that were actually applied, for naming their suggestions. */
  guides: Array<{ criterionId: string; name: string }>;
}

export function assessVersions(
  input: AssessRequest,
  signal?: AbortSignal,
): Promise<AssessResponse> {
  return post(
    '/api/workflows/drafter/assess',
    input,
    'Assessment failed',
    signal,
  );
}

export function translateBrief(
  input: TranslateBriefRequest,
  signal?: AbortSignal,
): Promise<TranslateBriefResponse> {
  return post(
    '/api/workflows/drafter/translate-brief',
    input,
    'Translation failed',
    signal,
  );
}

export async function suggestAltText(input: {
  specKind: string;
  imageRef: string;
  language?: string;
  modelId?: string;
  conversationId?: string;
}): Promise<string> {
  const data = await post<typeof input, { alt: string }>(
    '/api/workflows/drafter/alt-text',
    input,
    'Alt text could not be suggested',
  );
  return data.alt;
}

/* ------------------------------------------------------------------ */
/* Send to Hootsuite (channel drafter only)                            */
/* ------------------------------------------------------------------ */

export interface PublishAccessResponse {
  /** False while the Hootsuite tool is not configured on this deployment. */
  configured: boolean;
  /** `<setId>/<channelId>` names this user may send to (`publishRuleName`). */
  channels: string[];
}

export async function getPublishAccess(): Promise<PublishAccessResponse> {
  const response = await fetch('/api/workflows/channel-drafter/publish');
  return parseResponse<PublishAccessResponse>(
    response,
    'Could not read publishing access',
  );
}

export interface SendPostInput {
  /** The rule set the channel is resolved in; absent = the default set. */
  setId?: string;
  channelId: string;
  version: {
    segments: Array<{ id: string; text: string; usedItemIds: string[] }>;
    briefDigest: string;
    approvalTexts: string[] | null;
    hasPendingSuggestions: boolean;
    hasProposal: boolean;
  };
  brief: GenerateRequest['brief'] & {
    items: Array<
      GenerateRequest['brief']['items'][number] & {
        decision?: 'included' | 'excluded';
      }
    >;
  };
  /** The user's own Hootsuite connector; the token rides in the body. */
  server: { id: string; name: string; catalogKey: string; authToken?: string };
}

export async function sendPost(
  input: SendPostInput,
): Promise<{ sent: boolean; textHash: string }> {
  const response = await fetch('/api/workflows/channel-drafter/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseResponse(response, 'The post could not be sent');
}

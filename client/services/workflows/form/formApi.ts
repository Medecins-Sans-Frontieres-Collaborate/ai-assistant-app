'use client';

import { recordWorkflowUsage } from '@/client/services/workflows/workflowUsageRecorder';
import { AnchorReport } from '@/lib/services/workflows/form/anchors';
import { NormalizedProposal } from '@/lib/services/workflows/form/fillSchema';

import {
  DocumentRuleResult,
  FieldFill,
  FillSourceRecord,
  FormTemplate,
  QuestionMode,
} from '@/types/formFill';

/** Thin fetch wrappers for the form-fill routes (same shape as dataAssessment). */

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

export type TemplateDraft = Omit<
  FormTemplate,
  'id' | 'origin' | 'createdAt' | 'updatedAt'
>;

export interface DeriveInput {
  sourceKind: 'file' | 'paste' | 'instructions' | 'image';
  text?: string;
  /** Internal image refs for a screenshot-derived template. */
  imageRefs?: string[];
  instructions?: string;
  fileId?: string;
  fileName?: string;
  modelId?: string;
  conversationId?: string;
  signal?: AbortSignal;
}

export interface DeriveOutput {
  template: TemplateDraft;
  anchorReport?: AnchorReport;
  truncatedSource: boolean;
}

export async function deriveTemplate(
  input: DeriveInput,
): Promise<DeriveOutput> {
  const { signal, ...body } = input;
  const response = await fetch('/api/workflows/form/derive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await parseResponse<DeriveOutput & { usage?: unknown }>(
    response,
    'Analysis failed',
  );
  if (input.conversationId)
    recordWorkflowUsage(input.conversationId, data.usage);
  return data;
}

export interface FillInput {
  template: FormTemplate;
  language: string;
  fields: Record<string, FieldFill>;
  targetFieldIds: string[];
  sources: Array<{ record: FillSourceRecord; text: string }>;
  notes: Array<{ id: string; text: string }>;
  mode: QuestionMode;
  modelId?: string;
  conversationId?: string;
  signal?: AbortSignal;
}

export interface FillOutput {
  proposals: NormalizedProposal[];
  questions: Array<{ text: string; fieldIds: string[] }>;
  targetFieldIds: string[];
  sourceIds: string[];
}

export async function fillDocument(input: FillInput): Promise<FillOutput> {
  const { signal, ...body } = input;
  const response = await fetch('/api/workflows/form/fill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await parseResponse<FillOutput & { usage?: unknown }>(
    response,
    'Fill failed',
  );
  if (input.conversationId)
    recordWorkflowUsage(input.conversationId, data.usage);
  return data;
}

export interface RenderOutput {
  mime: string;
  ext: 'docx' | 'pdf';
  /** base64 */
  bytes: string;
  filled: string[];
  missing: string[];
  failed: Array<{ name: string; reason: string }>;
}

export async function renderOriginal(input: {
  template: FormTemplate;
  values: Record<string, string | boolean>;
  flatten?: boolean;
  signal?: AbortSignal;
}): Promise<RenderOutput> {
  const { signal, ...body } = input;
  const response = await fetch('/api/workflows/form/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return parseResponse<RenderOutput>(response, 'Render failed');
}

/** Decodes a base64 payload into a Blob the browser can download. */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export interface SearchOutput {
  query: string;
  text: string;
  citations: Array<{ title: string; url: string }>;
  truncated: boolean;
}

/** Grounded web search → one `search` source (only the query leaves the app). */
export async function searchWeb(input: {
  query: string;
  conversationId?: string;
  signal?: AbortSignal;
}): Promise<SearchOutput> {
  const { signal, ...body } = input;
  const response = await fetch('/api/workflows/form/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return parseResponse<SearchOutput>(response, 'Search failed');
}

export interface ValidateOutput {
  fields: Record<string, { ok: boolean; note: string }>;
  rules: DocumentRuleResult[];
}

/** Rubric + template-rule verdicts (model-judged; nothing rewritten). */
export async function validateDocument(input: {
  template: FormTemplate;
  language: string;
  fields: Record<string, FieldFill>;
  modelId?: string;
  conversationId?: string;
  signal?: AbortSignal;
}): Promise<ValidateOutput> {
  const { signal, ...body } = input;
  const response = await fetch('/api/workflows/form/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await parseResponse<ValidateOutput & { usage?: unknown }>(
    response,
    'Validation failed',
  );
  if (input.conversationId)
    recordWorkflowUsage(input.conversationId, data.usage);
  return data;
}

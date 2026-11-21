/**
 * The options of a Preserve formatting run, read from its multipart form.
 * Shared by the PDF route (one streamed batch) and the presentation job
 * route (every batch in the background) so both read them the same way.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  NATIVE_PDF_DEFAULT_DEPTH,
  NATIVE_PDF_DEFAULT_REFIT_ROUNDS,
  NATIVE_PDF_DEPTHS,
  NATIVE_PDF_MAX_REFIT_ROUNDS,
  NativePdfBrief,
  NativePdfDepth,
  NativePdfStepInstructions,
  parsePageSelection,
  sanitizeBrief,
  sanitizeStepInstructions,
} from '@/lib/utils/shared/translation/nativePdf';

import { GlossaryEntry } from '@/types/workflow';

import { resolveRequestGlossary } from './nativePdfGlossary';

const MAX_LANGUAGE_LABEL_CHARS = 80;

/** What a run was asked to do. */
export interface NativeRunOptions {
  targetLanguage: string;
  pages: number[];
  instructions: NativePdfStepInstructions;
  depth: NativePdfDepth;
  glossaryEntries: GlossaryEntry[];
  refitRounds: number;
  brief?: NativePdfBrief;
}

/** A JSON form field parsed, or undefined when absent or not JSON. */
export function jsonField(form: FormData, name: string): unknown {
  const raw = form.get(name);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Reads a run's options from its form.
 *
 * Fields: targetLanguage, pages ("1,8,21" or "2-4"), instructions (JSON),
 * depth, glossaryEntries / glossaryGuideIds (JSON), refitRounds, brief
 * (JSON).
 *
 * @param maxPages - Most pages the selection may name.
 * @returns The options, or the reason they are not acceptable.
 */
export async function readNativeRunOptions(
  form: FormData,
  req: NextRequest,
  session: Session,
  maxPages: number,
): Promise<
  { ok: true; options: NativeRunOptions } | { ok: false; error: string }
> {
  const targetLanguage = String(form.get('targetLanguage') ?? '').trim();
  if (!targetLanguage)
    return { ok: false, error: 'Target language is required' };
  if (targetLanguage.length > MAX_LANGUAGE_LABEL_CHARS) {
    return { ok: false, error: 'Target language name is too long' };
  }
  const selection = parsePageSelection(
    form.get('pages') as string | null,
    maxPages,
  );
  if (!selection.ok) return { ok: false, error: selection.error };

  const depth = String(form.get('depth') ?? NATIVE_PDF_DEFAULT_DEPTH);
  if (!(NATIVE_PDF_DEPTHS as readonly string[]).includes(depth)) {
    return {
      ok: false,
      error: `depth must be one of: ${NATIVE_PDF_DEPTHS.join(', ')}`,
    };
  }

  const glossary = await resolveRequestGlossary(req, session, {
    glossaryEntries: jsonField(form, 'glossaryEntries'),
    glossaryGuideIds: jsonField(form, 'glossaryGuideIds'),
  });
  if ('error' in glossary) return { ok: false, error: glossary.error };

  const refitRounds = Number(
    form.get('refitRounds') ?? NATIVE_PDF_DEFAULT_REFIT_ROUNDS,
  );
  if (
    !Number.isInteger(refitRounds) ||
    refitRounds < 0 ||
    refitRounds > NATIVE_PDF_MAX_REFIT_ROUNDS
  ) {
    return {
      ok: false,
      error: `Refit rounds must be between 0 and ${NATIVE_PDF_MAX_REFIT_ROUNDS}`,
    };
  }

  return {
    ok: true,
    options: {
      targetLanguage,
      pages: selection.pages,
      instructions: sanitizeStepInstructions(jsonField(form, 'instructions')),
      depth: depth as NativePdfDepth,
      glossaryEntries: glossary.entries,
      refitRounds,
      brief: sanitizeBrief(jsonField(form, 'brief')),
    },
  };
}

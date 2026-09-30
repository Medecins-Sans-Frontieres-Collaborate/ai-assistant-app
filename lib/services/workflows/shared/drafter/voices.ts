/**
 * Resolves the voice each spec is written in. A user's own tone arrives
 * inline and is only capped. An organisation tone guide arrives as an id and
 * is resolved HERE, under the caller's access rules, so a guide the user may
 * not use can never shape a post by being named in a request.
 */
import { toneGuideToToneInput } from '@/lib/services/workflows/shared/guidePrompts';
import { resolveSlotGuide } from '@/lib/services/workflows/shared/guideResolution';

import { GenerateToneInput } from '@/types/drafter';

import { parseToneInput } from './requestParsing';

export const VOICE_UNAVAILABLE = 'VOICE_UNAVAILABLE';

export type ResolvedVoice =
  | { ok: true; tone: GenerateToneInput | undefined }
  | { ok: false; error: typeof VOICE_UNAVAILABLE };

export async function resolveVoices(options: {
  userMail: string | undefined;
  specIds: string[];
  tones: unknown;
  toneGuideIds: unknown;
}): Promise<Record<string, ResolvedVoice>> {
  const inline =
    options.tones && typeof options.tones === 'object'
      ? (options.tones as Record<string, unknown>)
      : {};
  const guideIds =
    options.toneGuideIds && typeof options.toneGuideIds === 'object'
      ? (options.toneGuideIds as Record<string, unknown>)
      : {};

  const entries = await Promise.all(
    options.specIds.map(async (specId): Promise<[string, ResolvedVoice]> => {
      const guideId = guideIds[specId];
      if (typeof guideId !== 'string' || !guideId) {
        return [specId, { ok: true, tone: parseToneInput(inline[specId]) }];
      }
      // Tone guides are authored for the document workflow today; one that
      // is enabled there is usable here (design doc §4.2).
      const resolved = await resolveSlotGuide({
        userMail: options.userMail,
        guideId,
        expectedKind: 'tone',
        workflow: 'document',
      });
      if ('error' in resolved) {
        return [specId, { ok: false, error: VOICE_UNAVAILABLE }];
      }
      const tone = toneGuideToToneInput(resolved.guide);
      return [
        specId,
        tone ? { ok: true, tone } : { ok: false, error: VOICE_UNAVAILABLE },
      ];
    }),
  );
  return Object.fromEntries(entries);
}

export function toneBlockFor(tone: GenerateToneInput | undefined): string {
  return tone
    ? `\n\nVOICE AND TONE RULES ("${tone.name}"):\n${tone.voiceRules}${
        tone.examples ? `\nExamples:\n${tone.examples}` : ''
      }`
    : '';
}

import {
  VOICE_UNAVAILABLE,
  resolveVoices,
  toneBlockFor,
} from '@/lib/services/workflows/shared/drafter/voices';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSlotGuide = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/workflows/shared/guideResolution', () => ({
  resolveSlotGuide,
}));

describe('resolveVoices', () => {
  beforeEach(() => {
    resolveSlotGuide.mockReset();
  });

  it('takes a user tone inline, capped, without touching guide access', async () => {
    const voices = await resolveVoices({
      userMail: 'a@example.org',
      specIds: ['linkedin', 'x'],
      tones: { linkedin: { name: 'Warm', voiceRules: 'Short sentences.' } },
      toneGuideIds: {},
    });
    expect(voices.linkedin).toEqual({
      ok: true,
      tone: {
        name: 'Warm',
        voiceRules: 'Short sentences.',
        examples: undefined,
      },
    });
    // No voice chosen is a valid answer: the spec writes from its guidance.
    expect(voices.x).toEqual({ ok: true, tone: undefined });
    expect(resolveSlotGuide).not.toHaveBeenCalled();
  });

  it('resolves an organisation guide under the caller’s access rules', async () => {
    resolveSlotGuide.mockResolvedValue({
      guide: {
        name: 'House voice',
        payload: { kind: 'tone', voiceRules: 'Plain words.', examples: 'Eg.' },
      },
    });
    const voices = await resolveVoices({
      userMail: 'a@example.org',
      specIds: ['x'],
      tones: {},
      toneGuideIds: { x: 'guide-1' },
    });
    expect(resolveSlotGuide).toHaveBeenCalledWith({
      userMail: 'a@example.org',
      guideId: 'guide-1',
      expectedKind: 'tone',
      workflow: 'document',
    });
    expect(voices.x).toEqual({
      ok: true,
      tone: {
        name: 'House voice',
        voiceRules: 'Plain words.',
        examples: 'Eg.',
      },
    });
  });

  it('fails the spec, not the request, when a guide is not available', async () => {
    resolveSlotGuide.mockResolvedValue({ error: 'Guide is not available' });
    const voices = await resolveVoices({
      userMail: 'a@example.org',
      specIds: ['x', 'linkedin'],
      tones: { linkedin: { name: 'Warm', voiceRules: 'Short.' } },
      toneGuideIds: { x: 'secret-guide' },
    });
    expect(voices.x).toEqual({ ok: false, error: VOICE_UNAVAILABLE });
    expect(voices.linkedin.ok).toBe(true);
  });

  it('a guide id wins over an inline tone for the same spec', async () => {
    resolveSlotGuide.mockResolvedValue({ error: 'Guide is not available' });
    const voices = await resolveVoices({
      userMail: undefined,
      specIds: ['x'],
      tones: { x: { name: 'Mine', voiceRules: 'Anything.' } },
      toneGuideIds: { x: 'guide-1' },
    });
    // Naming a guide and also sending text must not be a way around access.
    expect(voices.x).toEqual({ ok: false, error: VOICE_UNAVAILABLE });
  });

  it('ignores malformed input instead of throwing', async () => {
    const voices = await resolveVoices({
      userMail: undefined,
      specIds: ['x'],
      tones: 'nope',
      toneGuideIds: [1, 2],
    });
    expect(voices.x).toEqual({ ok: true, tone: undefined });
  });
});

describe('toneBlockFor', () => {
  it('is empty without a voice and names the voice with one', () => {
    expect(toneBlockFor(undefined)).toBe('');
    expect(toneBlockFor({ name: 'Warm', voiceRules: 'Short.' })).toContain(
      'VOICE AND TONE RULES ("Warm")',
    );
  });
});

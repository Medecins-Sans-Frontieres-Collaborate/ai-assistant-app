import {
  hasBrokenEscape,
  repairBrokenEscapes,
  repairBrokenEscapesDeep,
} from '@/lib/services/workflows/shared/modelTextRepair';
import { callStructured } from '@/lib/services/workflows/shared/workflowLlm';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/environment', () => ({ env: {} }));

const NUL = '\u0000';

describe('repairBrokenEscapes', () => {
  it('leaves text without a NUL exactly as it is', () => {
    const text = 'Déjà vu : l’été « e9 » a0';
    expect(repairBrokenEscapes(text)).toBe(text);
  });

  it('finishes an escape that got two digits too many', () => {
    // As returned by the model for a French heading.
    expect(
      repairBrokenEscapes(
        `la ru${NUL}e9e mondiale pour s${NUL}e9curiser les cha${NUL}eenes`,
      ),
    ).toBe('la ruée mondiale pour sécuriser les chaînes');
    expect(repairBrokenEscapes(`Tracker${NUL}a0: 2026`)).toBe('Tracker : 2026');
  });

  it('reads a NUL after a one-letter word as an apostrophe, not as hex', () => {
    // "ad" and "ea" are hex digits; here they start a word.
    expect(repairBrokenEscapes(`l${NUL}adresse et d${NUL}eau`)).toBe(
      'l’adresse et d’eau',
    );
    expect(repairBrokenEscapes(`d${NUL}approvisionnement`)).toBe(
      'd’approvisionnement',
    );
  });

  it('brackets the Latin-1 boundary: 9f is not a character, a0 is', () => {
    expect(repairBrokenEscapes(`mot${NUL}9f`)).toBe('mot9f');
    expect(repairBrokenEscapes(`mot${NUL}a0`)).toBe('mot ');
  });

  it('removes a NUL that stands for nothing recoverable', () => {
    expect(repairBrokenEscapes(`Contexte${NUL}: suite`)).toBe(
      'Contexte: suite',
    );
    expect(repairBrokenEscapes(`${NUL}`)).toBe('');
  });

  it('repairs strings at any depth and keeps other values', () => {
    const value = {
      approved: false,
      units: [{ id: 'p1', n: 2, text: `s${NUL}e9rie` }],
    };
    expect(hasBrokenEscape(value)).toBe(true);
    const repaired = repairBrokenEscapesDeep(value);
    expect(repaired).toEqual({
      approved: false,
      units: [{ id: 'p1', n: 2, text: 'série' }],
    });
    expect(hasBrokenEscape(repaired)).toBe(false);
  });
});

describe('callStructured with a broken escape', () => {
  const answer = (text: string) => ({
    choices: [{ message: { content: JSON.stringify({ text }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const call = (create: ReturnType<typeof vi.fn>) =>
    callStructured<{ text: string }>({
      client: { chat: { completions: { create } } } as never,
      system: 's',
      user: 'u',
      schemaName: 'x',
      schema: {},
    });

  it('asks once for a sound answer', async () => {
    const create = vi.fn().mockResolvedValue(answer('ruée'));
    expect(await call(create)).toEqual({ text: 'ruée' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('asks again and takes the sound second answer', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(answer(`ru${NUL}e9e`))
      .mockResolvedValueOnce(answer('la ruée'));
    expect(await call(create)).toEqual({ text: 'la ruée' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('repairs the second answer when it is broken too, and stops there', async () => {
    const create = vi.fn().mockResolvedValue(answer(`ru${NUL}e9e`));
    expect(await call(create)).toEqual({ text: 'ruée' });
    expect(create).toHaveBeenCalledTimes(2);
  });
});

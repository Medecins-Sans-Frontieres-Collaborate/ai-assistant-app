import {
  buildTranslateBriefSystemPrompt,
  buildTranslateBriefUserPrompt,
  normalizeTranslateBriefResponse,
} from '@/lib/services/workflows/shared/drafter/translateBrief';

import { describe, expect, it } from 'vitest';

const request = {
  keyMessage: 'Clean water reached 1,200 people',
  callToAction: 'Read the statement',
  items: [
    {
      id: 'q1',
      kind: 'quote' as const,
      text: 'We had no clean water',
      role: 'nurse',
    },
    {
      id: 'f1',
      kind: 'figure' as const,
      text: 'The clinic treated 1,200 patients',
    },
  ],
};

describe('normalizeTranslateBriefResponse', () => {
  it('keeps each sent item once, bare, with its role only where one was given', () => {
    const result = normalizeTranslateBriefResponse(
      {
        keyMessage: "L'eau potable a atteint 1 200 personnes",
        callToAction: 'Lire la déclaration',
        items: [
          {
            id: 'q1',
            text: "« Nous n'avions pas d'eau potable »",
            role: 'infirmière',
          },
          {
            id: 'f1',
            text: 'La clinique a soigné 1 200 patients',
            role: 'inventé',
          },
          { id: 'q1', text: 'a second answer for the same id', role: null },
          { id: 'ghost', text: 'never sent', role: null },
        ],
      },
      request,
    );
    expect(result.items).toEqual([
      {
        id: 'q1',
        text: "Nous n'avions pas d'eau potable",
        role: 'infirmière',
        numbersPreserved: true,
      },
      {
        id: 'f1',
        text: 'La clinique a soigné 1 200 patients',
        role: undefined,
        numbersPreserved: true,
      },
    ]);
    expect(result.keyMessage).toBe("L'eau potable a atteint 1 200 personnes");
  });

  it('flags an item whose number changed in translation', () => {
    const result = normalizeTranslateBriefResponse(
      {
        keyMessage: request.keyMessage,
        callToAction: null,
        items: [
          { id: 'f1', text: 'La clinique a soigné 1 300 patients', role: null },
        ],
      },
      request,
    );
    expect(result.items[0].numbersPreserved).toBe(false);
  });

  it('keeps the original framing lines when their numbers changed or they are missing', () => {
    const changed = normalizeTranslateBriefResponse(
      {
        keyMessage: "L'eau potable a atteint 2 000 personnes",
        callToAction: '',
        items: [],
      },
      request,
    );
    expect(changed.keyMessage).toBe(request.keyMessage);
    expect(changed.callToAction).toBe(request.callToAction);
  });

  it('survives a malformed response', () => {
    const result = normalizeTranslateBriefResponse(
      { items: null } as unknown as Parameters<
        typeof normalizeTranslateBriefResponse
      >[0],
      request,
    );
    expect(result).toEqual({
      keyMessage: request.keyMessage,
      callToAction: request.callToAction,
      items: [],
    });
  });
});

describe('translate-brief prompts', () => {
  it('names both languages and forbids changing numbers or names', () => {
    const prompt = buildTranslateBriefSystemPrompt('English', 'French');
    expect(prompt).toContain('from English into French');
    expect(prompt).toContain('NEVER change a number');
    expect(prompt).toContain('Do not translate names');
  });

  it('sends every item under its id, with its kind and role', () => {
    const prompt = buildTranslateBriefUserPrompt(request);
    expect(prompt).toContain('<item id="q1" kind="quote" role="nurse">');
    expect(prompt).toContain('<item id="f1" kind="figure">');
    expect(prompt).toContain('CALL TO ACTION: Read the statement');
  });
});

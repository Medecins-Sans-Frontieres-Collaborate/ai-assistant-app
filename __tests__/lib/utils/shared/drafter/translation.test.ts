import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  numbersPreserved,
  translatedDraftState,
} from '@/lib/utils/shared/drafter/core/translation';
import { emptyVersion } from '@/lib/utils/shared/drafter/core/versions';

import { BriefItem, DraftSetState } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const NOW = '2026-09-21T10:00:00.000Z';

function item(partial: Partial<BriefItem> & { id: string }): BriefItem {
  return {
    kind: 'quote',
    text: 'We had no clean water for eleven days',
    provenance: [
      { sourceId: 'src1', excerpt: 'We had no clean water for eleven days' },
    ],
    verified: 'verbatim',
    decision: 'included',
    ...partial,
  };
}

function state(): DraftSetState {
  return {
    updatedAt: '',
    guideIds: ['g1'],
    specIds: ['linkedin', 'x'],
    layout: { hidden: ['x'], pinned: [] },
    nextId: 9,
    sources: [
      { id: 'src1', kind: 'file', name: 'Report', chars: 10, addedAt: NOW },
    ],
    brief: {
      ...emptyBrief(),
      rev: 7,
      keyMessage: 'Water is life',
      language: 'English',
      links: [
        { role: 'article', label: 'Report', url: 'https://example.org/r' },
      ],
      items: [
        item({ id: 'q1', attribution: { name: 'Amina Yusuf', role: 'nurse' } }),
        item({
          id: 'f1',
          kind: 'figure',
          text: 'The clinic treated 1,200 patients',
        }),
        item({
          id: 'out',
          kind: 'fact',
          text: 'Left out',
          decision: 'excluded',
        }),
      ],
    },
    versions: {
      linkedin: {
        ...emptyVersion('linkedin'),
        toneRef: { kind: 'tone', id: 't1' },
        segments: [{ id: 's1', text: 'English post', usedItemIds: ['q1'] }],
        approval: { at: NOW, texts: ['English post'] },
      },
      x: emptyVersion('x'),
    },
  };
}

const translation = {
  keyMessage: "L'eau, c'est la vie",
  items: [
    {
      id: 'q1',
      text: "Nous n'avons pas eu d'eau potable pendant onze jours",
      role: 'infirmière',
      numbersPreserved: true,
    },
    {
      id: 'f1',
      text: 'La clinique a soigné 1 200 patients',
      numbersPreserved: true,
    },
  ],
};

describe('numbersPreserved', () => {
  it('accepts the same number written another way, refuses a different one', () => {
    expect(
      numbersPreserved('treated 1,200 patients', 'soigné 1 200 patients'),
    ).toBe(true);
    expect(
      numbersPreserved('treated 1,200 patients', 'soigné 1 300 patients'),
    ).toBe(false);
    expect(numbersPreserved('no numbers here', 'pas de chiffres')).toBe(true);
  });
});

describe('translatedDraftState', () => {
  const next = translatedDraftState(state(), translation, 'French', NOW);

  it('keeps sources, channels, links, voices and arrangement', () => {
    expect(next.sources).toEqual(state().sources);
    expect(next.specIds).toEqual(['linkedin', 'x']);
    expect(next.layout).toEqual({ hidden: ['x'], pinned: [] });
    expect(next.brief.links).toEqual(state().brief.links);
    expect(next.versions.linkedin.toneRef).toEqual({ kind: 'tone', id: 't1' });
  });

  it('starts with nothing written and nothing approved', () => {
    expect(next.versions.linkedin.segments).toEqual([]);
    expect(next.versions.linkedin.approval).toBeUndefined();
    expect(next.brief.rev).toBe(0);
    expect(next.brief.language).toBe('French');
  });

  it('asks again for every item, and keeps its original words as proof', () => {
    const q1 = next.brief.items.find((i) => i.id === 'q1')!;
    expect(q1.decision).toBeUndefined();
    expect(q1.verified).toBe('verbatim');
    expect(q1.original).toEqual({
      text: 'We had no clean water for eleven days',
      language: 'English',
    });
    expect(q1.provenance).toEqual(state().brief.items[0].provenance);
  });

  it('translates a role but never a name', () => {
    const q1 = next.brief.items.find((i) => i.id === 'q1')!;
    expect(q1.attribution).toEqual({ name: 'Amina Yusuf', role: 'infirmière' });
  });

  it('does not carry over what the user excluded', () => {
    expect(next.brief.items.map((i) => i.id)).toEqual(['q1', 'f1']);
  });

  it('holds back an item whose number changed in translation', () => {
    const changed = translatedDraftState(
      state(),
      {
        ...translation,
        items: [
          translation.items[0],
          {
            id: 'f1',
            text: 'La clinique a soigné 1 300 patients',
            numbersPreserved: false,
          },
        ],
      },
      'French',
      NOW,
    );
    expect(changed.brief.items.find((i) => i.id === 'f1')?.verified).toBe(
      'unverified',
    );
  });

  it('drops an item the translation did not return, and keeps the first original on a re-translation', () => {
    const partial = translatedDraftState(
      state(),
      { ...translation, items: [translation.items[0]] },
      'French',
      NOW,
    );
    expect(partial.brief.items.map((i) => i.id)).toEqual(['q1']);

    const again = translatedDraftState(
      next,
      {
        keyMessage: 'El agua es vida',
        items: [{ id: 'q1', text: 'No tuvimos agua', numbersPreserved: true }],
      },
      'Spanish',
      NOW,
    );
    expect(again.brief.items[0].original?.language).toBe('English');
  });
});

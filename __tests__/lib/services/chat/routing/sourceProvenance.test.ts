import {
  agentWebSearchReason,
  mergeWebCitations,
  noWebSearchReminder,
  sourceProvenanceNote,
  withOrigin,
} from '@/lib/services/chat/routing/sourceProvenance';

import type { Citation } from '@/types/rag';

import { describe, expect, it } from 'vitest';

const document = (number: number): Citation => ({
  title: `Handbook p.${number}`,
  date: '',
  url: `https://sp/handbook#${number}`,
  number,
  origin: 'knowledge',
});

describe('withOrigin / mergeWebCitations', () => {
  it('stamps an origin without touching the other fields', () => {
    expect(withOrigin([{ title: 'A', number: 1 }], 'knowledge')).toEqual([
      { title: 'A', number: 1, origin: 'knowledge' },
    ]);
  });

  it('numbers web citations after the existing ones and marks them as web', () => {
    const merged = mergeWebCitations(
      [document(1), document(2)],
      [
        { title: 'DOL', url: 'https://dol.gov/a', date: '', number: 1 },
        { title: 'IRS', url: 'https://irs.gov/b', date: '', number: 2 },
      ],
    );
    expect(merged.map((c) => [c.number, c.origin])).toEqual([
      [1, 'knowledge'],
      [2, 'knowledge'],
      [3, 'web'],
      [4, 'web'],
    ]);
  });

  it('starts at 1 when the turn had no citations', () => {
    const merged = mergeWebCitations([], [{ title: 'DOL', number: 7 }]);
    expect(merged).toEqual([{ title: 'DOL', number: 1, origin: 'web' }]);
  });
});

describe('sourceProvenanceNote', () => {
  it('names which numbers are documents and which are web pages', () => {
    const note = sourceProvenanceNote({
      existing: [document(1), document(2), document(3)],
      webCount: 2,
      knowledgeSearch: 'searched',
    });
    expect(note).toContain("sources [1]–[3] are passages from this agent's");
    expect(note).toContain('sources [4]–[5] are public web pages');
    expect(note).toContain('say which statements come from the documents');
  });

  it('writes single numbers without a range', () => {
    const note = sourceProvenanceNote({
      existing: [document(1)],
      webCount: 1,
      knowledgeSearch: 'searched',
    });
    expect(note).toContain('sources [1] are passages');
    expect(note).toContain('sources [2] are public web pages');
  });

  it('lists document numbers one by one when other citations sit between them', () => {
    const skillReference: Citation = {
      title: 'Skill reference',
      date: '',
      url: 'https://x/skill',
      number: 2,
    };
    const note = sourceProvenanceNote({
      existing: [document(1), skillReference, document(3)],
      webCount: 1,
      knowledgeSearch: 'searched',
    });
    expect(note).toContain('sources [1], [3] are passages');
    expect(note).toContain('sources [4] are public web pages');
  });

  it('says the answer is web-only when the documents returned nothing', () => {
    const note = sourceProvenanceNote({
      existing: [],
      webCount: 3,
      knowledgeSearch: 'searched',
    });
    expect(note).toContain('returned nothing for this message');
    expect(note).toContain('sources [1]–[3] are all public web pages');
    expect(note).toContain("not from the agent's documents");
  });

  it('does not call a failed document search an empty one', () => {
    const note = sourceProvenanceNote({
      existing: [],
      webCount: 1,
      knowledgeSearch: 'failed',
    });
    expect(note).toContain('could not run for this message');
    expect(note).not.toContain('returned nothing');
  });

  it('stays silent on a turn without a knowledge base', () => {
    const plainWeb: Citation = {
      title: 'Earlier web result',
      date: '',
      url: 'https://x/y',
      number: 1,
      origin: 'web',
    };
    expect(
      sourceProvenanceNote({
        existing: [],
        webCount: 4,
        knowledgeSearch: 'none',
      }),
    ).toBe('');
    expect(
      sourceProvenanceNote({
        existing: [plainWeb],
        webCount: 4,
        knowledgeSearch: 'none',
      }),
    ).toBe('');
  });

  it('stays silent when the web search added nothing', () => {
    expect(
      sourceProvenanceNote({
        existing: [document(1)],
        webCount: 0,
        knowledgeSearch: 'searched',
      }),
    ).toBe('');
  });
});

describe('agentWebSearchReason', () => {
  const base = {
    agentName: 'Field HR',
    knowledgeSearch: 'searched' as const,
    sites: [],
  };

  it('explains a fallback: the documents lacked it and the rules allow a search', () => {
    expect(agentWebSearchReason({ ...base, knowledgeBaseAnswers: false })).toBe(
      'The documents of "Field HR" did not contain the answer, and the agent\'s instructions allow a public web search for this question.',
    );
  });

  it('does not claim the documents lacked the answer when they had it', () => {
    const reason = agentWebSearchReason({
      ...base,
      knowledgeBaseAnswers: true,
    });
    expect(reason).not.toContain('did not contain');
    expect(reason).toContain('in addition to the documents');
  });

  it('reports a failed document search as such', () => {
    expect(
      agentWebSearchReason({ ...base, knowledgeSearch: 'failed' }),
    ).toContain('could not be searched');
  });

  it('names the websites the search was limited to', () => {
    expect(
      agentWebSearchReason({
        ...base,
        knowledgeBaseAnswers: false,
        sites: ['dol.gov', 'irs.gov'],
      }),
    ).toMatch(/Limited to: dol\.gov, irs\.gov\.$/);
  });
});

describe('noWebSearchReminder', () => {
  it('names the document passages as the only sources that may be cited', () => {
    const reminder = noWebSearchReminder([document(1), document(2)]);
    expect(reminder).toContain('NO web search was run for this message');
    expect(reminder).toContain('The only sources for this message are [1]–[2]');
    expect(reminder).toContain('cite no other number');
  });

  it('allows no citation at all when the documents returned nothing', () => {
    expect(noWebSearchReminder([])).toContain(
      'There are no sources for this message; cite none.',
    );
  });
});

import {
  RawGenerateResponse,
  buildGenerateUserPrompt,
  buildRepairPrompt,
  findingsFor,
  fitGenerated,
  linkPolicyFor,
  quoteTokens,
  writeVersion,
} from '@/lib/services/workflows/shared/drafter/generate';
import { buildTightenInstruction } from '@/lib/services/workflows/shared/drafter/revise';

import { getSpecAdapter } from '@/lib/utils/shared/drafter/adapters';
import { channelPromptBlock } from '@/lib/utils/shared/drafter/channels/channelAdapter';
import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';

import { GenerateRequest } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const adapter = getSpecAdapter('channel')!;
const X = adapter.resolveSpec('x')!;
const LINKEDIN = adapter.resolveSpec('linkedin')!;
const LINK = 'https://example.org/statement';

const BRIEF: GenerateRequest['brief'] = {
  keyMessage: 'Water is life',
  links: [{ role: 'article', label: 'Statement', url: LINK }],
  language: 'English',
  items: [
    {
      id: 'i1',
      kind: 'quote',
      text: 'We had no clean water for eleven days.',
      verified: 'verbatim',
    },
  ],
};

const sentence = 'Our teams are at work. ';
const raw = (...texts: string[]): RawGenerateResponse => ({
  segments: texts.map((text) => ({ text, usedItemIds: [] })),
});

function args(answers: RawGenerateResponse[], spec = X) {
  const calls: string[] = [];
  return {
    calls,
    input: {
      adapter,
      spec,
      brief: BRIEF,
      tokens: quoteTokens(BRIEF.items),
      policy: linkPolicyFor(adapter, spec),
      userPrompt: 'USER',
      call: async (prompt: string) => {
        calls.push(prompt);
        return answers[Math.min(calls.length - 1, answers.length - 1)];
      },
    },
  };
}

const lengthFindings = (
  generated: Parameters<typeof findingsFor>[2],
  spec = X,
) =>
  findingsFor(adapter, spec, generated, BRIEF).filter(
    (finding) => finding.checkId === 'length',
  );

describe('the budget the model is given', () => {
  it('takes the numbering off instead of promising it was budgeted for', () => {
    // " 25/25" is six characters: 280 leaves 274 for words.
    const block = channelPromptBlock(getChannelProfile('x')!);
    expect(block).toContain('under 274 characters');
    expect(block).toContain('Aim for under 246');
  });

  it('leaves a single-post channel its whole limit', () => {
    expect(channelPromptBlock(getChannelProfile('linkedin')!)).toContain(
      'under 3000 characters',
    );
  });

  it('prices a quotation the way the platform counts it', () => {
    const brief: GenerateRequest['brief'] = {
      ...BRIEF,
      items: [{ ...BRIEF.items[0], text: '水がありませんでした' }],
    };
    const prompt = buildGenerateUserPrompt(
      brief,
      quoteTokens(brief.items),
      undefined,
      (text) => adapter.cost?.(X, text) ?? text.length,
    );
    // Ten CJK characters count double on X, plus the two marks.
    expect(prompt).toContain('costs 22 characters when inserted');
  });
});

describe('repair prompt for length', () => {
  it('states the measured overage, a margin, and what takes the room', () => {
    const generated = {
      specId: 'x',
      segments: [{ text: `${'a'.repeat(300)}\n\n${LINK}`, usedItemIds: [] }],
    };
    const prompt = buildRepairPrompt(
      ['{{q1}} aaa'],
      findingsFor(adapter, X, generated, BRIEF),
      {
        tokens: quoteTokens(BRIEF.items),
        cost: (text) => adapter.cost?.(X, text) ?? text.length,
        linkCost: () => 25,
      },
    );
    expect(prompt).toContain('Post 1 is 45 characters over');
    expect(prompt).toContain('Cut at least 68');
    expect(prompt).toContain('{{q1}} takes 40');
    expect(prompt).toContain('the link takes 25');
  });
});

describe('writeVersion', () => {
  it('makes one call when the first answer passes', async () => {
    const { calls, input } = args([raw('Short and fine.')]);
    const result = await writeVersion(input);
    expect(calls).toHaveLength(1);
    expect(result.segments[0].text).toBe(`Short and fine.\n\n${LINK}`);
  });

  it('gives a too-long answer a second repair round', async () => {
    const { calls, input } = args([
      raw('a'.repeat(400)),
      raw('a'.repeat(300)),
      raw('Now it fits.'),
    ]);
    const result = await writeVersion(input);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain('characters over the limit');
    expect(lengthFindings(result)).toEqual([]);
  });

  it('keeps the BEST attempt, not the last: a worse repair is discarded', async () => {
    // A single-post channel, so moving text cannot help: what comes back
    // is one of the three attempts.
    const words = (n: number) => 'a'.repeat(n);
    const { input } = args(
      [raw(words(3010)), raw(words(5000)), raw(words(4500))],
      LINKEDIN,
    );
    const result = await writeVersion({ ...input, spec: LINKEDIN });
    expect(result.segments[0].text).toBe(`${words(3010)}\n\n${LINK}`);
  });

  it('falls back to moving text between posts, never to truncating', async () => {
    const long = sentence.repeat(30).trim();
    const { input } = args([raw(long)]);
    const result = await writeVersion(input);
    expect(result.segments.length).toBeGreaterThan(1);
    expect(lengthFindings(result)).toEqual([]);
    // Every word survives, and the link is still in the last post.
    const words = result.segments
      .map((segment) => segment.text.replace(`\n\n${LINK}`, ''))
      .join(' ');
    expect(words).toBe(long);
    expect(result.segments.at(-1)?.text.endsWith(LINK)).toBe(true);
    expect(result.segments.filter((s) => s.text.includes(LINK))).toHaveLength(
      1,
    );
  });

  it('leaves a single-post channel over rather than cutting it', async () => {
    const long = sentence.repeat(200).trim();
    const { calls, input } = args([raw(long)], LINKEDIN);
    const result = await writeVersion({ ...input, spec: LINKEDIN });
    expect(calls).toHaveLength(3);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toContain(long);
    expect(lengthFindings(result, LINKEDIN)).toHaveLength(1);
  });
});

describe('fitGenerated', () => {
  it('never splits a quotation across posts', () => {
    const quote = BRIEF.items[0].text;
    const text = `${sentence.repeat(11)}A nurse told us: “${quote}” Then she went back to work.`;
    const fitted = fitGenerated(
      adapter,
      X,
      { specId: 'x', segments: [{ text, usedItemIds: ['i1'] }] },
      BRIEF,
      linkPolicyFor(adapter, X),
    );
    expect(fitted.segments.length).toBeGreaterThan(1);
    expect(fitted.segments.filter((s) => s.text.includes(quote))).toHaveLength(
      1,
    );
    expect(fitted.segments.some((s) => /“[^”]*$/u.test(s.text))).toBe(false);
  });
});

describe('tighten instruction', () => {
  it('asks for a number with a margin, and escalates with what is still over', () => {
    const first = buildTightenInstruction([{ segmentId: 's1', over: 14 }]);
    expect(first).toContain('"s1" is 14 characters over');
    expect(first).toContain('Cut at least 24');
    const second = buildTightenInstruction([{ segmentId: 's1', over: 14 }], {
      edits: [{ segmentId: 's1', before: 'very ', after: '', reason: '' }],
      stillOver: [{ segmentId: 's1', over: 9 }],
    });
    expect(second).toContain('STILL 9 over');
    expect(second).toContain('"very " -> ""');
  });
});

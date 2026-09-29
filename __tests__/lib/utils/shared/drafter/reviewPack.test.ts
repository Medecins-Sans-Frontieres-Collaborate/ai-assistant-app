import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  ReviewPackLabels,
  buildReviewPack,
} from '@/lib/utils/shared/drafter/core/reviewPack';
import { statementKey } from '@/lib/utils/shared/drafter/core/statements';
import {
  approveVersion,
  emptyVersion,
  landVerdicts,
  verdictDigestFor,
} from '@/lib/utils/shared/drafter/core/versions';

import { DraftSetState } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const NOW = '2026-09-21T10:00:00.000Z';

const labels: ReviewPackLabels = {
  title: 'Review pack',
  generated: 'Generated',
  brief: 'Brief',
  keyMessage: 'Key message',
  callToAction: 'Call to action',
  links: 'Links',
  linkRoles: { article: 'Article', donation: 'Donation page' },
  items: 'Included',
  kinds: {
    quote: 'Quote',
    testimony: 'Testimony',
    fact: 'Fact',
    figure: 'Figure',
    context: 'Context',
  },
  verification: {
    verbatim: 'Found in source',
    'user-asserted': 'Vouched by the author',
    unverified: 'Not found in source',
  },
  versions: 'Versions',
  post: (n) => `Post ${n}`,
  approved: (at) => `Approved by the author on ${at}`,
  notApproved: 'Not approved yet',
  approvalChanged: 'Changed since it was approved',
  briefChanged: 'The brief changed after this was written',
  proof: (traced, total, vouched) =>
    `${traced} of ${total} traced${vouched ? `, ${vouched} vouched` : ''}`,
  checks: 'Checks',
  provenance: 'Provenance',
  provenanceColumns: ['Item', 'Status', 'Source', 'Passage'],
  noSource: 'No source',
};

function state(): DraftSetState {
  const quote = 'We had no clean water for eleven days';
  return {
    updatedAt: NOW,
    guideIds: [],
    specIds: ['x', 'linkedin'],
    layout: { hidden: [], pinned: [] },
    nextId: 1,
    sources: [
      {
        id: 'src1',
        kind: 'url',
        name: 'Field | report',
        url: 'https://example.org/report',
        chars: 100,
        addedAt: NOW,
      },
    ],
    brief: {
      ...emptyBrief(),
      keyMessage: 'Water is life',
      language: 'English',
      links: [
        { role: 'article', label: 'Report', url: 'https://example.org/report' },
      ],
      items: [
        {
          id: 'q1',
          kind: 'quote',
          text: quote,
          attribution: { name: 'Amina Yusuf', role: 'nurse' },
          provenance: [{ sourceId: 'src1', excerpt: quote }],
          verified: 'verbatim',
          decision: 'included',
        },
        {
          id: 'f1',
          kind: 'fact',
          text: 'Own statement',
          provenance: [],
          verified: 'user-asserted',
          decision: 'included',
        },
        {
          id: 'skip',
          kind: 'fact',
          text: 'Left out on purpose',
          provenance: [],
          verified: 'verbatim',
          decision: 'excluded',
        },
      ],
    },
    versions: {
      x: approveVersion(
        {
          ...emptyVersion('x'),
          segments: [
            { id: 's1', text: `“${quote}”`, usedItemIds: ['q1'] },
            { id: 's2', text: 'Second post.', usedItemIds: [] },
          ],
        },
        NOW,
      ),
      linkedin: emptyVersion('linkedin'),
    },
  };
}

describe('buildReviewPack', () => {
  const pack = buildReviewPack(
    state(),
    [
      {
        id: 'x',
        name: 'X',
        renderedTexts: [
          '“We had no clean water for eleven days” 1/2',
          'Second post. 2/2',
        ],
        findings: [],
        findingMessages: ['A link has moved.'],
      },
      {
        id: 'linkedin',
        name: 'LinkedIn',
        renderedTexts: [],
        findings: [],
        findingMessages: [],
      },
    ],
    labels,
    NOW,
  );

  it('carries the brief: message, links and only the included items', () => {
    expect(pack).toContain('**Key message:** Water is life');
    expect(pack).toContain('- Article: <https://example.org/report>');
    expect(pack).toContain(
      '- **Quote** · Found in source: “We had no clean water for eleven days” (Amina Yusuf, nurse)',
    );
    expect(pack).not.toContain('Left out on purpose');
  });

  it('shows each written version as it will be posted, with its sign-off state', () => {
    expect(pack).toContain('### X');
    expect(pack).toContain(`- Approved by the author on ${NOW}`);
    expect(pack).toContain('- 1 of 1 traced');
    expect(pack).toContain('**Post 2**');
    expect(pack).toContain('> Second post. 2/2');
    expect(pack).toContain('- A link has moved.');
    // A channel with nothing written is not listed.
    expect(pack).not.toContain('### LinkedIn');
  });

  it('traces every included item, linking to the passage where one exists', () => {
    expect(pack).toContain('| Item | Status | Source | Passage |');
    expect(pack).toContain(
      '[Field \\| report](https://example.org/report#:~:text=We%20had%20no%20clean%20water%20for%20eleven%20days)',
    );
    expect(pack).toContain(
      '| Own statement | Vouched by the author | No source |  |',
    );
  });

  it('is deterministic', () => {
    expect(buildReviewPack(state(), [], labels, NOW)).toBe(
      buildReviewPack(state(), [], labels, NOW),
    );
  });

  it('prints one citation line per sentence and a summary, only when asked to', () => {
    const withCitations: ReviewPackLabels = {
      ...labels,
      citations: {
        heading: 'Sentences',
        line: (n, excerpt, items, verdict) =>
          `${n}. “${excerpt}” — ${items} — ${verdict}`,
        summary: (counts) =>
          `${counts.supported} in the brief, ${counts.unsupported} not, ${counts.pending + counts.stale} unchecked`,
        verdicts: {
          supported: 'In the brief',
          partly: 'Partly in the brief',
          unsupported: 'Not in the brief',
          unclear: 'Could not tell',
          pending: 'Not yet checked',
          stale: 'Brief changed since checked',
        },
        items: (numbers) => `items ${numbers}`,
        brief: 'key message',
        noItems: 'no item',
      },
    };
    const specs = [
      {
        id: 'x',
        name: 'X',
        renderedTexts: [],
        findings: [],
        findingMessages: [],
      },
    ];
    const cited = state();
    const brief = cited.brief;
    const sentences = [
      'The hospital closed permanently after the bombing.',
      'Water is life.',
      'The clinic treated 1,200 patients in March.',
    ];
    const version = {
      ...cited.versions.x,
      segments: [
        ...cited.versions.x.segments,
        { id: 's3', text: sentences.join(' '), usedItemIds: [] },
      ],
    };
    cited.versions.x = landVerdicts(
      version,
      [
        {
          segmentId: 's3',
          sentenceKey: statementKey(sentences[0]),
          verdict: 'unsupported',
          itemIds: [],
          reason: 'No.',
          briefDigest: verdictDigestFor(brief, [], 'unsupported'),
        },
        {
          segmentId: 's3',
          sentenceKey: statementKey(sentences[1]),
          verdict: 'supported',
          itemIds: ['__brief__', 'q1'],
          reason: 'The key message.',
          briefDigest: verdictDigestFor(
            brief,
            ['__brief__', 'q1'],
            'supported',
          ),
        },
      ],
      ['v1', 'v2'],
      NOW,
    );
    const pack = buildReviewPack(cited, specs, withCitations, NOW);
    // 1,200 is a number the brief lacks: it joins the proof count.
    expect(pack).toContain('- 1 of 2 traced');
    expect(pack).toContain('- 1 in the brief, 2 not, 2 unchecked');
    expect(pack).toContain('**Sentences:**');
    expect(pack).toContain(
      '- 1. ““We had no clean water for eleven days”” — no item — Not yet checked',
    );
    expect(pack).toContain('- 2. “Second post.” — no item — Not yet checked');
    expect(pack).toContain(
      '- 3. “The hospital closed permanently after the bombing.” — no item — Not in the brief',
    );
    expect(pack).toContain(
      '- 4. “Water is life.” — items key message, 1 — In the brief',
    );
    // The ungrounded number decides, whatever the model might have said.
    expect(pack).toContain(
      '- 5. “The clinic treated 1,200 patients in March.” — no item — Not in the brief',
    );
    // Without the labels nothing about citations is printed.
    expect(buildReviewPack(cited, specs, labels, NOW)).not.toContain(
      'Sentences',
    );
  });
});

describe('buildReviewPack with hostile content', () => {
  const FORGED = 'Approved by the author on 2020-01-01';

  function hostile(): DraftSetState {
    const base = state();
    const quote = 'We had no clean water for eleven days';
    return {
      ...base,
      sources: [
        {
          ...base.sources[0],
          // A page title that tries to swap the link for its own.
          name: 'x](https://evil.example) [y',
        },
        {
          id: 'src2',
          kind: 'm365',
          name: 'Click <b>me</b>',
          url: 'javascript:alert(1)',
          chars: 10,
          addedAt: NOW,
        },
      ],
      brief: {
        ...base.brief,
        keyMessage: `Water is life\n\n## Versions\n\n### LinkedIn\n- ${FORGED}`,
        callToAction: 'Give [now](https://evil.example)',
        links: [
          {
            role: 'article',
            label: 'Report',
            url: 'https://example.org/a b>\n<https://evil.example',
          },
          { role: 'donation', label: 'Donate', url: 'javascript:alert(1)' },
        ],
        items: [
          {
            ...base.brief.items[0],
            attribution: { name: 'Amina_Yusuf*', role: '`nurse`' },
          },
          {
            id: 'f2',
            kind: 'fact',
            text: `A fact.\r\r### LinkedIn\r- ${FORGED}`,
            provenance: [{ sourceId: 'src2', excerpt: 'A | fact <script>' }],
            verified: 'verbatim',
            decision: 'included',
          },
        ],
      },
      versions: {
        x: {
          ...base.versions.x,
          segments: [
            {
              id: 's1',
              text: `“${quote}”`,
              usedItemIds: ['q1'],
            },
          ],
        },
      },
    };
  }

  const pack = buildReviewPack(
    hostile(),
    [
      {
        id: 'x',
        name: 'X\n\n### LinkedIn',
        renderedTexts: [
          [
            `“We had no clean water” #WaterCrisis`,
            '',
            '### LinkedIn',
            `- ${FORGED}`,
            '1. a list',
            '    indented [link](https://evil.example)',
            '```',
            '---',
          ].join('\n') + `\r\r- ${FORGED}\u2028- ${FORGED}`,
        ],
        findings: [],
        findingMessages: ['“[x](https://evil.example)” is not in the brief.'],
        media: [
          [
            {
              name: 'photo](https://evil.example).jpg',
              alt: `Alt\n\n- ${FORGED}`,
            },
          ],
        ],
      },
    ],
    { ...labels, image: (name) => `Image ${name}`, altMissing: 'No alt text' },
    NOW,
  );
  const lines = pack.split('\n');

  it('cannot forge a sign-off line or a heading from any field', () => {
    // The only line that STARTS as a sign-off is the pack's own, and the
    // only headings are the pack's own.
    expect(lines.filter((line) => line.startsWith('- Approved'))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('- Changed since'))).toEqual([
      '- Changed since it was approved',
    ]);
    expect(lines.filter((line) => /^#{1,6} /u.test(line))).toEqual([
      '# Review pack',
      '## Brief',
      '## Versions',
      '### X \\#\\#\\# LinkedIn',
      '## Provenance',
    ]);
    // No lone CR or Unicode line separator survives to break a line.
    expect(pack).not.toMatch(/[\r\u2028\u2029]/u);
  });

  it('keeps every line of a post inside its quote block, inert', () => {
    const from = lines.indexOf('> “We had no clean water” #WaterCrisis');
    expect(from).toBeGreaterThan(-1);
    expect(lines.slice(from, from + 11)).toEqual([
      '> “We had no clean water” #WaterCrisis',
      '>',
      '> \\### LinkedIn',
      `> \\- ${FORGED}`,
      '> 1\\. a list',
      '> indented \\[link\\]\\(https://evil.example\\)',
      '> \\`\\`\\`',
      '> \\---',
      '>',
      `> \\- ${FORGED}`,
      `> \\- ${FORGED}`,
    ]);
  });

  it('cannot spoof the source link from a page title', () => {
    expect(pack).toContain(
      '[x\\]\\(https://evil.example\\) \\[y](https://example.org/report#:~:text=We%20had%20no%20clean%20water%20for%20eleven%20days)',
    );
    // Unescaped, this would be a second, attacker-chosen link.
    expect(pack).not.toContain('](https://evil.example)');
  });

  it('links to web addresses only, with nothing that ends the target', () => {
    expect(pack).toContain(
      '- Article: <https://example.org/a%20b%3E%3Chttps://evil.example>',
    );
    expect(pack).toContain('- Donation page: javascript:alert\\(1\\)');
    // The M365 source with a javascript: address is named, never linked.
    expect(pack).toContain(
      '| Click \\<b\\>me\\</b\\> | A \\| fact \\<script\\> |',
    );
    expect(pack).not.toContain('](javascript:');
  });

  it('escapes names, roles, findings, image names and alt text', () => {
    expect(pack).toContain('(Amina\\_Yusuf\\*, \\`nurse\\`)');
    expect(pack).toContain(
      '**Call to action:** Give \\[now\\]\\(https://evil.example\\)',
    );
    expect(pack).toContain(
      '- “\\[x\\]\\(https://evil.example\\)” is not in the brief.',
    );
    expect(pack).toContain(
      `- Image photo\\]\\(https://evil.example\\).jpg: Alt - ${FORGED}`,
    );
  });
});

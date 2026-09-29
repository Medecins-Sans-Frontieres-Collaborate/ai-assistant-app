/**
 * Version generation. One structured call per spec, in parallel, each
 * written from the INCLUDED brief items only.
 *
 * Quotations are handed to the model as opaque tokens ({{q1}}) and put back
 * by code afterwards, so a verbatim quote cannot be paraphrased, trimmed or
 * "improved" on the way through. The model may shorten one only through
 * the form {{q1|first words … last words}}: code verifies it with the same
 * elision matcher the grounding check uses and re-emits the quotation from
 * the item's OWN characters; a form that fails inserts the full quote and
 * the repair round says so. Anything the model still invents inside
 * quotation marks is caught by the grounding check.
 *
 * Kind-agnostic: the structural rules come from the spec adapter's
 * `promptBlock`, and the repair round reads the adapter's own findings.
 */
import { checkVersion } from '@/lib/utils/shared/drafter/adapters';
import { SpecAdapter } from '@/lib/utils/shared/drafter/core/adapter';
import {
  countWords,
  matchQuotation,
  parseQuotation,
} from '@/lib/utils/shared/drafter/core/elision';
import { fitByMoving } from '@/lib/utils/shared/drafter/core/fit';
import {
  DEFAULT_LINK_POLICY,
  LinkPolicy,
  linkSegmentIndex,
  linksCost,
  placeLinks,
  stripLinks,
} from '@/lib/utils/shared/drafter/core/links';
import {
  blockingScore,
  protectedRanges,
} from '@/lib/utils/shared/drafter/core/revisions';
import {
  TextRange,
  normalizeWithMap,
} from '@/lib/utils/shared/drafter/core/verify';
import { CheckFinding } from '@/lib/utils/shared/review/deterministicChecks';

import {
  Brief,
  BriefItem,
  GenerateRequest,
  GenerateToneInput,
  GeneratedVersion,
  Segment,
  VersionSpec,
} from '@/types/drafter';

export const GENERATE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['segments'],
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'usedItemIds'],
        properties: {
          text: { type: 'string' },
          usedItemIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the brief items this text draws on.',
          },
        },
      },
    },
  },
};

export interface RawGenerateResponse {
  segments: Array<{ text: string; usedItemIds: string[] }>;
}

type BriefInput = GenerateRequest['brief'];
type ItemInput = BriefInput['items'][number];

function isSpoken(item: ItemInput): boolean {
  return item.kind === 'quote' || item.kind === 'testimony';
}

/** `{{q1}}` for the first spoken item, and so on. Stable per request. */
export function quoteTokens(items: ItemInput[]): Map<string, ItemInput> {
  const tokens = new Map<string, ItemInput>();
  items.filter(isSpoken).forEach((item, index) => {
    tokens.set(`{{q${index + 1}}}`, item);
  });
  return tokens;
}

export function linkPolicyFor(
  adapter: SpecAdapter<VersionSpec>,
  spec: VersionSpec,
): LinkPolicy {
  return adapter.linkPolicy?.(spec) ?? DEFAULT_LINK_POLICY;
}

/**
 * What the posts are FOR. Asking for money is never assumed: it is the
 * purpose only when the user supplied a donation link, and otherwise the
 * model is told not to ask at all.
 */
export function buildIntentBlock(brief: BriefInput): string {
  const donation = brief.links.some((link) => link.role === 'donation');
  const article = brief.links.find((link) => link.role === 'article');
  const lines: string[] = ['PURPOSE'];
  if (donation) {
    lines.push(
      '- These posts invite people to donate. Tell the story first; close ' +
        'with one clear, dignified invitation to give. No guilt, no ' +
        'pressure, no urgency the brief does not state, and never an amount ' +
        'or a claim about what a gift achieves unless the brief states it.',
    );
  } else {
    lines.push(
      '- These posts inform. Do NOT ask for donations, money or support of ' +
        'any kind.',
    );
  }
  if (article) {
    lines.push(
      `- They also point readers to the full piece ("${article.label}"). ` +
        'End with a short line that leads into it, such as "Read the full ' +
        'statement:", in the language of the post.',
    );
  }
  return lines.join('\n');
}

/** Tells the model a link is coming, and how much room it takes. */
export function buildLinksBlock(brief: BriefInput, policy: LinkPolicy): string {
  if (brief.links.length === 0) {
    return 'LINKS\n- None. Do not write any URL.';
  }
  if (!policy.allowed) {
    return 'LINKS\n- Links are not clickable on this target. Do not write any URL.';
  }
  const one = brief.links.length === 1;
  const where =
    policy.position === 'first' ? 'the first post' : 'the last post';
  return [
    'LINKS',
    `- ${one ? 'A link is' : 'Links are'} added for you at the end of ${where}, on ${one ? 'its own line' : 'their own lines'}. NEVER write a URL yourself.`,
    `- ${one ? 'It takes' : 'They take'} ${linksCost(brief.links, policy)} characters of that post's limit: that post must be at least ${linksCost(brief.links, policy)} characters shorter than the limit stated below.`,
    '- End that post so that a link reads naturally directly after it.',
  ].join('\n');
}

export function buildGenerateSystemPrompt(
  specBlock: string,
  tone: GenerateToneInput | undefined,
  language: string,
  extraBlocks = '',
): string {
  const toneBlock = tone
    ? `\n\nVOICE AND TONE RULES ("${tone.name}"):\n${tone.voiceRules}${
        tone.examples ? `\nExamples:\n${tone.examples}` : ''
      }`
    : '';
  return `You write public communications for a humanitarian medical organisation, from a brief a person has already reviewed and approved.

THE BRIEF IS THE ONLY SOURCE OF TRUTH
- State nothing that is not in the brief: no fact, number, date, place, name or claim of your own.
- Every number you write must appear in the brief, written the same way.
- QUOTATIONS: never type a quotation yourself. Each available quotation has a token such as {{q1}}. To use one, write the token exactly where the quotation goes, without quotation marks; the exact words are inserted for you. To shorten one, write {{q1|first words … last words}}: keep consecutive words of the original, in order, and write … where you leave words out; never change or add a word, never write brackets, never merge two quotations. A SHORTENED QUOTATION MUST STILL READ AS A COMPLETE, NATURAL SENTENCE: keep its subject and main verb, leave out only an aside, a list or a clause the sentence does not need, leave no more than about eight words out in one gap, never a negation or a 'but', and keep at least half of the original. Good: “We had no clean water … for eleven days” from “We had no clean water, with the wells full of mud, for eleven days”. Bad: “The new deal … generic versions” (the ends do not connect). If a quotation cannot be shortened so that it still reads well, use the full quotation, a shorter one, or none. Never put any other text inside quotation marks.
- Name a speaker only as the brief names them.

WHAT WORKS
- Lead with a person, not a statistic. Prefer a quotation or testimony over a figure when both would fit; items are listed in priority order.
- Plain words. No hype, no exclamation marks, no emoji unless the voice rules ask for them.
- The key message must be unmistakable.

Write in ${language}.

${extraBlocks}

STRUCTURE FOR THIS TARGET
${specBlock}${toneBlock}

In "usedItemIds", list the id of every brief item each segment draws on.`;
}

export function buildGenerateUserPrompt(
  brief: BriefInput,
  tokens: Map<string, ItemInput>,
  current?: string[],
  /** What text costs on this target; a CJK quotation costs double on X. */
  cost: (text: string) => number = (text) => text.length,
): string {
  const tokenOf = new Map([...tokens].map(([token, item]) => [item.id, token]));
  const lines: string[] = [`KEY MESSAGE: ${brief.keyMessage}`];
  if (brief.callToAction) lines.push(`CALL TO ACTION: ${brief.callToAction}`);
  lines.push('', 'BRIEF ITEMS, in priority order:');
  for (const item of brief.items) {
    const token = tokenOf.get(item.id);
    const speaker = item.attribution
      ? ` Speaker: ${item.attribution.name}${
          item.attribution.role ? `, ${item.attribution.role}` : ''
        }.`
      : '';
    lines.push(
      token
        ? `- id ${item.id} [${item.kind}] token ${token} (costs ${cost(quoted(item.text))} characters in full; shorten it with ${token.slice(0, -2)}|first words … last words}}): ${item.text}${speaker}`
        : `- id ${item.id} [${item.kind}]: ${item.text}`,
    );
  }
  if (current && current.some((text) => text.trim())) {
    lines.push(
      '',
      'CURRENT TEXT. The brief has changed since it was written. Keep ' +
        'everything that is still right and change only what the brief now ' +
        'requires:',
      // Links are re-appended by code, so the model never sees a URL to copy.
      ...current.map(
        (text, index) => `[${index + 1}] ${stripLinks(text, brief.links)}`,
      ),
    );
  }
  return lines.join('\n');
}

/** A quotation as it is inserted: the exact words, in quotation marks. */
function quoted(text: string): string {
  return `“${text}”`;
}

/**
 * A quote token, whole (`{{q1}}`) or shortened (`{{q1|first … last}}`),
 * with any quotation marks the model put around it. The form may be empty
 * or over-long: such a token still matches, so it is never published raw.
 */
export const TOKEN_PATTERN =
  /(?:["“«„]\s*)?\{\{(q\d+)(?:\|([^{}\n]*))?\}\}(?:\s*["”»“])?/gu;

/** The longest shortened form a token may carry; longer ones go in whole. */
export const MAX_FORM_CHARS = 600;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The token as the model wrote it, quotation marks aside. */
function tokenText(name: string, form: string | undefined): string {
  return form === undefined ? `{{${name}}}` : `{{${name}|${form}}}`;
}

/** Whether words of the item lie before the first run or after the last. */
function edgeGaps(
  itemNormalized: string,
  pieces: TextRange[],
): { leading: boolean; trailing: boolean } {
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  return {
    leading: !!first && WORD_CHAR.test(itemNormalized.slice(0, first.start)),
    trailing: !!last && WORD_CHAR.test(itemNormalized.slice(last.end)),
  };
}

/**
 * The text a token stands for. A shortened form is accepted only when it
 * is an ordered verbatim elision of the item (the grounding matcher's own
 * rule), and the words are then taken from the ITEM's characters, never
 * from what the model typed. Words left out at either edge are shown as an
 * ellipsis so the reader (and the grounding check) sees the quotation was
 * shortened. Brackets are not for the model. A form that fails, is empty
 * or is over-long inserts the whole quotation and names itself in
 * `unverifiedForm`.
 */
/** Why a shortened form went in whole, in words the model can act on. */
export type RefusedFormReason =
  | 'empty-or-long'
  | 'brackets'
  | 'keeps-too-little'
  | 'not-verbatim';

export const REFUSED_FORM_ADVICE: Record<RefusedFormReason, string> = {
  'empty-or-long': 'the form was empty or far too long',
  brackets: 'brackets are not allowed in a shortened quotation',
  'keeps-too-little':
    'it kept less than half of the quotation, so it no longer reads as a sentence; keep at least half, or use the full quotation or a different one',
  'not-verbatim':
    'its words are not consecutive words of the original in order, or a gap of more than eight words or one that hides a negation or a contrast was left out; keep the subject and verb and leave out only an aside',
};

/** The share of a quotation's words a shortened form must keep. */
export const MIN_KEPT_SHARE = 0.5;

function renderToken(
  name: string,
  form: string | undefined,
  tokens: Map<string, ItemInput>,
): {
  text: string;
  itemId: string;
  unverifiedForm?: string;
  refusedFor?: RefusedFormReason;
} | null {
  const item = tokens.get(`{{${name}}}`);
  if (!item) return null;
  const whole = { text: quoted(item.text), itemId: item.id };
  if (form === undefined) return whole;
  const refuse = (refusedFor: RefusedFormReason) => ({
    ...whole,
    unverifiedForm: form,
    refusedFor,
  });
  if (form.trim() === '' || form.length > MAX_FORM_CHARS) {
    return refuse('empty-or-long');
  }
  if (form.includes('[') || form.includes(']')) return refuse('brackets');
  const norm = normalizeWithMap(item.text);
  // A readability floor over and above what the matcher verifies: a form
  // that keeps a third of the sentence is verbatim in letter and unreadable
  // in fact ("The new deal … generic versions").
  const parsedForm = parseQuotation(form);
  const unverified = refuse('not-verbatim');
  if (!parsedForm) return unverified;
  const kept = parsedForm.fragments.reduce((sum, f) => sum + f.words, 0);
  if (kept < countWords(norm.text) * MIN_KEPT_SHARE) {
    return refuse('keeps-too-little');
  }
  // A bracketed insertion cannot occur here, so no word is ever allowed.
  const match = matchQuotation(norm.text, form, () => false);
  if (!match) return unverified;
  let { pieces } = match;
  let edges = edgeGaps(norm.text, pieces);
  const parsed = parseQuotation(form);
  // A plain sub-span ("We wanted to leave" out of "We wanted to leave, but
  // we could not") leaves words out exactly as "We wanted to leave …" does,
  // so it is held to the edge-gap rules by adding the ellipsis the model
  // left out; the rules may then refuse it.
  if (
    (edges.leading && !parsed?.leadingGap) ||
    (edges.trailing && !parsed?.trailingGap)
  ) {
    const signalled = `${edges.leading ? '… ' : ''}${form}${edges.trailing ? ' …' : ''}`;
    const rematch = matchQuotation(norm.text, signalled, () => false);
    if (!rematch) return unverified;
    pieces = rematch.pieces;
    edges = edgeGaps(norm.text, pieces);
  }
  const slices = pieces.map((piece) =>
    item.text.slice(norm.map[piece.start], norm.map[piece.end - 1] + 1),
  );
  const text = `${edges.leading ? '… ' : ''}${slices.join(' … ')}${edges.trailing ? ' …' : ''}`;
  return { text: quoted(text), itemId: item.id };
}

/**
 * Puts the exact words back. Quotation marks the model added around a token
 * are dropped so the words are never double-quoted; tokens that name no
 * item are removed rather than published. `unverifiedForms` lists the
 * tokens whose shortened form was not verbatim and went in whole.
 */
export function substituteQuotes(
  text: string,
  tokens: Map<string, ItemInput>,
): { text: string; usedItemIds: string[]; unverifiedForms: string[] } {
  const used: string[] = [];
  const unverifiedForms: string[] = [];
  const replaced = text.replace(
    TOKEN_PATTERN,
    (_match, name: string, form: string | undefined) => {
      const rendered = renderToken(name, form, tokens);
      if (!rendered) return '';
      used.push(rendered.itemId);
      if (rendered.unverifiedForm !== undefined) {
        unverifiedForms.push(tokenText(name, form));
      }
      return rendered.text;
    },
  );
  return {
    text: replaced.replace(/[ \t]{2,}/gu, ' ').trim(),
    usedItemIds: used,
    unverifiedForms,
  };
}

export function normalizeGenerated(
  raw: RawGenerateResponse,
  spec: VersionSpec,
  brief: BriefInput,
  tokens: Map<string, ItemInput>,
  policy: LinkPolicy = DEFAULT_LINK_POLICY,
): GeneratedVersion {
  const known = new Set(brief.items.map((item) => item.id));
  const segments = (Array.isArray(raw.segments) ? raw.segments : [])
    .map((segment) => {
      const { text, usedItemIds } = substituteQuotes(
        String(segment?.text ?? ''),
        tokens,
      );
      const reported = Array.isArray(segment?.usedItemIds)
        ? segment.usedItemIds.filter((id) => known.has(id))
        : [];
      return { text, usedItemIds: [...new Set([...reported, ...usedItemIds])] };
    })
    .filter((segment) => segment.text);
  const placed = placeLinks(
    segments.map((segment) => segment.text),
    brief.links,
    policy,
  );
  return {
    specId: spec.id,
    segments: segments.map((segment, index) => ({
      ...segment,
      text: placed[index],
    })),
  };
}

/** The request's brief as a core `Brief`, so the shared checks can run. */
export function briefForChecks(brief: BriefInput): Brief {
  return {
    rev: 0,
    keyMessage: brief.keyMessage,
    callToAction: brief.callToAction,
    links: brief.links,
    language: brief.language,
    items: brief.items.map(
      (item): BriefItem => ({
        ...item,
        provenance: [],
        decision: 'included',
      }),
    ),
  };
}

export function findingsFor(
  adapter: SpecAdapter<VersionSpec>,
  spec: VersionSpec,
  generated: GeneratedVersion,
  brief: BriefInput,
): CheckFinding[] {
  const segments: Segment[] = generated.segments.map((segment, index) => ({
    id: `g${index}`,
    ...segment,
  }));
  return checkVersion(adapter, spec, segments, briefForChecks(brief));
}

/** What a repair prompt needs to explain a length failure in numbers. */
export interface RepairDetail {
  tokens: Map<string, ItemInput>;
  cost: (text: string) => number;
  /** Characters the links take in post `index` of `total`. */
  linkCost: (index: number, total: number) => number;
}

function lengthProblem(
  finding: CheckFinding,
  rawSegments: string[],
  detail: RepairDetail | undefined,
): string {
  const post = Number(finding.values?.post ?? 1);
  const over = Number(finding.values?.count ?? 0);
  const parts: string[] = [];
  if (detail) {
    const raw = rawSegments[post - 1] ?? '';
    for (const match of raw.matchAll(TOKEN_PATTERN)) {
      const [, name, form] = match;
      const rendered = renderToken(name, form, detail.tokens);
      if (!rendered) continue;
      const token = tokenText(name, form);
      parts.push(`${token} takes ${detail.cost(rendered.text)}`);
      if (rendered.unverifiedForm !== undefined) {
        const why = rendered.refusedFor
          ? REFUSED_FORM_ADVICE[rendered.refusedFor]
          : REFUSED_FORM_ADVICE['not-verbatim'];
        parts.push(
          `${token} was inserted in full because ${why}; shorten it differently or use it whole`,
        );
      }
    }
    const link = detail.linkCost(post - 1, rawSegments.length);
    if (link > 0) parts.push(`the link takes ${link}`);
  }
  const room = parts.length > 0 ? ` In that post ${parts.join(', ')}.` : '';
  // Asking for exactly the overage lands one character short as often as
  // not, so ask for a margin.
  return (
    `- Post ${post} is ${over} characters over the limit, measured the way ` +
    `the platform counts. Cut at least ${over + Math.max(10, Math.ceil(over * 0.5))} ` +
    `characters of your own words from it, use a shorter quotation or none, ` +
    `or move a sentence to another post.${room}`
  );
}

/**
 * An automatic repair round: tells the model exactly what failed, in
 * numbers. Returns null when nothing blocking was found, so no further call
 * is made.
 */
export function buildRepairPrompt(
  /** The model's own answer, tokens still in place. */
  rawSegments: string[],
  findings: CheckFinding[],
  detail?: RepairDetail,
): string | null {
  const blocking = findings.filter((finding) => finding.severity === 'block');
  if (blocking.length === 0) return null;
  const problems = blocking.map((finding) => {
    switch (finding.checkId) {
      case 'length':
        return lengthProblem(finding, rawSegments, detail);
      case 'segments':
        return `- There are ${finding.values?.count} posts; the maximum is ${finding.values?.max}.`;
      case 'quote-verbatim':
        return '- You typed a quotation yourself. Use only the {{q…}} tokens, whole or shortened as {{q1|first words … last words}}, and put nothing else inside quotation marks.';
      case 'number-grounded':
        return "- You wrote a number that is not in the brief. Remove it or use the brief's number exactly.";
      case 'link-grounded':
        return '- You wrote a link yourself. Remove it; links are added for you.';
      default:
        return `- ${finding.checkId}`;
    }
  });
  return `Your previous answer broke these rules:\n${[...new Set(problems)].join('\n')}\n\nPrevious answer:\n${rawSegments
    .map((text, index) => `[${index + 1}] ${text}`)
    .join('\n')}\n\nReturn the whole corrected answer.`;
}

/** A length failure gets a second try: it is the one a platform rejects. */
export const MAX_REPAIR_ROUNDS = 2;

/**
 * The last resort for a version that is still too long, and only where the
 * spec has more than one segment: move text between segments, rewording
 * nothing. Links are taken out first and placed again, with their room kept
 * free, so they stay where the policy puts them.
 */
export function fitGenerated(
  adapter: SpecAdapter<VersionSpec>,
  spec: VersionSpec,
  generated: GeneratedVersion,
  brief: BriefInput,
  policy: LinkPolicy,
): GeneratedVersion {
  const options = adapter.fitOptions?.(spec);
  if (!options) return generated;
  const core = briefForChecks(brief);
  const bare: Segment[] = generated.segments.map((segment, index) => ({
    id: `g${index}`,
    usedItemIds: segment.usedItemIds,
    text: stripLinks(segment.text, brief.links),
  }));
  let minted = 0;
  const report = fitByMoving(
    bare,
    {
      ...options,
      protectedRanges: (segment) => protectedRanges(segment, core),
      reserve: (index, total) =>
        index === linkSegmentIndex(total, policy)
          ? linksCost(brief.links, policy)
          : 0,
    },
    () => `f${(minted += 1)}`,
  );
  const placed = placeLinks(
    report.segments.map((segment) => segment.text),
    brief.links,
    policy,
  );
  return {
    ...generated,
    segments: report.segments.map((segment, index) => ({
      text: placed[index],
      usedItemIds: segment.usedItemIds,
    })),
  };
}

export interface WriteArgs {
  adapter: SpecAdapter<VersionSpec>;
  spec: VersionSpec;
  brief: BriefInput;
  tokens: Map<string, ItemInput>;
  policy: LinkPolicy;
  userPrompt: string;
  call: (prompt: string, label: string) => Promise<RawGenerateResponse>;
}

/**
 * One version, made to pass its checks as far as that can be done without a
 * person: the first answer, then repair rounds told exactly what failed,
 * then a deterministic refit. The BEST attempt is kept, never simply the
 * last: a repair that comes back worse is thrown away. Whatever is still
 * wrong is returned as it is and shown to the user as a finding; nothing is
 * ever truncated to make a number come out.
 */
export async function writeVersion(args: WriteArgs): Promise<GeneratedVersion> {
  const { adapter, spec, brief, tokens, policy, userPrompt, call } = args;
  const detail: RepairDetail = {
    tokens,
    cost: (text) => adapter.cost?.(spec, text) ?? text.length,
    linkCost: (index, total) =>
      policy.allowed && index === linkSegmentIndex(total, policy)
        ? linksCost(brief.links, policy)
        : 0,
  };
  const rawTexts = (raw: RawGenerateResponse): string[] =>
    (Array.isArray(raw.segments) ? raw.segments : []).map((segment) =>
      String(segment?.text ?? ''),
    );

  let raw = await call(userPrompt, `generate:${spec.id}`);
  let best = normalizeGenerated(raw, spec, brief, tokens, policy);
  let findings = findingsFor(adapter, spec, best, brief);
  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round += 1) {
    const repair = buildRepairPrompt(rawTexts(raw), findings, detail);
    if (!repair) return best;
    // A second round is only for length; a model that invented a quotation
    // twice will not be argued out of it, and the finding tells the user.
    if (round > 1 && !findings.some((f) => f.checkId === 'length')) break;
    const nextRaw = await call(
      `${userPrompt}\n\n${repair}`,
      `repair${round}:${spec.id}`,
    );
    const next = normalizeGenerated(nextRaw, spec, brief, tokens, policy);
    if (next.segments.length === 0) continue;
    const nextFindings = findingsFor(adapter, spec, next, brief);
    if (
      best.segments.length === 0 ||
      blockingScore(nextFindings) < blockingScore(findings)
    ) {
      raw = nextRaw;
      best = next;
      findings = nextFindings;
    }
  }
  if (!findings.some((finding) => finding.checkId === 'length')) return best;
  const fitted = fitGenerated(adapter, spec, best, brief, policy);
  return blockingScore(findingsFor(adapter, spec, fitted, brief)) <
    blockingScore(findings)
    ? fitted
    : best;
}

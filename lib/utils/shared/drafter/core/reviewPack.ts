/**
 * The review pack: everything a person who is NOT in the tool needs to sign
 * off. The brief, every version as it will be posted, whether the author
 * approved it, and a provenance table tracing each quote and figure to its
 * source passage.
 *
 * Sharing is an export the user performs; nothing here leaves the device.
 * Pure: given the same state it produces the same Markdown, so it is tested
 * without a browser.
 */
import { CheckFinding } from '@/lib/utils/shared/review/deterministicChecks';

import { BriefItem, DraftSetState, DraftSource } from '@/types/drafter';

import { includedItems } from './brief';
import { groundVersion, summarizeProof } from './grounding';
import { sourceLinkFor } from './textFragment';
import { approvalStatus, hasText, isStale } from './versions';

export interface ReviewPackSpec {
  id: string;
  name: string;
  /** The segment texts exactly as they are copied out (numbering included). */
  renderedTexts: string[];
  findings: CheckFinding[];
  /** Human-readable finding messages, already localised by the caller. */
  findingMessages: string[];
  /** Per segment, the images it carries with their alt text. */
  media?: Array<Array<{ name: string; alt: string }>>;
}

export interface ReviewPackLabels {
  title: string;
  generated: string;
  brief: string;
  keyMessage: string;
  callToAction: string;
  links: string;
  linkRoles: Record<'article' | 'donation', string>;
  items: string;
  kinds: Record<BriefItem['kind'], string>;
  verification: Record<BriefItem['verified'], string>;
  versions: string;
  post: (n: number) => string;
  approved: (at: string) => string;
  notApproved: string;
  approvalChanged: string;
  briefChanged: string;
  proof: (traced: number, total: number, vouched: number) => string;
  checks: string;
  provenance: string;
  provenanceColumns: [string, string, string, string];
  noSource: string;
  /** Optional, so a caller without images need not supply them. */
  image?: (name: string) => string;
  altMissing?: string;
}

/** Everything CommonMark (and a text editor) treats as a line ending. */
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029\v\f]/u;
const MD_SPECIALS = /[\\`*_[\]()<>#|~]/gu;
/** The same without `#`, which only means something at the start of a line. */
const MD_LINE_SPECIALS = /[\\`*_[\]()<>|~]/gu;

/**
 * THE escaper: every string that came from a user, a source or a model goes
 * through it before it is placed in the pack. The result is inert inline
 * text on ONE line, so a page title cannot rewrite a link and an item cannot
 * start a heading or a forged sign-off line of its own.
 */
function md(value: string): string {
  // \s covers every line ending and the tab.
  return value.replace(/\s+/gu, ' ').trim().replace(MD_SPECIALS, '\\$&');
}

/**
 * One line of a post inside the quote block. Posts are full of hashtags, so
 * `#` is escaped only where it would open a heading; list, rule and setext
 * markers are escaped at the start of the line as well. Leading whitespace
 * goes, or four spaces would turn the line into code.
 */
function mdQuoteLine(line: string): string {
  return line
    .trimStart()
    .replace(MD_LINE_SPECIALS, '\\$&')
    .replace(/^(?:[#+=-]|\d+(?=[.)]))/u, (marker) =>
      /^\d/u.test(marker) ? `${marker}\\` : `\\${marker}`,
    );
}

/**
 * A link target: web addresses only, in parsed form, with the characters
 * that end a Markdown destination or autolink percent-encoded.
 */
function mdHref(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return parsed
    .toString()
    .replace(
      /[()<>\s]/gu,
      (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    );
}

/**
 * The post as written, line for line, each line escaped and kept inside the
 * quote: a blank line in a post must not end the block and let what follows
 * pose as the pack's own text.
 */
function quoteBlock(text: string): string {
  return text
    .split(LINE_BREAKS)
    .map((line) => `> ${mdQuoteLine(line)}`.trimEnd())
    .join('\n');
}

function itemLine(item: BriefItem, labels: ReviewPackLabels): string {
  const spoken = item.kind === 'quote' || item.kind === 'testimony';
  const words = spoken ? `“${md(item.text)}”` : md(item.text);
  const who = item.attribution
    ? ` (${md(item.attribution.name)}${
        item.attribution.role ? `, ${md(item.attribution.role)}` : ''
      })`
    : '';
  return `- **${labels.kinds[item.kind]}** · ${labels.verification[item.verified]}: ${words}${who}`;
}

export function buildReviewPack(
  state: DraftSetState,
  specs: ReviewPackSpec[],
  labels: ReviewPackLabels,
  now: string,
): string {
  const { brief } = state;
  const items = includedItems(brief);
  const sourcesById = new Map<string, DraftSource>(
    state.sources.map((source) => [source.id, source]),
  );
  const out: string[] = [
    `# ${labels.title}`,
    '',
    `_${labels.generated} ${now}_`,
    '',
  ];

  out.push(`## ${labels.brief}`, '');
  if (brief.keyMessage) {
    out.push(`**${labels.keyMessage}:** ${md(brief.keyMessage)}`, '');
  }
  if (brief.callToAction) {
    out.push(`**${labels.callToAction}:** ${md(brief.callToAction)}`, '');
  }
  if (brief.links.length > 0) {
    out.push(`**${labels.links}:**`, '');
    for (const link of brief.links) {
      const href = mdHref(link.url);
      // Not a web address: shown as inert text, never as something to click.
      out.push(
        `- ${labels.linkRoles[link.role]}: ${href ? `<${href}>` : md(link.url)}`,
      );
    }
    out.push('');
  }
  if (items.length > 0) {
    out.push(
      `**${labels.items}:**`,
      '',
      ...items.map((i) => itemLine(i, labels)),
      '',
    );
  }

  out.push(`## ${labels.versions}`, '');
  for (const spec of specs) {
    const version = state.versions[spec.id];
    if (!version || !hasText(version)) continue;
    out.push(`### ${md(spec.name)}`, '');

    const approval = approvalStatus(version);
    const status =
      approval === 'approved' && version.approval
        ? labels.approved(md(version.approval.at))
        : approval === 'changed'
          ? labels.approvalChanged
          : labels.notApproved;
    const summary = summarizeProof(
      groundVersion(version.segments, brief),
      brief,
    );
    const lines = [
      status,
      labels.proof(
        summary.traced + summary.vouched,
        summary.total,
        summary.vouched,
      ),
    ];
    if (isStale(version, brief)) lines.push(labels.briefChanged);
    out.push(...lines.map((line) => `- ${line}`), '');

    spec.renderedTexts.forEach((text, index) => {
      if (spec.renderedTexts.length > 1)
        out.push(`**${labels.post(index + 1)}**`, '');
      out.push(quoteBlock(text), '');
      // A sign-off reader must see what the image says to those who cannot
      // see it, and that one is still undescribed.
      for (const item of spec.media?.[index] ?? []) {
        const name = md(item.name);
        out.push(
          `- ${labels.image?.(name) ?? name}: ${
            md(item.alt) || `_${labels.altMissing ?? ''}_`
          }`,
        );
      }
      if ((spec.media?.[index] ?? []).length > 0) out.push('');
    });

    if (spec.findingMessages.length > 0) {
      out.push(`**${labels.checks}:**`, '');
      // Finding messages are localised templates filled with values taken
      // from the text, so they are escaped like the text itself.
      out.push(
        ...spec.findingMessages.map((message) => `- ${md(message)}`),
        '',
      );
    }
  }

  out.push(`## ${labels.provenance}`, '');
  if (items.length === 0) {
    out.push(labels.noSource, '');
  } else {
    const [what, status, source, passage] = labels.provenanceColumns;
    out.push(
      `| ${what} | ${status} | ${source} | ${passage} |`,
      '| --- | --- | --- | --- |',
    );
    for (const item of items) {
      const provenance = item.provenance[0];
      const from = provenance
        ? sourcesById.get(provenance.sourceId)
        : undefined;
      const link =
        from && provenance ? sourceLinkFor(from, provenance.excerpt) : null;
      const href = link ? mdHref(link.href) : null;
      const sourceCell = from
        ? href
          ? `[${md(from.name)}](${href})`
          : md(from.name)
        : labels.noSource;
      out.push(
        `| ${md(item.text)} | ${labels.verification[item.verified]} | ${sourceCell} | ${
          provenance ? md(provenance.excerpt) : ''
        } |`,
      );
    }
    out.push('');
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd()}\n`;
}

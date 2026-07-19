import { FetchUrlError } from '@/lib/utils/server/net/fetchUrlError';

import { truncateToTokenBudget } from './textBudget';
import { callStructured, createAzureClient } from './workflowLlm';
import { resolveWorkflowModelId } from './workflowModels';

import type { DOMWindow } from 'jsdom';
import TurndownService from 'turndown';

/**
 * The DOM `Document` global is not in scope for server modules, so the type
 * comes from jsdom — which is the only thing producing documents here anyway.
 */
type DomDocument = DOMWindow['document'];

/**
 * Turns a fetched web page into plain prose a workflow model can reason over.
 *
 * The problem this solves is not "get the text" — it is that a raw page is
 * mostly navigation, promo rails and "related articles" link farms. Handed
 * that, the map extractor happily reports places that are merely *linked from*
 * the page rather than discussed on it. So two independent layers run:
 *
 *  1. Readability strips the boilerplate *containers* (nav, sidebar, footer).
 *  2. Turndown rules strip the link *targets* from whatever survives, so no
 *     URL ever reaches the model for it to chase.
 *
 * When Readability finds nothing usable (SPA shells, listing pages) a cheap
 * tag-strip runs instead, and only if that is still empty does one LLM cleanup
 * call act as the last resort.
 */

export type ExtractionMethod = 'readability' | 'fallback' | 'llm' | 'plaintext';

export interface ExtractedContent {
  text: string;
  title: string;
  siteName: string;
  extractedVia: ExtractionMethod;
  /** Raw HTML was over the parse cap and was cut before parsing. */
  truncated: boolean;
}

/** Bounds jsdom's CPU cost — parsing is synchronous and blocks the loop. */
const MAX_HTML_CHARS = 2_000_000;
/** Below this, Readability's answer is treated as a miss. */
const READABILITY_MIN_CHARS = 200;
/** Below this after the tag-strip, escalate to the LLM cleanup. */
const LLM_ESCALATION_CHARS = 200;
/** Below this we have nothing worth mapping. */
const MIN_USABLE_CHARS = 40;
const LLM_INPUT_TOKEN_BUDGET = 15_000;

/** Structural boilerplate — removed wholesale on the fallback path. */
const BOILERPLATE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'svg',
  'button',
  'select',
  'template',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
].join(',');

/** Never useful as prose, even when we are otherwise being permissive. */
const NON_CONTENT_SELECTORS = 'script,style,noscript,template,svg,iframe';

/** Short interface-chrome lines Readability sometimes keeps. */
const CHROME_LINE =
  /^(share|tweet|advertisement|advert|subscribe|sign in|sign up|log in|newsletter|cookies?|accept all|read more|related|most read|menu|skip to content)$/i;

/** Structural chrome — dropped on the normal path. */
const TURNDOWN_BOILERPLATE_TAGS = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'svg',
  'button',
  'select',
  'template',
];

/** Never prose, whatever the layout. */
const TURNDOWN_NEVER_PROSE_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
];

function makeTurndown(removeTags: string[]): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  // `remove` drops the element AND its subtree — unlike `keep`, which would
  // preserve the markup. Boilerplate contributes zero characters.
  // `svg` lives in SVGElementTagNameMap, which turndown's TagName type does
  // not cover, so the list is cast rather than split in two.
  td.remove(removeTags as unknown as TurndownService.TagName[]);
  // addRule prepends, so these beat turndown's built-in inlineLink /
  // referenceLink / image rules. Anchors collapse to their text: the model
  // reads "our flood coverage" as prose with no URL to be diverted by.
  // This applies on EVERY path, including the model fallback.
  td.addRule('linkTextOnly', {
    filter: 'a',
    replacement: (content) => content,
  });
  td.addRule('dropImages', { filter: 'img', replacement: () => '' });
  return td;
}

const buildTurndown = (() => {
  let cached: TurndownService | null = null;
  return () => (cached ??= makeTurndown(TURNDOWN_BOILERPLATE_TAGS));
})();

/**
 * Keeps everything but scripts and styles. Used only to build the model's
 * input: if the aggressive strip took the real content with it, this is what
 * still has it.
 */
const buildPermissiveTurndown = (() => {
  let cached: TurndownService | null = null;
  return () => (cached ??= makeTurndown(TURNDOWN_NEVER_PROSE_TAGS));
})();

/** jsdom + Readability are heavy; keep them off every other route's path. */
const loadDom = (() => {
  let cached: Promise<{
    JSDOM: typeof import('jsdom').JSDOM;
    VirtualConsole: typeof import('jsdom').VirtualConsole;
    Readability: typeof import('@mozilla/readability').Readability;
  }> | null = null;
  return () => {
    if (!cached) {
      cached = Promise.all([
        import('jsdom'),
        import('@mozilla/readability'),
      ]).then(([jsdom, readability]) => ({
        JSDOM: jsdom.JSDOM,
        VirtualConsole: jsdom.VirtualConsole,
        Readability: readability.Readability,
      }));
    }
    return cached;
  };
})();

/**
 * Decodes bytes using the declared charset, the document's own `<meta>`
 * declaration, then utf-8. Legacy regional news sites are still routinely
 * windows-1251/iso-8859-x, and mojibake wrecks place names.
 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const declared = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  const sniffWindow = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(0, 2048),
  );
  const metaCharset = /<meta[^>]+charset=["']?([a-z0-9_-]+)/i.exec(
    sniffWindow,
  )?.[1];

  for (const candidate of [declared, metaCharset, 'utf-8']) {
    if (!candidate) continue;
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes);
    } catch {
      // Unknown label — fall through to the next candidate.
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function toMarkdown(
  html: string,
  turndown: TurndownService = buildTurndown(),
): string {
  if (!html.trim()) return '';
  const md = turndown.turndown(html);
  return md
    .split('\n')
    .filter((line) => !CHROME_LINE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripToHtml(document: DomDocument, selectors: string): string {
  const body = document.body?.cloneNode(true) as HTMLElement | undefined;
  if (!body) return '';
  body.querySelectorAll(selectors).forEach((el) => el.remove());
  return body.innerHTML;
}

function metaContent(document: DomDocument, property: string): string {
  const el =
    document.querySelector(`meta[property="${property}"]`) ??
    document.querySelector(`meta[name="${property}"]`);
  return el?.getAttribute('content')?.trim() ?? '';
}

/**
 * Last resort: hand the model the de-chromed page and ask for the body prose
 * back verbatim. Deliberately NOT a summary — summarising would silently drop
 * the place names the workflow exists to find.
 */
async function llmCleanup(source: string, modelId?: string): Promise<string> {
  const budgeted = await truncateToTokenBudget(source, LLM_INPUT_TOKEN_BUDGET);
  const result = await callStructured<{ text: string }>({
    client: createAzureClient(),
    model: resolveWorkflowModelId(modelId),
    system:
      'You extract the main body content of a web page. Return the primary ' +
      'article, report, or page prose VERBATIM — do not summarise, rewrite, ' +
      'shorten, or translate it. Omit navigation menus, link lists, related ' +
      'or recommended article listings, advertising, cookie and consent ' +
      'notices, subscription prompts, comment threads, and footer text. If ' +
      'the page has no readable body prose, return an empty string.',
    user: `Page content:\n\n${budgeted.text}`,
    schemaName: 'page_content',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  });
  return (result.text ?? '').trim();
}

export interface ExtractParams {
  bytes: Uint8Array;
  contentType: string;
  resolvedUrl: string;
  /** HTML gets the full pipeline; text/json/csv are already prose. */
  isHtml: boolean;
  modelId?: string;
}

export async function extractReadableContent(
  params: ExtractParams,
): Promise<ExtractedContent> {
  const { bytes, contentType, resolvedUrl, isHtml, modelId } = params;
  const decoded = decodeBody(bytes, contentType);
  const hostname = safeHostname(resolvedUrl);

  if (!isHtml) {
    const text = decoded.trim();
    if (text.length < MIN_USABLE_CHARS) {
      throw new FetchUrlError('EMPTY_EXTRACTION', 'No readable text found');
    }
    return {
      text,
      title: '',
      siteName: hostname,
      extractedVia: 'plaintext',
      truncated: false,
    };
  }

  const truncated = decoded.length > MAX_HTML_CHARS;
  const html = truncated ? decoded.slice(0, MAX_HTML_CHARS) : decoded;

  const { JSDOM, VirtualConsole, Readability } = await loadDom();
  // Swallow jsdom's CSS/parse chatter — malformed real-world markup would
  // otherwise flood the logs on every fetch.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: resolvedUrl, virtualConsole });
  const { document } = dom.window;

  const documentTitle = document.title?.trim() ?? '';
  const ogTitle = metaContent(document, 'og:title');
  const ogSite = metaContent(document, 'og:site_name');

  // Readability mutates the document, so parse against a clone.
  const article = new Readability(document.cloneNode(true) as DomDocument, {
    charThreshold: 250,
  }).parse();

  let extractedVia: ExtractionMethod = 'readability';
  let contentHtml = article?.content ?? '';
  if ((article?.textContent?.trim().length ?? 0) < READABILITY_MIN_CHARS) {
    contentHtml = stripToHtml(document, BOILERPLATE_SELECTORS);
    extractedVia = 'fallback';
  }

  let text = toMarkdown(contentHtml);

  if (text.length < LLM_ESCALATION_CHARS) {
    // The aggressive strip may have taken real content with it, so let the
    // model see everything except scripts and styles.
    const permissive = toMarkdown(
      stripToHtml(document, NON_CONTENT_SELECTORS),
      buildPermissiveTurndown(),
    );
    if (permissive.length >= MIN_USABLE_CHARS) {
      const cleaned = await llmCleanup(permissive, modelId);
      if (cleaned.length > text.length) {
        text = cleaned;
        extractedVia = 'llm';
      }
    }
  }

  if (text.length < MIN_USABLE_CHARS) {
    throw new FetchUrlError('EMPTY_EXTRACTION', 'No readable text found');
  }

  return {
    text,
    title: (article?.title || ogTitle || documentTitle || '').trim(),
    siteName: (article?.siteName || ogSite || hostname).trim(),
    extractedVia,
    truncated,
  };
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

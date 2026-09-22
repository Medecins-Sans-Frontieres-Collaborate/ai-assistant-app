/**
 * Validation shared by the drafter routes. Request bodies are rebuilt from
 * known fields and capped; nothing is passed through as received.
 */
import { normalizeHttpUrl } from '@/lib/utils/shared/drafter/core/brief';

import {
  BriefItemKind,
  DRAFTER_LIMITS,
  GenerateRequest,
  GenerateToneInput,
} from '@/types/drafter';

const MAX_VOICE_CHARS = 30_000;
/** No spec allows more than 25 segments; anything past this is not a draft. */
export const MAX_CURRENT_SEGMENTS = 30;
/** What the server will vouch for: 'unverified' is not on the list. */
const TRUSTED_VERIFICATIONS = ['verbatim', 'user-asserted'] as const;
type TrustedVerification = (typeof TRUSTED_VERIFICATIONS)[number];
const ITEM_KINDS: readonly BriefItemKind[] = [
  'quote',
  'testimony',
  'fact',
  'figure',
  'context',
];

type BriefInput = GenerateRequest['brief'];

/**
 * A request's brief, rebuilt field by field. Links are appended to published
 * text verbatim, so they are limited to one web address per role.
 */
export function parseBriefInput(raw: unknown): BriefInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const brief = raw as Partial<BriefInput>;
  if (typeof brief.keyMessage !== 'string') return null;
  const items = (Array.isArray(brief.items) ? brief.items : [])
    .filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.text === 'string' &&
        item.text.trim() &&
        (ITEM_KINDS as readonly string[]).includes(item.kind) &&
        // An item that was never verified is DROPPED. Mapping it to
        // 'verbatim' would let a request launder an invented quote.
        (TRUSTED_VERIFICATIONS as readonly unknown[]).includes(item.verified),
    )
    .slice(0, DRAFTER_LIMITS.MAX_BRIEF_ITEMS)
    .map((item) => ({
      id: item.id.slice(0, 40),
      kind: item.kind,
      text: item.text.slice(0, DRAFTER_LIMITS.MAX_ITEM_CHARS),
      attribution:
        item.attribution && typeof item.attribution.name === 'string'
          ? {
              name: item.attribution.name.slice(0, 120),
              role:
                typeof item.attribution.role === 'string'
                  ? item.attribution.role.slice(0, 160)
                  : undefined,
            }
          : undefined,
      verified: item.verified as TrustedVerification,
    }));
  if (items.length === 0 && !brief.keyMessage.trim()) return null;
  return {
    keyMessage: brief.keyMessage.slice(0, 600),
    callToAction:
      typeof brief.callToAction === 'string'
        ? brief.callToAction.slice(0, 300)
        : undefined,
    // At most one link per role, web addresses only: these are appended to
    // published text verbatim, so nothing else may get through.
    links: (['article', 'donation'] as const).flatMap((role) => {
      for (const entry of Array.isArray(brief.links) ? brief.links : []) {
        if (!entry || entry.role !== role || typeof entry.url !== 'string') {
          continue;
        }
        // The PARSED form is what gets stored: the URL parser silently drops
        // an embedded newline, so the raw string can hold a second address.
        const url = normalizeHttpUrl(entry.url);
        if (!url) continue;
        return [{ role, label: String(entry.label ?? '').slice(0, 120), url }];
      }
      return [];
    }),
    language:
      typeof brief.language === 'string' && brief.language.trim()
        ? brief.language.trim().slice(0, 60)
        : 'English',
    items,
  };
}

/**
 * The text already written, per spec, for an Update. Only the specs this
 * request resolved are read (at most MAX_SPECS), and each list is cut BEFORE
 * it is walked, so neither the key count nor an array's length is the
 * caller's to choose.
 */
export function parseCurrentInput(
  raw: unknown,
  specIds: readonly string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const current = raw as Record<string, unknown>;
  for (const specId of specIds.slice(0, DRAFTER_LIMITS.MAX_SPECS)) {
    const texts = Object.hasOwn(current, specId) ? current[specId] : undefined;
    if (!Array.isArray(texts)) continue;
    result.set(
      specId,
      texts
        .slice(0, MAX_CURRENT_SEGMENTS)
        .filter((text): text is string => typeof text === 'string')
        .map((text) => text.slice(0, DRAFTER_LIMITS.MAX_SEGMENT_CHARS)),
    );
  }
  return result;
}

export function parseToneInput(raw: unknown): GenerateToneInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tone = raw as Partial<GenerateToneInput>;
  if (typeof tone.voiceRules !== 'string' || !tone.voiceRules.trim()) {
    return undefined;
  }
  return {
    name: typeof tone.name === 'string' ? tone.name.slice(0, 120) : 'Voice',
    voiceRules: tone.voiceRules.slice(0, MAX_VOICE_CHARS),
    examples:
      typeof tone.examples === 'string'
        ? tone.examples.slice(0, MAX_VOICE_CHARS)
        : undefined,
  };
}

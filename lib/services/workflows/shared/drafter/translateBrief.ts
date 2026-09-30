/**
 * Translating a brief so a draft can be written in another language. One
 * structured call, keyed by item id so nothing can be reordered, merged or
 * invented on the way through; then code checks the one thing a translation
 * must never change, the numbers.
 */
import { numbersPreserved } from '@/lib/utils/shared/drafter/core/translation';

import { TranslateBriefRequest, TranslateBriefResponse } from '@/types/drafter';

export const TRANSLATE_BRIEF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['keyMessage', 'callToAction', 'items'],
  properties: {
    keyMessage: { type: 'string' },
    callToAction: { type: ['string', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'role'],
        properties: {
          id: { type: 'string', description: 'The id given, unchanged.' },
          text: { type: 'string' },
          role: {
            type: ['string', 'null'],
            description:
              "The speaker's role translated, or null if none given.",
          },
        },
      },
    },
  },
};

export interface RawTranslateBriefResponse {
  keyMessage: string;
  callToAction: string | null;
  items: Array<{ id: string; text: string; role: string | null }>;
}

export function buildTranslateBriefSystemPrompt(
  sourceLanguage: string,
  targetLanguage: string,
): string {
  return `You translate the factual base of a humanitarian organisation's public communications from ${sourceLanguage} into ${targetLanguage}.

RULES
- Translate every item. Return each one under the id it was given. Do not merge, split, drop, reorder or add items.
- Faithful, natural ${targetLanguage}. Add nothing, soften nothing, explain nothing.
- "quote" and "testimony" items are a person's words. Translate them as that person would say them, in the first person where the original is, and keep their register. Do not add quotation marks.
- NEVER change a number, a date, a unit or a proper name. Write numbers with the digits of the original; you may use the target language's digit grouping.
- Do not translate names of people, places or organisations. Translate a speaker's role ("nurse") when one is given.
- If the text is already in ${targetLanguage}, return it unchanged.`;
}

export function buildTranslateBriefUserPrompt(
  request: Pick<TranslateBriefRequest, 'keyMessage' | 'callToAction' | 'items'>,
): string {
  const lines = [`KEY MESSAGE: ${request.keyMessage}`];
  if (request.callToAction) {
    lines.push(`CALL TO ACTION: ${request.callToAction}`);
  }
  lines.push('', 'ITEMS');
  for (const item of request.items) {
    lines.push(
      `<item id="${item.id}" kind="${item.kind}"${
        item.role ? ` role="${item.role.replace(/"/gu, "'")}"` : ''
      }>\n${item.text}\n</item>`,
    );
  }
  return lines.join('\n');
}

/**
 * Keeps only translations of items that were actually sent, once each, and
 * records for every one whether its numbers survived. The key message and
 * the call to action fall back to the originals rather than go missing.
 */
export function normalizeTranslateBriefResponse(
  raw: RawTranslateBriefResponse,
  request: Pick<TranslateBriefRequest, 'keyMessage' | 'callToAction' | 'items'>,
): TranslateBriefResponse {
  const sent = new Map(request.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const items: TranslateBriefResponse['items'] = [];
  for (const entry of Array.isArray(raw?.items) ? raw.items : []) {
    const original =
      entry && typeof entry.id === 'string' ? sent.get(entry.id) : undefined;
    const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
    if (!original || !text || seen.has(original.id)) continue;
    seen.add(original.id);
    items.push({
      id: original.id,
      // The words are stored bare; quotation marks are added when placed.
      text: text.replace(/^["“”«»„]+|["“”«»„]+$/gu, '').trim(),
      role:
        original.role && typeof entry.role === 'string' && entry.role.trim()
          ? entry.role.trim().slice(0, 160)
          : undefined,
      numbersPreserved: numbersPreserved(original.text, text),
    });
  }
  const keyMessage =
    typeof raw?.keyMessage === 'string' && raw.keyMessage.trim()
      ? raw.keyMessage.trim()
      : request.keyMessage;
  const callToAction =
    typeof raw?.callToAction === 'string' && raw.callToAction.trim()
      ? raw.callToAction.trim()
      : request.callToAction;
  return {
    // A changed number in the framing lines falls back to the original: the
    // user will see it is untranslated, which beats a wrong figure.
    keyMessage: numbersPreserved(request.keyMessage, keyMessage)
      ? keyMessage
      : request.keyMessage,
    callToAction:
      callToAction && numbersPreserved(request.callToAction ?? '', callToAction)
        ? callToAction
        : request.callToAction,
    items,
  };
}

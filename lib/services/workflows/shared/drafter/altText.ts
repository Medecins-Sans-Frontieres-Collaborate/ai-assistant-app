/**
 * Suggesting alt text for an attached image. A SUGGESTION: it lands in an
 * editable field, and the person posting is the one who knows who and what
 * is in the picture. The prompt is strict about the things a model gets
 * wrong in ways that matter here: naming people, guessing who someone is,
 * and reading a medical situation into a photograph.
 */
export const ALT_TEXT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['alt'],
  properties: {
    alt: {
      type: 'string',
      description: 'One or two plain sentences describing what is visible.',
    },
  },
};

export interface RawAltTextResponse {
  alt: string;
}

/** Long enough to describe a scene, short enough for every platform. */
export const SUGGESTED_ALT_MAX_CHARS = 300;

export function buildAltTextSystemPrompt(language: string): string {
  return `You write alt text: a description of an image for people who cannot see it, read aloud by a screen reader beside a social media post from a humanitarian medical organisation.

RULES
- Describe ONLY what is visible. One or two plain sentences, under ${SUGGESTED_ALT_MAX_CHARS} characters.
- Do not start with "Image of", "Photo of" or similar; a screen reader already says it is an image.
- Never name a person, and never guess who someone is, their age, nationality, ethnicity, religion, health or what they feel. Say what can be seen: "a nurse in a white vest", "a child drinking from a cup".
- Do not state a place, a date or an event unless it is written in the image itself.
- Do not diagnose or describe a medical condition. Describe the visible action ("a health worker measures a child's arm").
- If the image contains readable text that matters (a sign, a caption), include it in quotation marks.
- No hashtags, no emoji, no opinions.

Write in ${language}.`;
}

export function normalizeAltText(raw: RawAltTextResponse): string {
  const text = typeof raw?.alt === 'string' ? raw.alt : '';
  // Trim FIRST: the opening-words strip is anchored at the start, and a
  // leading space from the model would otherwise defeat it.
  const stripped = text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^(?:an?\s+)?(?:image|photo|photograph|picture)\s+of\s+/iu, '')
    .trim();
  // What follows the strip starts mid-sentence ("a nurse…"); a description
  // read aloud should still begin like one.
  const sentence = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return sentence.slice(0, SUGGESTED_ALT_MAX_CHARS);
}

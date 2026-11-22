import {
  DeckBullet,
  MAX_BULLET_LEVEL,
} from '@/lib/utils/shared/documents/deckPlan';

/**
 * Bullets as the outline editor shows them: one line each, indented by two
 * spaces (or a tab) per level. Parsing keeps what is typed: an empty line
 * is an empty bullet and a single leading space stays in the text, so
 * typing never jumps (the plan check drops empty bullets and trims text).
 */

/** Spaces that make one level. */
export const INDENT = '  ';

/** The text shown for bullets. */
export function bulletsToText(bullets: readonly DeckBullet[]): string {
  return bullets
    .map((bullet) => `${INDENT.repeat(bullet.level)}${bullet.text}`)
    .join('\n');
}

/** Bullets from the text shown. */
export function textToBullets(text: string): DeckBullet[] {
  return text.split('\n').map((line) => {
    let level = 0;
    let at = 0;
    while (level < MAX_BULLET_LEVEL) {
      if (line.startsWith('\t', at)) at += 1;
      else if (line.startsWith(INDENT, at)) at += INDENT.length;
      else break;
      level += 1;
    }
    return { text: line.slice(at), level };
  });
}

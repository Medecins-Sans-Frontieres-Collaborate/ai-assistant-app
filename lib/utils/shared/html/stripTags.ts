/**
 * Hardened HTML→plain-text primitives.
 *
 * Several places turn Graph-supplied HTML (mail bodies, Teams messages,
 * meeting transcripts) into plain text for prompts and previews. Each had
 * its own single-pass `replace(/<[^>]*>/g, '')`, which is incomplete in two
 * ways CodeQL flags and an attacker-authored email can actually reach:
 *
 *  - **Reconstruction**: one pass over `<scr<v>ipt>` removes the inner tag
 *    and LEAVES `<script>`. Tag removal therefore repeats until the string
 *    stops changing.
 *  - **Comment end tags**: browsers end a comment on `--!>` as well as
 *    `-->`, so a regex that only knows `-->` walks past the real end and
 *    can swallow (or expose) markup around it. Unterminated comments and
 *    unterminated script/style blocks run to end-of-input.
 *
 * The output is plain text — never re-inserted as markup — so this is
 * defense in depth rather than the only barrier (the markdown renderer
 * sanitizes independently). Callers keep their own structural
 * pre-processing (`<br>` → newline, block-end → newline) and simply route
 * the removal steps through here.
 */

/** Comments, including the `--!>` end form and unterminated comments. */
const COMMENT_RE = /<!--[\s\S]*?(?:--!?>|$)/g;

/** `<script>`/`<style>` elements WITH their contents; unterminated → to end. */
const SCRIPT_STYLE_RE = /<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/**
 * Only a `<` followed by a name start, `/`, `!` or `?` begins markup for a
 * browser. Requiring that (the original `/<[^>]*>/` did not) keeps prose
 * like "if x < y and y > z" — common in mail bodies — from being eaten as
 * a bogus tag, without letting any real tag through.
 */
const TAG_RE = /<[a-zA-Z/!?][^>]*>/g;

/**
 * A trailing `<tag…` with no closing `>`. Requires a letter (or `/`) right
 * after the `<` so ordinary prose — "5 < 6" — is never eaten.
 */
const DANGLING_TAG_RE = /<\/?[a-zA-Z][^>]*$/;

/** Bounds the fixpoint loop; real inputs settle in one or two passes. */
const MAX_PASSES = 5;

/**
 * Removes comments and `<script>`/`<style>` blocks (contents included).
 * Run BEFORE any structural replacement so markup inside a script body can
 * never survive as text.
 */
export function stripHtmlNoise(html: string): string {
  let out = html;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = out.replace(COMMENT_RE, ' ').replace(SCRIPT_STYLE_RE, ' ');
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * Removes every remaining tag, repeating until the result is stable so a
 * split tag cannot reassemble into a live one, then drops a dangling
 * unterminated tag at the end of the input.
 */
export function stripHtmlTags(text: string): string {
  let out = text;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = out.replace(TAG_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.replace(DANGLING_TAG_RE, '');
}

/** `stripHtmlNoise` + `stripHtmlTags` for callers with no structural step. */
export function htmlToPlainTextFragment(html: string): string {
  return stripHtmlTags(stripHtmlNoise(html));
}

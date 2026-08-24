/**
 * Project-alias derivation for multi-cost-center narratives, which define a
 * short alias per code once (e.g. "P1054 Kachin State IDP Health Care (MKA)")
 * and reference projects by alias thereafter. Shared by extractFields
 * (alias-anchored excerpts and per-code hints) and normalize (evidence
 * attribution).
 */

export function escapeAliasRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function aliasMentions(text: string, alias: string): boolean {
  const pattern = escapeAliasRegExp(alias).replace(/\\\(/g, '\\s*\\(');
  return new RegExp('(?<![A-Za-z0-9])' + pattern + '(?![A-Za-z0-9])', 'i').test(
    text,
  );
}

/**
 * Derive each code's aliases from its first defining line within
 * 100 chars of the code. A claim is invalid when another known code sits
 * between the code and the alias (cover lines chain several "code name
 * (alias)" segments). Ownership is not exclusive: separate lines may assign
 * one alias to several codes.
 */
export function deriveDocAliases(
  rawText: string,
  codes: string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const lines = rawText.split('\n');
  const codesUpper = codes.map((c) => c.toUpperCase());
  for (const codeUpper of codesUpper) {
    result.set(codeUpper, []);
    const codeEsc = escapeAliasRegExp(codeUpper);
    for (const line of lines) {
      if (!line.toUpperCase().includes(codeUpper)) continue;
      const validClaim = (matched: string, alias: string): boolean => {
        const between = matched.slice(
          codeUpper.length,
          matched.length - alias.length,
        );
        return !codesUpper.some(
          (other) => other !== codeUpper && between.includes(other),
        );
      };
      const found: string[] = [];
      const compound = line.match(
        new RegExp(codeEsc + '[^\\n]{0,100}?([A-Z]{2,4}\\([A-Z]{2,6}\\))'),
      );
      if (compound && validClaim(compound[0], compound[1]))
        found.push(compound[1]);
      const paren = line.match(
        new RegExp(codeEsc + '[^\\n]{0,100}?\\(([A-Z]{2,6})\\)'),
      );
      if (
        paren &&
        !found.some((f) => f.includes(paren[1])) &&
        validClaim(paren[0], '(' + paren[1] + ')')
      )
        found.push(paren[1]);
      if (found.length > 0) {
        result.set(codeUpper, found);
        break;
      }
    }
  }
  return result;
}

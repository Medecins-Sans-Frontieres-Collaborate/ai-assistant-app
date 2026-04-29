import { ReactNode } from 'react';

/**
 * Lightweight JSON token coloring intended for short, well-formed payloads
 * (e.g. MCP tool-call arguments rendered inline in a consent card). Splits
 * on string literals, keys, keywords (true/false/null), and numbers; any
 * other text renders as default. Not a real parser — falls back gracefully
 * for malformed or unexpected payloads (renders as plain text).
 *
 * Returns an array of React nodes. Tokens render as plain `<span>` text
 * children, so backend-controlled payloads are XSS-safe.
 */
const JSON_TOKEN_RE =
  /("(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?)/g;

export function highlightJsonTokens(json: string): ReactNode[] {
  const parts = json.split(JSON_TOKEN_RE);
  return parts.map((part, i) => {
    if (!part) return null;
    if (/^"(?:[^"\\]|\\.)*"\s*:$/.test(part)) {
      return (
        <span key={i} className="text-sky-700 dark:text-sky-300">
          {part}
        </span>
      );
    }
    if (/^"(?:[^"\\]|\\.)*"$/.test(part)) {
      return (
        <span key={i} className="text-orange-700 dark:text-orange-300">
          {part}
        </span>
      );
    }
    if (part === 'true' || part === 'false' || part === 'null') {
      return (
        <span key={i} className="text-emerald-700 dark:text-emerald-400">
          {part}
        </span>
      );
    }
    if (/^-?\d+(?:\.\d+)?$/.test(part)) {
      return (
        <span key={i} className="text-purple-700 dark:text-purple-400">
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

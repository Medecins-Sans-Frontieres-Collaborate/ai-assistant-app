/**
 * Shared helpers for the M365 tool implementations (fourth pass B2).
 * Pure functions + the input-error type the executor maps to isError
 * results. No graphApi import here — tool modules lazy-import graphApi
 * inside their async bodies so this graph stays free of next-auth (see
 * groupMembership.ts for the rationale).
 */
import { M365_TOOL_SPECS } from '@/lib/services/m365/tools/toolCatalog';

/**
 * Single-sources each tool's minted scope set from the catalog so the
 * implementations cannot drift from the listing contract.
 */
export function catalogScopes(toolName: string): string[] {
  const spec = M365_TOOL_SPECS.find((s) => s.name === toolName);
  if (!spec) {
    throw new Error(`Unknown M365 tool in catalog: ${toolName}`);
  }
  return spec.scopes;
}

/** Thrown by tool implementations on bad arguments; never escapes the executor. */
export class M365ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M365ToolInputError';
  }
}

/**
 * Teams channel ids ('19:...@thread.tacv2') contain ':' and '@', which the
 * conservative GRAPH_ID_REGEX rejects — this is the channel-shaped superset.
 */
const CHANNEL_ID_REGEX = /^[A-Za-z0-9:@._-]{1,256}$/;

export function isValidChannelId(id: string): boolean {
  return CHANNEL_ID_REGEX.test(id);
}

const EMAIL_REGEX = /^[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+$/;

export function isValidEmail(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 320 && EMAIL_REGEX.test(value)
  );
}

/** OData string literals escape single quotes by doubling them. */
export function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Tag-strips Graph HTML bodies (chat/channel messages) into plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(
      /&([a-zA-Z]+);/g,
      (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/** '2026-08-03T14:00:00.0000000' → '2026-08-03 14:00'. */
export function formatGraphDateTime(value: string | undefined): string {
  if (!value || value.length < 16) return value ?? '?';
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/** '2026-08-03T14:00:00.0000000' → '14:00'. */
export function formatGraphTime(value: string | undefined): string {
  if (!value || value.length < 16) return value ?? '?';
  return value.slice(11, 16);
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/;

export function isIsoDateArg(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (ISO_DATE_ONLY.test(value) || ISO_DATETIME.test(value))
  );
}

/** Widens a date-only arg into a datetime spanning that day's edge. */
export function toDateTime(value: string, edge: 'start' | 'end'): string {
  if (ISO_DATE_ONLY.test(value)) {
    return edge === 'start' ? `${value}T00:00:00` : `${value}T23:59:59`;
  }
  return value;
}

/** Parses an ISO arg as UTC when it carries no offset. */
export function parseAsUtc(value: string): Date {
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(value);
  return new Date(hasOffset ? value : `${value}Z`);
}

export function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new M365ToolInputError(`${key} is required and must be a string`);
  }
  return value.trim();
}

export function requireIsoDate(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = requireString(args, key);
  if (!isIsoDateArg(value)) {
    throw new M365ToolInputError(
      `${key} must be an ISO 8601 date like 2026-08-03 or 2026-08-03T14:00:00`,
    );
  }
  return value;
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new M365ToolInputError(`${key} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function clampNumber(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
  min = 1,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new M365ToolInputError(`${key} must be a number`);
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function asRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new M365ToolInputError('Tool arguments must be an object');
  }
  return args as Record<string, unknown>;
}

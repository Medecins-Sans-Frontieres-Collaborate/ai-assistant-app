#!/usr/bin/env node

/**
 * Translation script for filling missing localization keys in messages/*.json.
 *
 * TypeScript port of python_translatins/translate_missing.py, running against
 * the app's Azure OpenAI / AI Foundry deployment instead of api.openai.com.
 * Auth mirrors evals/lib/clients.ts: Entra bearer tokens from your `az login`
 * identity by default (TRANSLATE_AUTH=default switches to the app's
 * DefaultAzureCredential chain, which honours AZURE_CLIENT_SECRET — beware a
 * stale secret there fails hard instead of falling through to the CLI).
 * The spawned `az` inherits AZURE_CONFIG_DIR, so per-profile CLI wrappers
 * work out of the box, e.g.:
 *     eval "$(azp ctx env <profile>)" && node scripts/translateMissing.ts
 *
 * Every run also VALIDATES existing translations against the English source
 * (balanced ICU braces, identical placeholder arguments) and retranslates any
 * corrupt values it finds — so a truncated plural like
 * "{count, plural, one {# x} other {# y}" is repaired by running the script,
 * not by hand-editing locale files. Freshly translated values are validated
 * the same way before they are written; invalid model output is retried and,
 * if it stays invalid, dropped with a report rather than written.
 *
 * Usage (Node >= 22.18 runs TypeScript directly):
 *     # Test with a single locale (dry-run)
 *     node scripts/translateMissing.ts --locale fr --dry-run
 *
 *     # Process single locale
 *     node scripts/translateMissing.ts --locale fr
 *
 *     # Process all locales (parallel; see --workers / --concurrency)
 *     node scripts/translateMissing.ts
 *
 *     # Force-retranslate specific keys/subtrees across all locales
 *     # (overwrites existing values; English is always the source). Subtree
 *     # paths match every nested key under them.
 *     node scripts/translateMissing.ts --force-keys "Prompts,title,agents.baseModel"
 *
 * Environment (.env.local is loaded automatically):
 *     AZURE_OPENAI_ENDPOINT or AZURE_AI_FOUNDRY_ENDPOINT: required.
 *     AZURE_TENANT_ID: tenant for the az CLI credential (cli auth mode).
 *     TRANSLATE_AUTH: "cli" (default) or "default".
 *     OPENAI_API_VERSION: Azure OpenAI API version override.
 */
import {
  AzureCliCredential,
  DefaultAzureCredential,
  type TokenCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import { config as loadDotenv } from 'dotenv';
import * as fs from 'fs';
import { AzureOpenAI } from 'openai';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Locale code to language name mapping
const LOCALE_NAMES: Record<string, string> = {
  am: 'Amharic',
  ar: 'Arabic',
  bn: 'Bengali',
  ca: 'Catalan',
  cs: 'Czech',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  fa: 'Persian',
  ff: 'Fula',
  fi: 'Finnish',
  fr: 'French',
  ha: 'Hausa',
  he: 'Hebrew',
  hi: 'Hindi',
  ht: 'Haitian Creole',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  km: 'Khmer',
  ko: 'Korean',
  ku: 'Kurdish',
  ln: 'Lingala',
  mg: 'Malagasy',
  my: 'Burmese',
  ne: 'Nepali',
  nl: 'Dutch',
  ny: 'Chichewa',
  pl: 'Polish',
  ps: 'Pashto',
  pt: 'Portuguese',
  rn: 'Kirundi',
  ro: 'Romanian',
  ru: 'Russian',
  rw: 'Kinyarwanda',
  sg: 'Sango',
  si: 'Sinhala',
  so: 'Somali',
  sr: 'Serbian',
  sv: 'Swedish',
  sw: 'Swahili',
  ta: 'Tamil',
  te: 'Telugu',
  tg: 'Tajik',
  th: 'Thai',
  ti: 'Tigrinya',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  yo: 'Yoruba',
  zh: 'Chinese',
  zu: 'Zulu',
};

// Maximum keys per translation batch to avoid token limits
const BATCH_SIZE = 50;

// Validation-failure retry rounds before a key is dropped (per locale run).
const VALIDATION_ROUNDS = 3;

// API-error retries within a single batch call.
const API_RETRIES = 4;

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

// ---------------------------------------------------------------------------
// Concurrency primitives (stdlib-only stand-ins for Python's semaphore/pool)
// ---------------------------------------------------------------------------

/** Promise-based counting semaphore capping concurrent async sections. */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(count: number) {
    this.available = Math.max(1, count);
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Map over items with at most `limit` tasks in flight; preserves order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const gate = new Semaphore(limit);
  return Promise.all(items.map((item) => gate.run(() => fn(item))));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ICU validation
//
// next-intl parses every message with intl-messageformat: one unbalanced brace
// in one locale crashes rendering for that namespace at runtime. Model output
// occasionally truncates or drops a closing brace, so nothing model-produced
// is trusted until it passes these checks against the English source.
// ---------------------------------------------------------------------------

const ICU_COMPLEX_TYPES = new Set(['plural', 'select', 'selectordinal']);

const NAME_RE = /\s*([a-zA-Z0-9_]+)\s*/y;
const SELECTOR_RE = /\s*(=\d+|[a-zA-Z0-9_]+)\s*/y;
const OFFSET_RE = /\s*offset\s*:\s*\d+\s*/y;
const WS_RE = /\s*/y;

/** Match a sticky regex at position `i`, or null. */
function matchAt(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

/**
 * True when every unquoted '{' has a matching '}' and depth never goes
 * negative. ICU apostrophe-quoting is honored: '' is a literal apostrophe,
 * and '…' quotes syntax characters when opened before one of {}#.
 */
export function bracesBalanced(text: string): boolean {
  let depth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      if (i + 1 < n && text[i + 1] === "'") {
        i += 2;
        continue;
      }
      if (i + 1 < n && '{}#'.includes(text[i + 1])) {
        const closing = text.indexOf("'", i + 1);
        i = closing === -1 ? n : closing + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
    i += 1;
  }
  return depth === 0;
}

/** Result accumulator for the mini ICU parser below. */
interface IcuScan {
  args: Set<string>;
  keywords: string[];
}

/**
 * Scan literal message text, descending into {arguments}, until an
 * unmatched '}' (returned unconsumed) or end of input. Tolerant of
 * malformed input by construction — it only ever advances.
 */
function icuParseMessage(text: string, i: number, out: IcuScan): number {
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      if (i + 1 < n && text[i + 1] === "'") {
        i += 2;
        continue;
      }
      if (i + 1 < n && '{}#'.includes(text[i + 1])) {
        const closing = text.indexOf("'", i + 1);
        i = closing === -1 ? n : closing + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '}') return i;
    if (ch === '{') {
      i = icuParseArgument(text, i + 1, out);
      continue;
    }
    i += 1;
  }
  return i;
}

/** Parse '{name}', '{name, type}', or '{name, plural/select, options…}'. */
function icuParseArgument(text: string, i: number, out: IcuScan): number {
  const n = text.length;
  const nameMatch = matchAt(NAME_RE, text, i);
  if (!nameMatch) {
    return i; // malformed ({ not followed by a name) — resume scanning
  }
  out.args.add(nameMatch[1]);
  i = NAME_RE.lastIndex;
  if (i < n && text[i] === '}') return i + 1;
  if (i >= n || text[i] !== ',') return i;
  i += 1;
  const typeMatch = matchAt(NAME_RE, text, i);
  const icuType = typeMatch ? typeMatch[1] : '';
  i = typeMatch ? NAME_RE.lastIndex : i;
  if (i < n && text[i] === '}') {
    if (ICU_COMPLEX_TYPES.has(icuType)) {
      out.keywords.push(icuType);
    }
    return i + 1;
  }
  if (i >= n || text[i] !== ',') return i;
  i += 1;
  if (ICU_COMPLEX_TYPES.has(icuType)) {
    out.keywords.push(icuType);
    const offsetMatch = matchAt(OFFSET_RE, text, i);
    if (offsetMatch) {
      i = OFFSET_RE.lastIndex;
    }
    // Option bodies ("one {…} other {…}") are nested messages — the
    // place a naive regex mistakes body text for placeholder names.
    while (i < n) {
      const selectorMatch = matchAt(SELECTOR_RE, text, i);
      if (!selectorMatch || text[SELECTOR_RE.lastIndex] !== '{') break;
      i = icuParseMessage(text, SELECTOR_RE.lastIndex + 1, out);
      if (i < n && text[i] === '}') {
        i += 1;
      }
    }
    matchAt(WS_RE, text, i);
    i = WS_RE.lastIndex;
    return i < n && text[i] === '}' ? i + 1 : i;
  }
  // Simple styled argument ({x, number, percent}) — skip to its close.
  let depth = 1;
  while (i < n && depth) {
    if (text[i] === '{') {
      depth += 1;
    } else if (text[i] === '}') {
      depth -= 1;
    }
    i += 1;
  }
  return i;
}

function icuScan(text: string): IcuScan {
  const out: IcuScan = { args: new Set(), keywords: [] };
  icuParseMessage(text, 0, out);
  return out;
}

/** The set of ICU argument names referenced in a message. */
export function icuArgs(text: string): Set<string> {
  return icuScan(text).args;
}

/** The plural/select keywords in a message, in order of appearance. */
export function icuKeywords(text: string): string[] {
  return icuScan(text).keywords;
}

/**
 * Validate a translated string against its English source.
 *
 * Returns null when valid, or a short human-readable problem description.
 * Only structure is checked (braces, argument names, plural/select
 * keywords) — never the natural-language content.
 */
export function validateTranslation(
  sourceText: string,
  translatedText: string,
): string | null {
  if (sourceText.trim() && !translatedText.trim()) {
    return 'empty translation';
  }
  if (bracesBalanced(sourceText) && !bracesBalanced(translatedText)) {
    return 'unbalanced braces';
  }
  const sourceArgs = icuArgs(sourceText);
  const translatedArgs = icuArgs(translatedText);
  const missing = [...sourceArgs].filter((a) => !translatedArgs.has(a)).sort();
  const extra = [...translatedArgs].filter((a) => !sourceArgs.has(a)).sort();
  if (missing.length || extra.length) {
    const parts: string[] = [];
    if (missing.length) {
      parts.push(`missing placeholders [${missing.join(', ')}]`);
    }
    if (extra.length) {
      parts.push(`unexpected placeholders [${extra.join(', ')}]`);
    }
    return parts.join(', ');
  }
  const sourceKeywords = [...icuKeywords(sourceText)].sort();
  const translatedKeywords = [...icuKeywords(translatedText)].sort();
  if (sourceKeywords.join('\0') !== translatedKeywords.join('\0')) {
    return 'plural/select structure changed';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Locale-tree helpers
// ---------------------------------------------------------------------------

/**
 * Flatten a nested dictionary into dot-separated keys.
 * Example: {"a": {"b": "c"}} -> {"a.b": "c"}
 */
export function flattenDict(
  d: JsonObject,
  parentKey = '',
  sep = '.',
): Record<string, string> {
  const items: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    const newKey = parentKey ? `${parentKey}${sep}${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(items, flattenDict(v, newKey, sep));
    } else {
      items[newKey] = String(v);
    }
  }
  return items;
}

/**
 * Unflatten dot-separated keys back into a nested dictionary.
 * Example: {"a.b": "c"} -> {"a": {"b": "c"}}
 */
export function unflattenDict(
  d: Record<string, string>,
  sep = '.',
): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(d)) {
    const parts = key.split(sep);
    let current = result;
    for (const part of parts.slice(0, -1)) {
      const existing = current[part];
      if (existing === undefined || typeof existing !== 'object') {
        current[part] = {};
      }
      current = current[part] as JsonObject;
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

/** Keys in source that are missing in target (flattened comparison). */
export function findMissingKeys(
  sourceFlat: Record<string, string>,
  targetFlat: Record<string, string>,
): Record<string, string> {
  const missing: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceFlat)) {
    if (!(key in targetFlat)) {
      missing[key] = value;
    }
  }
  return missing;
}

/**
 * Existing target values that fail validation against the English source.
 *
 * These are corrupt translations already on disk (e.g. a truncated plural)
 * and are queued for retranslation exactly like missing keys.
 */
export function findInvalidKeys(
  sourceFlat: Record<string, string>,
  targetFlat: Record<string, string>,
): Record<string, string> {
  const invalid: Record<string, string> = {};
  for (const [key, sourceValue] of Object.entries(sourceFlat)) {
    const targetValue = targetFlat[key];
    if (targetValue === undefined) continue; // missing, handled separately
    if (validateTranslation(sourceValue, targetValue) !== null) {
      invalid[key] = sourceValue;
    }
  }
  return invalid;
}

/**
 * Expand force-key paths into matching flattened English keys.
 *
 * A path can be either an exact leaf key ("common.closeModal") or a
 * prefix that matches a whole subtree ("Prompts" matches every
 * "Prompts.*" key).
 */
export function expandForceKeys(
  sourceFlat: Record<string, string>,
  forcePaths: string[],
  log: string[],
): Record<string, string> {
  const forced: Record<string, string> = {};
  for (const raw of forcePaths) {
    const p = raw.trim();
    if (!p) continue;
    if (p in sourceFlat) {
      forced[p] = sourceFlat[p];
      continue;
    }
    const prefix = `${p}.`;
    let matched = false;
    for (const [k, v] of Object.entries(sourceFlat)) {
      if (k.startsWith(prefix)) {
        forced[k] = v;
        matched = true;
      }
    }
    if (!matched) {
      log.push(
        `  Warning: force-key '${p}' did not match any English source keys`,
      );
    }
  }
  return forced;
}

/** Deep merge updates into base (modifies base in place and returns it). */
export function deepMerge(base: JsonObject, updates: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(updates)) {
    const existing = base[key];
    if (
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      deepMerge(existing, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Azure OpenAI client + translation
// ---------------------------------------------------------------------------

function envString(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

/**
 * TRANSLATE_AUTH=cli (default) → `az login` identity. TRANSLATE_AUTH=default
 * → the app's DefaultAzureCredential chain, which also honours
 * AZURE_CLIENT_SECRET from .env.local — note that a stale secret there makes
 * the chain fail hard instead of falling through to the CLI.
 */
function buildCredential(): TokenCredential {
  const mode = envString('TRANSLATE_AUTH', 'cli');
  if (mode === 'default') return new DefaultAzureCredential();
  if (mode !== 'cli') {
    throw new Error(`TRANSLATE_AUTH must be "cli" or "default", got "${mode}"`);
  }
  // Foundry lives in the app tenant; the CLI's default tenant may differ.
  return new AzureCliCredential({ tenantId: envString('AZURE_TENANT_ID') });
}

/**
 * Azure OpenAI client against the app's Foundry account, authenticated with
 * Entra bearer tokens (same construction as evals/lib/clients.ts /
 * ServiceContainer). The `model` passed per request is the deployment name —
 * in this app deployments are named after the model ids in config/models.json.
 */
function buildClient(): AzureOpenAI {
  const foundry = envString('AZURE_AI_FOUNDRY_ENDPOINT');
  const accountBase = foundry?.replace(/\/api\/projects\/.*$/, '');
  const endpoint =
    envString('AZURE_OPENAI_ENDPOINT') ??
    accountBase?.replace('.services.ai.azure.com', '.openai.azure.com');
  if (!endpoint) {
    throw new Error(
      'Set AZURE_OPENAI_ENDPOINT or AZURE_AI_FOUNDRY_ENDPOINT in .env.local or the environment',
    );
  }
  return new AzureOpenAI({
    endpoint,
    azureADTokenProvider: getBearerTokenProvider(
      buildCredential(),
      'https://cognitiveservices.azure.com/.default',
    ),
    apiVersion: envString('OPENAI_API_VERSION', '2025-04-01-preview'),
  });
}

// Strict structured-output schema for a translation batch (same pattern as
// lib/services/mcp/McpPlannerService.ts and the m365 mail tools).
const TRANSLATION_BATCH_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'translation_batch',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        translations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              translated_text: { type: 'string' },
            },
            required: ['key', 'translated_text'],
            additionalProperties: false,
          },
        },
      },
      required: ['translations'],
      additionalProperties: false,
    },
  },
} as const;

interface TranslationBatch {
  translations: Array<{ key: string; translated_text: string }>;
}

function buildSystemPrompt(languageName: string): string {
  return `You are a professional translator for the MSF AI Assistant application.
MSF (Médecins Sans Frontières / Doctors Without Borders) is an international humanitarian medical organization.

Your task is to translate UI strings from English to ${languageName}.

IMPORTANT RULES:
1. Preserve all placeholders exactly as they appear: {{variable}}, {count}, {name}, etc.
2. ICU MessageFormat structures ({count, plural, one {...} other {...}}, select, selectordinal) must keep EXACTLY the same argument names, category keywords, and number of braces as the English source — translate only the text inside the innermost braces. Never drop a closing brace.
3. Preserve markdown formatting (**, *, \`, etc.)
4. Preserve special characters like ellipsis (...), quotes, etc.
5. Use appropriate formality level for ${languageName} in a professional application context.
6. Keep translations concise and natural-sounding.
7. For technical terms (API, URL, etc.), keep them in English if that's standard practice in ${languageName}.
8. Return translations in the same JSON structure as provided.

Translate the following texts to ${languageName}.`;
}

/**
 * Translate a batch of texts using Azure OpenAI with structured outputs.
 *
 * Transient API errors are retried with exponential backoff. The result is
 * filtered to the requested keys — a model must not be able to write keys
 * it was never asked about. Returned values are unvalidated; caller validates.
 */
async function translateBatch(
  client: AzureOpenAI,
  texts: Record<string, string>,
  targetLocale: string,
  model: string,
  apiGate: Semaphore,
  log: string[],
): Promise<Record<string, string>> {
  const languageName = LOCALE_NAMES[targetLocale] ?? targetLocale;

  const textsList = Object.entries(texts).map(([key, englishText]) => ({
    key,
    english_text: englishText,
  }));
  const userPrompt = `Translate these UI strings to ${languageName}. For each item, provide the key and the translated_text.

${JSON.stringify(textsList, null, 2)}`;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= API_RETRIES; attempt++) {
    try {
      const response = await apiGate.run(() =>
        client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: buildSystemPrompt(languageName) },
            { role: 'user', content: userPrompt },
          ],
          response_format: TRANSLATION_BATCH_SCHEMA,
        }),
      );

      const content = response.choices[0]?.message?.content;
      if (!content) {
        log.push('  Warning: No parsed response for batch');
        return {};
      }
      const parsed = JSON.parse(content) as TranslationBatch;

      // Only keys that were requested; the model owns nothing else.
      const result: Record<string, string> = {};
      for (const item of parsed.translations ?? []) {
        if (item.key in texts) {
          result[item.key] = item.translated_text;
        }
      }
      return result;
    } catch (error) {
      // Auth failures are not transient: retrying (and the later validation
      // rounds) would repeat the same failure for every batch. Throw so the
      // whole locale fails fast with the real cause.
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : String(error);
      if (
        status === 401 ||
        status === 403 ||
        /az login|credential/i.test(message)
      ) {
        throw error;
      }
      lastError = error;
      if (attempt < API_RETRIES) {
        const delaySeconds = Math.min(2 ** attempt, 30) * (0.5 + Math.random());
        log.push(
          `  API error (attempt ${attempt}/${API_RETRIES}), retrying in ${delaySeconds.toFixed(1)}s: ${error instanceof Error ? error.message : error}`,
        );
        await sleep(delaySeconds * 1000);
      }
    }
  }

  log.push(
    `  Error translating batch after ${API_RETRIES} attempts: ${lastError instanceof Error ? lastError.message : lastError}`,
  );
  return {};
}

/**
 * Translate all keys, validating every value against its English source.
 *
 * Each round fans the batches out with bounded concurrency (they are
 * independent — disjoint key sets, merged afterwards). Keys whose
 * translations fail validation (or never come back) are retried in later,
 * smaller rounds; whatever still fails after VALIDATION_ROUNDS is dropped
 * and reported, so corrupt output is never written to disk.
 */
async function translateValidated(
  client: AzureOpenAI,
  toTranslate: Record<string, string>,
  locale: string,
  model: string,
  apiGate: Semaphore,
  batchWorkers: number,
  log: string[],
): Promise<Record<string, string>> {
  const accepted: Record<string, string> = {};
  let pending: Record<string, string> = { ...toTranslate };

  for (let roundNo = 1; roundNo <= VALIDATION_ROUNDS; roundNo++) {
    const keys = Object.keys(pending);
    if (keys.length === 0) break;

    const batches: Array<Record<string, string>> = [];
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      batches.push(
        Object.fromEntries(
          keys.slice(i, i + BATCH_SIZE).map((k) => [k, pending[k]]),
        ),
      );
    }
    if (roundNo > 1) {
      log.push(
        `  Retry round ${roundNo}: ${keys.length} key(s) failed validation`,
      );
    } else {
      log.push(
        `  Translating ${keys.length} key(s) in ${batches.length} batch(es)...`,
      );
    }

    const results: Record<string, string> = {};
    const batchResults = await mapWithConcurrency(
      batches,
      Math.max(1, batchWorkers),
      (batch) => translateBatch(client, batch, locale, model, apiGate, log),
    );
    for (const batchResult of batchResults) {
      Object.assign(results, batchResult);
    }

    const stillPending: Record<string, string> = {};
    for (const [key, sourceText] of Object.entries(pending)) {
      const translated = results[key];
      if (translated === undefined) {
        stillPending[key] = sourceText;
        continue;
      }
      const problem = validateTranslation(sourceText, translated);
      if (problem === null) {
        accepted[key] = translated;
      } else {
        log.push(`  Invalid translation for '${key}' (${problem}); will retry`);
        stillPending[key] = sourceText;
      }
    }
    pending = stillPending;
  }

  for (const key of Object.keys(pending)) {
    log.push(
      `  DROPPED '${key}': no valid translation after ${VALIDATION_ROUNDS} round(s)`,
    );
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// Per-locale processing
// ---------------------------------------------------------------------------

interface ProcessOptions {
  dryRun: boolean;
  model: string;
  forceKeys: string[];
  repair: boolean;
  apiGate: Semaphore;
  batchWorkers: number;
}

/**
 * Process a single locale file and add missing/repaired translations.
 *
 * Safe to run concurrently with other locales: reads and writes only its own
 * locale file, and writes it exactly once, after every batch has completed
 * and been validated. All output is buffered into the returned log so
 * parallel locales don't interleave lines.
 */
async function processLocale(
  client: AzureOpenAI | null,
  messagesDir: string,
  sourceData: JsonObject,
  sourceFlat: Record<string, string>,
  locale: string,
  opts: ProcessOptions,
): Promise<{ count: number; log: string[] }> {
  const log: string[] = [];
  const localeFile = path.join(messagesDir, `${locale}.json`);

  if (!fs.existsSync(localeFile)) {
    log.push(`  Warning: ${localeFile} does not exist, skipping`);
    return { count: 0, log };
  }

  const targetData = JSON.parse(
    fs.readFileSync(localeFile, 'utf-8'),
  ) as JsonObject;
  const targetFlat = flattenDict(targetData);

  const missing = findMissingKeys(sourceFlat, targetFlat);

  let invalid: Record<string, string> = {};
  if (opts.repair) {
    invalid = findInvalidKeys(sourceFlat, targetFlat);
    for (const key of Object.keys(invalid)) {
      log.push(
        `  Repair: '${key}' is corrupt on disk (${validateTranslation(sourceFlat[key], targetFlat[key])})`,
      );
    }
  }

  let forced: Record<string, string> = {};
  if (opts.forceKeys.length > 0) {
    forced = expandForceKeys(sourceFlat, opts.forceKeys, log);
  }

  // Forced/invalid keys override existing translations; merge on top of missing.
  const toTranslate: Record<string, string> = {
    ...missing,
    ...invalid,
    ...forced,
  };
  const toTranslateCount = Object.keys(toTranslate).length;

  if (toTranslateCount === 0) {
    log.push('  No missing keys');
    return { count: 0, log };
  }

  const summary = [`${Object.keys(missing).length} missing`];
  if (Object.keys(invalid).length) {
    summary.push(`${Object.keys(invalid).length} corrupt`);
  }
  if (Object.keys(forced).length) {
    summary.push(`${Object.keys(forced).length} forced`);
  }
  log.push(`  ${summary.join(' + ')} = ${toTranslateCount} to translate`);

  if (opts.dryRun) {
    for (const [key, value] of Object.entries(toTranslate).slice(0, 10)) {
      const tags: string[] = [];
      if (key in invalid) tags.push('corrupt');
      if (key in forced) tags.push('forced');
      const tag = tags.length ? ` [${tags.join(',')}]` : '';
      log.push(
        value.length <= 50
          ? `    - ${key}${tag}: ${value}`
          : `    - ${key}${tag}: ${value.slice(0, 50)}...`,
      );
    }
    if (toTranslateCount > 10) {
      log.push(`    ... and ${toTranslateCount - 10} more`);
    }
    return { count: toTranslateCount, log };
  }

  if (!client) {
    throw new Error('client is required outside dry-run');
  }
  const allTranslations = await translateValidated(
    client,
    toTranslate,
    locale,
    opts.model,
    opts.apiGate,
    opts.batchWorkers,
    log,
  );
  const acceptedCount = Object.keys(allTranslations).length;

  if (acceptedCount === 0) {
    log.push('  No translations received');
    return { count: 0, log };
  }

  // ORDER OF OPERATIONS: every batch is done and validated; only now do we
  // unflatten, merge, and write the file — exactly once, atomically.
  const nestedTranslations = unflattenDict(allTranslations);
  deepMerge(targetData, nestedTranslations);

  const tmpFile = `${localeFile}.tmp`;
  fs.writeFileSync(
    tmpFile,
    `${JSON.stringify(targetData, null, 2)}\n`,
    'utf-8',
  );
  fs.renameSync(tmpFile, localeFile);

  log.push(`  Added ${acceptedCount} translation(s)`);
  return { count: acceptedCount, log };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Find and fill missing translations in messages/*.json using Azure OpenAI.

Usage: node scripts/translateMissing.ts [options]

Options:
  --locale <code>       Single locale to process (e.g. 'fr'). Default: all locales.
  --dry-run             Show missing/corrupt keys without translating or writing.
  --messages-dir <dir>  Path to messages directory. Default: <repo>/messages
  --model <name>        Azure OpenAI deployment to use. Default: gpt-4.1
  --force-keys <list>   Comma-separated keys to retranslate even if present.
                        Dot notation for nested keys; a bare prefix matches the
                        whole subtree. English (en.json) is always the source.
  --no-repair           Skip validating existing translations (repair is on by default).
  --workers <n>         Locales processed concurrently. Default: 6
  --batch-workers <n>   Concurrent translation batches within one locale. Default: 3
  --concurrency <n>     Global cap on in-flight API requests. Default: 8
  --help                Show this help.

Examples:
  node scripts/translateMissing.ts --locale fr --dry-run
  node scripts/translateMissing.ts --locale fr
  node scripts/translateMissing.ts
  node scripts/translateMissing.ts --force-keys "Prompts,common.closeModal"`;

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    options: {
      locale: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'messages-dir': { type: 'string' },
      model: { type: 'string', default: 'gpt-4.1' },
      'force-keys': { type: 'string' },
      'no-repair': { type: 'boolean', default: false },
      workers: { type: 'string', default: '6' },
      'batch-workers': { type: 'string', default: '3' },
      concurrency: { type: 'string', default: '8' },
      help: { type: 'boolean', default: false },
    },
  });

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const dryRun = args['dry-run'] === true;
  const forceKeys = (args['force-keys'] ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  // .env.local carries the endpoint config; loaded before any client is built.
  loadDotenv({
    path: path.resolve(SCRIPT_DIR, '..', '.env.local'),
    quiet: true,
  });

  const messagesDir = path.resolve(
    args['messages-dir'] ?? path.join(SCRIPT_DIR, '..', 'messages'),
  );
  if (!fs.existsSync(messagesDir)) {
    console.error(`Error: Messages directory not found: ${messagesDir}`);
    return 1;
  }

  const sourceFile = path.join(messagesDir, 'en.json');
  if (!fs.existsSync(sourceFile)) {
    console.error(`Error: English source file not found: ${sourceFile}`);
    return 1;
  }
  const sourceData = JSON.parse(
    fs.readFileSync(sourceFile, 'utf-8'),
  ) as JsonObject;
  const sourceFlat = flattenDict(sourceData);
  console.log(
    `Loaded English source with ${Object.keys(sourceFlat).length} keys`,
  );

  const client = dryRun ? null : buildClient();

  let locales: string[];
  if (args.locale) {
    if (!(args.locale in LOCALE_NAMES)) {
      console.log(
        `Warning: Unknown locale '${args.locale}', proceeding anyway...`,
      );
    }
    locales = [args.locale];
  } else {
    locales = Object.keys(LOCALE_NAMES).filter((code) => code !== 'en');
  }

  const workers = Math.max(1, Number(args.workers) || 1);
  const opts: ProcessOptions = {
    dryRun,
    model: args.model ?? 'gpt-4.1',
    forceKeys,
    repair: args['no-repair'] !== true,
    apiGate: new Semaphore(Math.max(1, Number(args.concurrency) || 1)),
    batchWorkers: Math.max(1, Number(args['batch-workers']) || 1),
  };

  let totalKeys = 0;
  const report = (locale: string, log: string[]): void => {
    console.log(
      `\nProcessing ${locale} (${LOCALE_NAMES[locale] ?? locale})...`,
    );
    for (const line of log) {
      console.log(line);
    }
  };

  // Dry-run is local-only, so run it sequentially for ordered output;
  // otherwise locales are fully independent (each owns its file) and are
  // processed in parallel, each locale's buffered log printed as a block.
  const localeConcurrency = dryRun ? 1 : workers;
  await mapWithConcurrency(locales, localeConcurrency, async (locale) => {
    try {
      const { count, log } = await processLocale(
        client,
        messagesDir,
        sourceData,
        sourceFlat,
        locale,
        opts,
      );
      report(locale, log);
      totalKeys += count;
    } catch (error) {
      // One locale must not kill the run.
      report(locale, [
        `  FAILED: ${error instanceof Error ? error.message : error}`,
      ]);
    }
  });

  console.log(
    `\n${dryRun ? 'Would translate' : 'Translated'} ${totalKeys} total key(s) across ${locales.length} locale(s)`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
  },
);

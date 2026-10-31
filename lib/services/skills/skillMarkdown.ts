/**
 * SKILL.md import/export — the Agent Skills interchange format
 * (agentskills.io) used by both Claude and ChatGPT. Mapping contract:
 * docs/SKILLS_DESIGN.md §8.
 *
 * Uses bounded YAML 1.2 parsing with string-only scalars, duplicate-key
 * checks, and no alias expansion or custom tags. Multiline descriptions
 * and standard metadata maps are supported; executable runtimes are not.
 */
import {
  SKILL_LIMITS,
  SkillActivation,
  SkillActivationSchema,
  SkillForeignFrontmatterSchema,
  SkillIdSchema,
} from './types';

import { parseDocument } from 'yaml';

/** App-specific properties live under `metadata:` on export, per the spec. */
const MSF_METADATA_KEYS = {
  activation: 'msf-activation',
  displayName: 'msf-display-name',
  applyToAgents: 'msf-apply-to-agents',
  requireConsent: 'msf-require-consent',
} as const;

/**
 * Standard frontmatter fields we map onto our own schema.
 * `disable-model-invocation` (Agent Skills / Claude Code) means "never
 * offered to the model, explicit use only" — our 'manual' activation. The
 * OpenCode spelling, `metadata.opencode/autoinvoke: false`, is honoured on
 * import as well but stays preserved as foreign metadata.
 */
const MAPPED_KEYS = new Set([
  'name',
  'description',
  'disable-model-invocation',
]);
const OPENCODE_AUTOINVOKE_KEY = 'opencode/autoinvoke';

/** Lenient boolean for interchange flags; undefined when not a recognisable boolean. */
function booleanish(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  return undefined;
}

/**
 * A parsed SKILL.md ready to become a stored skill. Not a full `Skill`:
 * timestamps and documents are the store's business.
 */
export interface ParsedSkillMarkdown {
  id: string;
  name: string;
  description: string;
  instructions: string;
  activation: SkillActivation;
  applyToAgents: boolean;
  /** Optional so a stored record (where the field is optional) serializes directly. */
  requireConsent?: boolean;
  /** Preserved, never interpreted; `metadata.*` keys are flattened. */
  foreignFrontmatter?: Record<string, string>;
}

export type ParseSkillResult =
  | { ok: true; skill: ParsedSkillMarkdown }
  | { ok: false; errors: string[] };

/** Title-cases a skill id for the display-name fallback. */
function displayNameFromId(id: string): string {
  return id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Parses a SKILL.md document into skill fields.
 *
 * Collects every problem instead of stopping at the first so an import
 * preview can show the author the complete fix list in one pass.
 */
export function parseSkillMarkdown(content: string): ParseSkillResult {
  const errors: string[] = [];
  const normalized = content.replace(/\r\n/g, '\n');

  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized.trim());
  if (!match) {
    return {
      ok: false,
      errors: [
        'SKILL.md must start with YAML frontmatter between `---` markers, followed by markdown instructions.',
      ],
    };
  }
  const [, frontmatterBlock, body] = match;

  const fields: Record<string, string> = Object.create(null);
  const metadata: Record<string, string> = Object.create(null);
  if (new TextEncoder().encode(frontmatterBlock).length > 256 * 1024)
    return {
      ok: false,
      errors: ['Skill frontmatter exceeds the 256 KB parsing limit.'],
    };
  try {
    const document = parseDocument(frontmatterBlock, {
      schema: 'failsafe',
      uniqueKeys: true,
      strict: true,
    });
    if (document.errors.length || document.warnings.length)
      return {
        ok: false,
        errors: [...document.errors, ...document.warnings].map(
          (error) => error.message,
        ),
      };
    const parsed = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
    if (!(parsed instanceof Map))
      return {
        ok: false,
        errors: ['Skill frontmatter must be a YAML mapping.'],
      };
    for (const [key, value] of parsed) {
      if (typeof key !== 'string') {
        errors.push('Frontmatter keys must be strings.');
        continue;
      }
      if (key === 'metadata') {
        if (!(value instanceof Map)) {
          errors.push('metadata must be a string-to-string mapping.');
          continue;
        }
        for (const [metaKey, metaValue] of value) {
          if (typeof metaKey !== 'string' || typeof metaValue !== 'string')
            errors.push('metadata keys and values must be strings.');
          else metadata[metaKey] = metaValue;
        }
      } else if (typeof value !== 'string')
        errors.push(`Frontmatter field "${key}" must be a string.`);
      else fields[key] = value;
    }
  } catch (error) {
    return {
      ok: false,
      errors: [
        `Invalid or aliased YAML frontmatter: ${error instanceof Error ? error.message : 'unsupported YAML'}`,
      ],
    };
  }

  const id = fields.name ?? '';
  const idCheck = SkillIdSchema.safeParse(id);
  if (!idCheck.success) {
    errors.push(
      id
        ? `Invalid \`name\` "${id}": 1-${SKILL_LIMITS.idMaxLength} characters, lowercase letters, numbers, and single hyphens only (no edge or consecutive hyphens).`
        : 'Frontmatter is missing the required `name` field.',
    );
  }

  const description = fields.description ?? '';
  if (!description) {
    errors.push('Frontmatter is missing the required `description` field.');
  } else if (description.length > SKILL_LIMITS.descriptionMaxLength) {
    errors.push(
      `\`description\` is ${description.length} characters; the maximum is ${SKILL_LIMITS.descriptionMaxLength}.`,
    );
  }

  const instructions = body.trim();
  if (!instructions) {
    errors.push('The markdown body (the skill instructions) is empty.');
  } else if (
    // TextEncoder, not Buffer: this module parses imports in the BROWSER
    // (the import preview) as well as on the server.
    new TextEncoder().encode(instructions).length >
    SKILL_LIMITS.instructionsMaxBytes
  ) {
    errors.push(
      `The instruction body exceeds ${SKILL_LIMITS.instructionsMaxBytes} bytes. Move detailed reference material out of SKILL.md (it can become skill documents once document support lands).`,
    );
  }

  // Our own exported properties come back out of `metadata:`; anything else
  // is foreign and preserved verbatim.
  // Interchange flags: a skill the author hid from model invocation
  // imports as 'manual' unless our own metadata says otherwise (ours is
  // the more specific statement and wins).
  const disableModelInvocation = booleanish(fields['disable-model-invocation']);
  if (
    fields['disable-model-invocation'] !== undefined &&
    disableModelInvocation === undefined
  )
    errors.push('disable-model-invocation must be true or false.');
  const autoinvoke = booleanish(metadata[OPENCODE_AUTOINVOKE_KEY]);
  let activation: SkillActivation =
    disableModelInvocation === true || autoinvoke === false ? 'manual' : 'auto';
  const rawActivation = metadata[MSF_METADATA_KEYS.activation];
  if (rawActivation !== undefined) {
    const parsed = SkillActivationSchema.safeParse(rawActivation);
    if (parsed.success) {
      activation = parsed.data;
    } else {
      errors.push(
        `metadata.${MSF_METADATA_KEYS.activation} must be one of: auto, always, manual, off.`,
      );
    }
  }
  const rawRequireConsent = metadata[MSF_METADATA_KEYS.requireConsent];
  const requireConsent = booleanish(rawRequireConsent) === true;
  if (
    rawRequireConsent !== undefined &&
    booleanish(rawRequireConsent) === undefined
  )
    errors.push(
      `metadata.${MSF_METADATA_KEYS.requireConsent} must be true or false.`,
    );
  const name =
    metadata[MSF_METADATA_KEYS.displayName] ??
    (idCheck.success ? displayNameFromId(id) : '');
  const applyToAgents = metadata[MSF_METADATA_KEYS.applyToAgents] === 'true';
  if (
    metadata[MSF_METADATA_KEYS.applyToAgents] !== undefined &&
    !['true', 'false'].includes(metadata[MSF_METADATA_KEYS.applyToAgents])
  )
    errors.push('metadata.msf-apply-to-agents must be true or false.');

  const foreignFrontmatter: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(fields)) {
    if (!MAPPED_KEYS.has(key)) foreignFrontmatter[key] = value;
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (
      !Object.values(MSF_METADATA_KEYS).includes(
        key as (typeof MSF_METADATA_KEYS)[keyof typeof MSF_METADATA_KEYS],
      )
    ) {
      foreignFrontmatter[`metadata.${key}`] = value;
    }
  }

  const foreignCheck =
    SkillForeignFrontmatterSchema.safeParse(foreignFrontmatter);
  if (!foreignCheck.success)
    errors.push('Frontmatter contains unsafe keys or unsupported values.');
  if (!name.trim() || name.length > SKILL_LIMITS.nameMaxLength)
    errors.push('Display name must be nonempty and at most 100 characters.');
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    skill: {
      id,
      name,
      description,
      instructions,
      activation,
      applyToAgents,
      requireConsent,
      foreignFrontmatter:
        Object.keys(foreignFrontmatter).length > 0
          ? foreignFrontmatter
          : undefined,
    },
  };
}

/** Quotes a frontmatter value when it would otherwise misparse. */
function frontmatterValue(value: string): string {
  // YAML otherwise coerces values such as "true" and "1" in metadata.
  // JSON string syntax is also valid YAML and preserves newlines/escapes.
  return JSON.stringify(value);
}

/**
 * Serializes skill fields to a SKILL.md valid for Claude Code, claude.ai,
 * and ChatGPT. Inverse of parseSkillMarkdown: foreign frontmatter is
 * restored to its original position (top level, or under `metadata:` for
 * flattened `metadata.*` keys) and our fields are written under `metadata:`
 * as `msf-*` properties.
 */
export function serializeSkillMarkdown(skill: ParsedSkillMarkdown): string {
  SkillIdSchema.parse(skill.id);
  SkillForeignFrontmatterSchema.parse(skill.foreignFrontmatter ?? {});
  const lines: string[] = ['---', `name: ${skill.id}`];
  lines.push(`description: ${frontmatterValue(skill.description)}`);
  // Interchange: other runtimes read this standard flag; ours is restated
  // under metadata so the round trip is exact.
  if (skill.activation === 'manual')
    lines.push('disable-model-invocation: true');

  const foreign = skill.foreignFrontmatter ?? {};
  for (const [key, value] of Object.entries(foreign)) {
    if (!key.startsWith('metadata.')) {
      lines.push(`${key}: ${frontmatterValue(value)}`);
    }
  }

  const metadataEntries: Array<[string, string]> = [
    [MSF_METADATA_KEYS.activation, skill.activation],
    [MSF_METADATA_KEYS.displayName, skill.name],
  ];
  if (skill.applyToAgents) {
    metadataEntries.push([MSF_METADATA_KEYS.applyToAgents, 'true']);
  }
  if (skill.requireConsent) {
    metadataEntries.push([MSF_METADATA_KEYS.requireConsent, 'true']);
  }
  for (const [key, value] of Object.entries(foreign)) {
    if (key.startsWith('metadata.')) {
      metadataEntries.push([key.slice('metadata.'.length), value]);
    }
  }
  lines.push('metadata:');
  for (const [key, value] of metadataEntries) {
    lines.push(`  ${key}: ${frontmatterValue(value)}`);
  }

  lines.push('---', '', skill.instructions, '');
  return lines.join('\n');
}

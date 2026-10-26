/**
 * Skills — schemas, limits, and shared types.
 *
 * A skill is a named instruction block with a one-line activation
 * description, loaded into the system prompt only when a turn needs it:
 * always (standing), forced (explicit use from the composer), or — from
 * phase 2 — routed by the tool router. Design: docs/SKILLS_DESIGN.md.
 *
 * Schema convention (lib/services/agentAccess/types.ts): the READ schema is
 * permissive — no length caps, new fields optional/defaulted — so
 * previously-stored blobs keep parsing. The WRITE schema
 * (SkillWriteFieldsSchema) is strict and carries the caps.
 *
 * The id/description constraints are the Agent Skills standard's `name` /
 * `description` rules VERBATIM (agentskills.io), so every skill exports as a
 * valid SKILL.md without lossy renaming — see skillMarkdown.ts.
 */
import { z } from 'zod';

/**
 * Hard limits shared by the write schema, the admin editor, the SKILL.md
 * importer, and the request validator. One table so a cap can never drift
 * between the layers that enforce it (docs/SKILLS_DESIGN.md §11).
 */
export const SKILL_LIMITS = {
  maxDocuments: 20,
  maxDocumentBytes: 10 * 1024 * 1024,
  maxBundleBytes: 20 * 1024 * 1024,
  maxExtractedChars: 600_000,
  inlineDocumentTokens: 2000,
  referenceTokensPerSkill: 3000,
  referenceTokensPerTurn: 12000,
  referenceChunksPerSkill: 6,
  indexBatchSize: 16,
  /** Agent Skills `name` cap. */
  idMaxLength: 64,
  /** Agent Skills `description` cap. */
  descriptionMaxLength: 1024,
  /**
   * Instruction body cap — the standard recommends < 5000 tokens; anything
   * larger belongs in documents (phase 3) or should be an agent, not a
   * skill. Also why skills store WHOLE records (no guide-style payload
   * split): this is prompt-agent scale.
   */
  instructionsMaxBytes: 16_384,
  /** Display name cap (ours, not the standard's). */
  nameMaxLength: 100,
  /** `forcedSkillIds` entries accepted per request. */
  maxForcedPerTurn: 3,
  /** Additional automatically selected skills per turn. */
  maxAutoPerTurn: 3,
  /** Bound router metadata independently of instruction payloads. */
  maxRouterCatalog: 50,
  /** Hard deadline for the optional routing call; explicit use still works. */
  routingTimeoutMs: 8000,
  /**
   * `always` skills injected per turn, oldest-id-first truncation past it.
   * An admin marking many skills `always` has recreated the monolithic
   * prompt; the admin UI warns past 2.
   */
  maxAlwaysPerTurn: 5,
  injectedTokensPerTurn: 12000,
  foreignFrontmatterMaxBytes: 64 * 1024,
  maxUserSkills: 20,
  maxUserSkillsBytes: 160 * 1024,
  maxAgentLoads: 3,
  maxAgentSearches: 4,
  maxAgentSkillRounds: 3,
} as const;

/**
 * Agent Skills `name` rules: 1-64 chars, lowercase alphanumerics and single
 * hyphens, no edge hyphens, no consecutive hyphens. Doubles as our skill id
 * so SKILL.md round-trips losslessly. Identity, not a cap — enforced on
 * read AND write.
 */
export const SkillIdSchema = z
  .string()
  .min(1)
  .max(SKILL_LIMITS.idMaxLength)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'Skill ids use lowercase letters, numbers, and single hyphens (no edge hyphens)',
  );

/**
 * How a skill reaches a turn (docs/SKILLS_DESIGN.md §5):
 * - 'auto'   — routed by the tool router when the turn matches the
 *              description, or explicitly selected/pinned by the user.
 * - 'always' — injected on every turn where the skill is visible.
 * - 'off'    — authored but inactive; still visible in admin.
 * Explicit use (forcedSkillIds) works for 'auto' and 'always', never 'off'.
 */
export const SkillActivationSchema = z.enum(['auto', 'always', 'off']);
export type SkillActivation = z.infer<typeof SkillActivationSchema>;

/**
 * Attached original resource plus durable indexing progress. Text/chunks live
 * outside the catalog, in immutable prepared blobs (docs/SKILLS_DESIGN.md §7).
 */
export const SkillDocumentSchema = z.object({
  /** Immutable resource UUID under the server-owned skill-resources prefix. */
  fileId: z.string().min(1),
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** Ingestion state for the shared skills search index. */
  indexStatus: z.enum([
    'pending',
    'processing',
    'indexed',
    'inline',
    'failed',
    'asset',
  ]),
  /** Skill-root-relative path, preserved by bundle import/export. */
  resourcePath: z.string().optional(),
  uploadedAt: z.string().optional(),
  uploadedBy: z.string().optional(),
  error: z.string().optional(),
  nextChunk: z.number().int().nonnegative().default(0),
  chunkCount: z.number().int().nonnegative().optional(),
  embeddingDeployment: z.string().optional(),
  /** Legacy documents must be reindexed before vector retrieval. */
  embeddingRegion: z.enum(['EU', 'US']).optional(),
  searchEndpoint: z.string().url().optional(),
  searchIndex: z.string().optional(),
  /** CAS claim plus expiring lease, allowing another request to resume. */
  claim: z.string().optional(),
  leaseUntil: z.number().optional(),
});
export type SkillDocument = z.infer<typeof SkillDocumentSchema>;

/**
 * A stored skill (read schema, permissive). Admin-authored (org skills) or
 * compiled (built-ins, which admin records override by id — see
 * builtinSkills.ts).
 */
export const SkillSchema = z.object({
  version: z.literal(1),
  id: SkillIdSchema,
  /** Display name shown in the skill picker, chips, and admin. */
  name: z.string().min(1),
  /**
   * Router-facing (phase 2): what the skill does AND when to use it. The
   * only skill text the selection mechanism ever sees, so specific keywords
   * matter more than brevity.
   */
  description: z.string().min(1),
  activation: SkillActivationSchema,
  /**
   * Admin opt-in for read-only skill tools on agent-persona turns. False
   * by default; never permits user-authored skills or replaces persona prompts.
   */
  applyToAgents: z.boolean().default(false),
  /** Markdown instructions, injected verbatim when the skill activates. */
  instructions: z.string().min(1),
  documents: z.array(SkillDocumentSchema).default([]),
  /**
   * Agent Skills frontmatter we preserve but never interpret (`license`,
   * `compatibility`, `metadata.*`, `allowed-tools`) — round-trips on export
   * (docs/SKILLS_DESIGN.md §8). Flattened: nested `metadata` keys import as
   * `metadata.<key>`.
   */
  foreignFrontmatter: z.record(z.string(), z.string()).optional(),
  createdBy: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
  updatedBy: z.string().optional(),
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * Write-side fields (strict): what the admin routes accept from clients.
 * Caps and trimming live HERE, not on the read schema, so raising a cap
 * later never strands stored blobs.
 */
/** Safe interchange keys cannot override our mapped identity/activation fields. */
export const SkillForeignFrontmatterSchema = z
  .record(
    z
      .string()
      .max(200)
      .refine(
        (key) =>
          /^(?:[A-Za-z][A-Za-z0-9_-]*|metadata\.[A-Za-z][A-Za-z0-9_.-]*)$/.test(
            key,
          ) &&
          ![
            'name',
            'description',
            'metadata',
            'metadata.msf-activation',
            'metadata.msf-display-name',
            'metadata.msf-apply-to-agents',
          ].includes(key),
        'Reserved or unsafe skill frontmatter key',
      ),
    z.string().max(SKILL_LIMITS.descriptionMaxLength),
  )
  .refine(
    (fields) =>
      new TextEncoder().encode(JSON.stringify(fields)).length <=
      SKILL_LIMITS.foreignFrontmatterMaxBytes,
    'Preserved skill metadata exceeds the 64 KB limit',
  );

export const SkillWriteFieldsSchema = z
  .object({
    id: SkillIdSchema,
    name: z.string().trim().min(1).max(SKILL_LIMITS.nameMaxLength),
    description: z
      .string()
      .trim()
      .min(1)
      .max(SKILL_LIMITS.descriptionMaxLength),
    activation: SkillActivationSchema,
    applyToAgents: z.boolean().default(false),
    instructions: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) =>
          new TextEncoder().encode(value).length <=
          SKILL_LIMITS.instructionsMaxBytes,
        `Instructions exceed ${SKILL_LIMITS.instructionsMaxBytes} bytes`,
      ),
    foreignFrontmatter: SkillForeignFrontmatterSchema.optional(),
  })
  .strict();
export type SkillWriteFields = z.infer<typeof SkillWriteFieldsSchema>;

/** Personal skills have no documents, agent permissions, or server-owned fields. */
export const UserSkillSchema = SkillWriteFieldsSchema.omit({
  applyToAgents: true,
})
  .extend({ enabled: z.boolean().default(true) })
  .strict();
export type UserSkill = z.infer<typeof UserSkillSchema>;

/** Request cap covers JSON encoding as well as UTF-8 instruction bytes. */
export const UserSkillsRequestSchema = z
  .array(UserSkillSchema)
  .max(SKILL_LIMITS.maxUserSkills)
  .refine(
    (skills) =>
      new TextEncoder().encode(JSON.stringify(skills)).length <=
      SKILL_LIMITS.maxUserSkillsBytes,
    'Personal skills exceed the 160 KB request limit',
  )
  .refine(
    (skills) => new Set(skills.map((skill) => skill.id)).size === skills.length,
    'Personal skill ids must be unique',
  );

/** Runtime references namespace personal ids without changing SKILL.md identity. */
export const SkillReferenceIdSchema = z.union([
  SkillIdSchema,
  z
    .string()
    .startsWith('user:')
    .refine(
      (id) => SkillIdSchema.safeParse(id.slice(5)).success,
      'Invalid personal skill reference',
    ),
]);

/** History entry (guides convention): tombstones carry `skill: null`. */
export const SkillHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  skill: SkillSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type SkillHistoryEntry = z.infer<typeof SkillHistoryEntrySchema>;

/**
 * A catalog entry: a stored or compiled skill plus provenance. Built-ins
 * are editable via an admin override record but not deletable — deleting
 * the override restores the compiled default.
 */
export interface CatalogSkill {
  skill: Skill;
  /** Compiled default exists for this id (builtinSkills.ts). */
  builtin: boolean;
  /** An admin record overrides the compiled default. */
  overridden: boolean;
  /** Only server-composed personal entries carry this marker. */
  personal?: boolean;
}

import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { GuideKind, GuideKindSchema } from '@/lib/services/agentAccess/types';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';

import {
  badRequestResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  MAX_GUIDE_BODY_CHARS,
  MAX_GUIDE_ENTRIES,
  MAX_GUIDE_GENERAL_GUIDANCE_CHARS,
  MAX_GUIDE_NAME_CHARS,
  MAX_GUIDE_SECTIONS,
  MAX_GUIDE_SECTION_GUIDANCE_CHARS,
  MAX_GUIDE_SECTION_HEADING_CHARS,
  MAX_GUIDE_TERM_CHARS,
  MAX_GUIDE_TERM_NOTE_CHARS,
  MAX_GUIDE_VOICE_CHARS,
} from '@/lib/utils/shared/review/guideCriteria';

import { auth } from '@/auth';
import { z } from 'zod';

export const maxDuration = 60;

/**
 * POST /api/agent-access/guides/generate — AI form fill for the guide
 * editor. Takes an admin's freeform prompt (plus the form's current values)
 * and returns kind-shaped fields; the CLIENT decides per field whether to
 * keep or overwrite, and nothing is stored until the normal Save. Gated
 * exactly like the sibling admin guide routes; any admin may call it (any
 * admin may create a guide, and this writes nothing).
 *
 * Strict json_schema forbids optional properties, so every field is
 * required in the schema and "absent" is the empty string / empty array —
 * normalized away before the response.
 */

const MAX_GENERATE_PROMPT_CHARS = 4_000;

const currentFieldsSchema = z
  .object({
    name: z.string().max(MAX_GUIDE_NAME_CHARS).optional(),
    description: z.string().max(300).optional(),
    body: z.string().max(MAX_GUIDE_BODY_CHARS).optional(),
    voiceRules: z.string().max(MAX_GUIDE_VOICE_CHARS).optional(),
    examples: z.string().max(MAX_GUIDE_VOICE_CHARS).optional(),
    sections: z
      .array(
        z.object({
          heading: z.string(),
          guidance: z.string().optional(),
          required: z.boolean(),
        }),
      )
      .max(MAX_GUIDE_SECTIONS)
      .optional(),
    generalGuidance: z
      .string()
      .max(MAX_GUIDE_GENERAL_GUIDANCE_CHARS)
      .optional(),
    entries: z
      .array(
        z.object({
          source: z.string(),
          target: z.string(),
          note: z.string().optional(),
        }),
      )
      .max(MAX_GUIDE_ENTRIES)
      .optional(),
  })
  .strict();

const requestSchema = z
  .object({
    kind: GuideKindSchema,
    prompt: z.string().trim().min(1).max(MAX_GENERATE_PROMPT_CHARS),
    /** The form's current values — lets the model revise instead of restart. */
    current: currentFieldsSchema.optional(),
  })
  .strict();

const NAME_DESCRIPTION_PROPS = {
  name: {
    type: 'string',
    description: `Short display name for the guide (max ${MAX_GUIDE_NAME_CHARS} chars). Empty string if the current name should stand.`,
  },
  description: {
    type: 'string',
    description:
      'One-sentence description shown in pickers. Empty string if the current one should stand.',
  },
};

/** Strict response schema per kind (all properties required; empty = absent). */
function buildResponseSchema(kind: GuideKind): Record<string, unknown> {
  switch (kind) {
    case 'style':
    case 'compliance':
      return {
        type: 'object',
        properties: {
          ...NAME_DESCRIPTION_PROPS,
          body: {
            type: 'string',
            description:
              kind === 'style'
                ? 'The full style guide in markdown: concrete, checkable writing rules.'
                : 'The full compliance guide in markdown: concrete rules the content must not violate.',
          },
        },
        required: ['name', 'description', 'body'],
        additionalProperties: false,
      };
    case 'tone':
      return {
        type: 'object',
        properties: {
          ...NAME_DESCRIPTION_PROPS,
          voiceRules: {
            type: 'string',
            description:
              'Concrete voice and tone rules a writer can follow and a reviewer can check.',
          },
          examples: {
            type: 'string',
            description:
              'Short before/after or sample passages demonstrating the tone. Empty string if none.',
          },
        },
        required: ['name', 'description', 'voiceRules', 'examples'],
        additionalProperties: false,
      };
    case 'structure':
      return {
        type: 'object',
        properties: {
          ...NAME_DESCRIPTION_PROPS,
          sections: {
            type: 'array',
            description: `Ordered document sections (max ${MAX_GUIDE_SECTIONS}).`,
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                guidance: {
                  type: 'string',
                  description:
                    'What belongs in this section. Empty string if self-evident.',
                },
                required: { type: 'boolean' },
              },
              required: ['heading', 'guidance', 'required'],
              additionalProperties: false,
            },
          },
          generalGuidance: {
            type: 'string',
            description:
              'Guidance applying to the whole document. Empty string if none.',
          },
        },
        required: ['name', 'description', 'sections', 'generalGuidance'],
        additionalProperties: false,
      };
    case 'terminology':
      return {
        type: 'object',
        properties: {
          ...NAME_DESCRIPTION_PROPS,
          entries: {
            type: 'array',
            description: `Mandatory term translations/usages (max ${MAX_GUIDE_ENTRIES}).`,
            items: {
              type: 'object',
              properties: {
                source: { type: 'string', description: 'The source term.' },
                target: {
                  type: 'string',
                  description: 'The required translation or usage.',
                },
                note: {
                  type: 'string',
                  description: 'Usage note. Empty string if none.',
                },
              },
              required: ['source', 'target', 'note'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'description', 'entries'],
        additionalProperties: false,
      };
  }
}

const KIND_TASKS: Record<GuideKind, string> = {
  style:
    'an organization STYLE GUIDE: concrete, checkable editorial and writing rules (markdown)',
  compliance:
    'an organization COMPLIANCE GUIDE: concrete rules content must follow — required disclaimers, sensitive-language rules, brand constraints (markdown)',
  tone: 'an organization VOICE AND TONE profile: voice rules a writer can follow plus short examples',
  structure:
    'a DOCUMENT STRUCTURE template: ordered sections with per-section guidance and required flags',
  terminology:
    'an organization TERMINOLOGY glossary: source terms with their mandatory translations/usages and optional notes',
};

function buildSystemPrompt(
  kind: GuideKind,
  current: z.infer<typeof currentFieldsSchema> | undefined,
): string {
  const hasCurrent = current && Object.keys(current).length > 0;
  const reviseBlock = hasCurrent
    ? `

The admin's form currently contains (JSON):
${JSON.stringify(current)}

Treat the prompt as a revision/extension request over these values. Return COMPLETE field values (never diffs): improve or extend what exists where the prompt asks for it, and return an empty string for name/description if the current ones should simply stand. The admin chooses per field whether to accept your version.`
    : '';
  return `You are helping an administrator author ${KIND_TASKS[kind]} for a humanitarian organization. Produce content that is specific and directly usable — a reviewer must be able to check a document against it. Write in the language the admin's prompt is written in (offices author guides in their own language).${reviseBlock}`;
}

const truncate = (value: string, max: number) => value.slice(0, max);
/** Empty strings mean "absent" in strict-schema output. */
const emptyToUndefined = (value: string) => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

interface RawGenerated {
  name: string;
  description: string;
  body?: string;
  voiceRules?: string;
  examples?: string;
  sections?: Array<{ heading: string; guidance: string; required: boolean }>;
  generalGuidance?: string;
  entries?: Array<{ source: string; target: string; note: string }>;
}

/** Normalize + clamp model output to the write-route caps. */
function normalizeGenerated(kind: GuideKind, raw: RawGenerated) {
  const fields: Record<string, unknown> = {
    name: emptyToUndefined(truncate(raw.name ?? '', MAX_GUIDE_NAME_CHARS)),
    description: emptyToUndefined(truncate(raw.description ?? '', 300)),
  };
  switch (kind) {
    case 'style':
    case 'compliance':
      fields.body = truncate(raw.body ?? '', MAX_GUIDE_BODY_CHARS);
      break;
    case 'tone':
      fields.voiceRules = truncate(raw.voiceRules ?? '', MAX_GUIDE_VOICE_CHARS);
      fields.examples = emptyToUndefined(
        truncate(raw.examples ?? '', MAX_GUIDE_VOICE_CHARS),
      );
      break;
    case 'structure':
      fields.sections = (raw.sections ?? [])
        .filter((s) => s.heading.trim() !== '')
        .slice(0, MAX_GUIDE_SECTIONS)
        .map((s) => ({
          heading: truncate(s.heading.trim(), MAX_GUIDE_SECTION_HEADING_CHARS),
          guidance: emptyToUndefined(
            truncate(s.guidance ?? '', MAX_GUIDE_SECTION_GUIDANCE_CHARS),
          ),
          required: Boolean(s.required),
        }));
      fields.generalGuidance = emptyToUndefined(
        truncate(raw.generalGuidance ?? '', MAX_GUIDE_GENERAL_GUIDANCE_CHARS),
      );
      break;
    case 'terminology':
      fields.entries = (raw.entries ?? [])
        .filter((e) => e.source.trim() !== '' && e.target.trim() !== '')
        .slice(0, MAX_GUIDE_ENTRIES)
        .map((e) => ({
          source: truncate(e.source.trim(), MAX_GUIDE_TERM_CHARS),
          target: truncate(e.target.trim(), MAX_GUIDE_TERM_CHARS),
          note: emptyToUndefined(
            truncate(e.note ?? '', MAX_GUIDE_TERM_NOTE_CHARS),
          ),
        }));
      break;
  }
  return fields;
}

export async function POST(request: NextRequest) {
  // Feature flag BEFORE auth: a disabled deployment must answer 404 to
  // everyone, exactly like a route that does not exist.
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid generate request',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    const { kind, prompt, current } = parsed.data;
    const raw = await callStructured<RawGenerated>({
      client: createAzureClient(),
      system: buildSystemPrompt(kind, current),
      user: prompt,
      schemaName: 'guide_fields',
      schema: buildResponseSchema(kind),
    });

    return successResponse({ fields: normalizeGenerated(kind, raw) });
  } catch (error) {
    return handleApiError(error, 'Failed to generate guide content');
  }
}

import { NextRequest } from 'next/server';

import { loadSpecResolver } from '@/lib/services/workflows/drafterSpecLoaders';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import {
  GENERATE_SCHEMA,
  RawGenerateResponse,
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
  buildIntentBlock,
  buildLinksBlock,
  linkPolicyFor,
  quoteTokens,
  writeVersion,
} from '@/lib/services/workflows/shared/drafter/generate';
import {
  parseBriefInput,
  parseCurrentInput,
} from '@/lib/services/workflows/shared/drafter/requestParsing';
import {
  VOICE_UNAVAILABLE,
  resolveVoices,
} from '@/lib/services/workflows/shared/drafter/voices';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import { getSpecAdapter } from '@/lib/utils/shared/drafter/adapters';

import {
  DRAFTER_LIMITS,
  GenerateRequest,
  GeneratedVersion,
  VersionSpec,
} from '@/types/drafter';

import { auth } from '@/auth';

export const maxDuration = 300;

/**
 * POST /api/workflows/drafter/generate: writes one version per spec from the
 * INCLUDED brief items. Specs are resolved server-side from their ids (a
 * request body never carries limits), each spec is one parallel call, and a
 * failed spec does not fail the others.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const adapter = getSpecAdapter(body.specKind);
  if (!adapter) return badRequestResponse('Unknown specKind');
  if (!(await isWorkflowEnabled(adapter.workflow))) {
    return workflowDisabledResponse(adapter.workflow);
  }
  // Specs come from the caller's own effective list (admin-edited profiles
  // behind access rules), loaded once. An id they cannot use resolves to
  // nothing, exactly like one that does not exist.
  const loaded = await loadSpecResolver(adapter, req, session, body.setId);
  // Channel settings unreadable: refuse rather than write on defaults.
  if (!loaded.ok) return loaded.response;
  const resolveSpec = loaded.resolve;

  const specs = [...new Set(Array.isArray(body.specIds) ? body.specIds : [])]
    .map((id) => (typeof id === 'string' ? resolveSpec(id) : undefined))
    .filter((spec): spec is VersionSpec => !!spec)
    .slice(0, DRAFTER_LIMITS.MAX_SPECS);
  if (specs.length === 0) return badRequestResponse('No known specIds');

  const brief = parseBriefInput(body.brief);
  if (!brief) return badRequestResponse('brief is required');
  // Rebuilt and capped once, up front: only the resolved specs are read.
  const currentBySpec = parseCurrentInput(
    body.current,
    specs.map((spec) => spec.id),
  );

  const { denied, usage } = await beginWorkflowRun(
    session,
    'drafter_generate',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const client = createAzureClient();
    const model = resolveWorkflowModelId(body.modelId);
    const tokens = quoteTokens(brief.items);
    const voices = await resolveVoices({
      userMail: session.user?.mail ?? undefined,
      specIds: specs.map((spec) => spec.id),
      tones: body.tones,
      toneGuideIds: body.toneGuideIds,
    });

    const writeOne = async (spec: VersionSpec): Promise<GeneratedVersion> => {
      const voice = voices[spec.id];
      // A voice the user may not use fails this one spec, loudly, rather
      // than quietly writing it in no voice at all.
      if (!voice?.ok) {
        return { specId: spec.id, segments: [], error: VOICE_UNAVAILABLE };
      }
      const tone = voice.tone;
      const policy = linkPolicyFor(adapter, spec);
      const system = buildGenerateSystemPrompt(
        adapter.promptBlock(spec),
        tone,
        brief.language,
        `${buildIntentBlock(brief)}\n\n${buildLinksBlock(brief, policy)}`,
      );
      const userPrompt = buildGenerateUserPrompt(
        brief,
        tokens,
        currentBySpec.get(spec.id),
        (text) => adapter.cost?.(spec, text) ?? text.length,
      );
      return writeVersion({
        adapter,
        spec,
        brief,
        tokens,
        policy,
        userPrompt,
        call: (prompt, label) =>
          callStructured<RawGenerateResponse>({
            client,
            model,
            system,
            user: prompt,
            schemaName: 'drafter_generate',
            schema: GENERATE_SCHEMA,
            usage,
            usageLabel: label,
          }),
      });
    };

    const settled = await Promise.allSettled(specs.map(writeOne));
    const versions: GeneratedVersion[] = settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(
        `[workflows/drafter/generate] ${specs[index].id} failed: ${sanitizeForLog(result.reason)}`,
      );
      return {
        specId: specs[index].id,
        segments: [],
        error: 'GENERATION_FAILED',
      };
    });

    return successResponse({ versions, ...usage.fields() });
  } catch (error) {
    console.error(
      `[workflows/drafter/generate] Failed: ${sanitizeForLog(error)}`,
    );
    return handleApiError(error, 'Generation failed');
  }
}

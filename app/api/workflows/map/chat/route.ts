import { NextRequest } from 'next/server';

import {
  CompactMapFeature,
  MAP_CHAT_MUTATIONS_SCHEMA,
  MAP_EDIT_SENTINEL,
  buildMapChatSystemPrompt,
  buildMapChatUserPrompt,
  buildMapDigest,
  buildMutationsSystemPrompt,
  buildMutationsUserPrompt,
} from '@/lib/services/workflows/map/chatPrompts';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { truncateToTokenBudget } from '@/lib/services/workflows/shared/textBudget';
import {
  callStreamedText,
  callStructured,
  createAzureClient,
  createWorkflowStream,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

import {
  badRequestResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { normalizeEventRange } from '@/lib/utils/shared/date/eventRange';
import { NamedConnection } from '@/lib/utils/shared/geo/connections';
import { isValidCoordinate } from '@/lib/utils/shared/geo/geojson';
import { MAP_MAX_FEATURES } from '@/lib/utils/shared/geo/mapLimits';

import { auth } from '@/auth';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';

export const maxDuration = 300;

const DIGEST_TOKEN_BUDGET = 24_000;
const MAX_FEATURES = MAP_MAX_FEATURES;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1_000;

interface MapChatRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  features: CompactMapFeature[];
  connections?: Array<{ fromName: string; toName: string; kind: string }>;
  modelId?: string;
}

/**
 * POST /api/workflows/map/chat — the map workspace's conversation rail.
 * Streams a grounded answer over the mapped-data digest; when the answer
 * ends with the MAP_EDIT sentinel (user asked to change the map), runs one
 * structured call and emits the mutations as a `chat_mutations`
 * WORKFLOW_EVENT for the client to apply. Pure Q&A turns cost one call.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  // Admin workflow policy (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md): a workflow an
  // admin switched off is refused server-side, not just hidden.
  if (!(await isWorkflowEnabled('map'))) {
    return workflowDisabledResponse('map');
  }

  let body: MapChatRequest;
  try {
    body = (await req.json()) as MapChatRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequestResponse('Messages are required');
  }
  if (!Array.isArray(body.features)) {
    return badRequestResponse('Features are required');
  }
  if (body.features.length > MAX_FEATURES) {
    return badRequestResponse('Too many features');
  }

  const messages = body.messages
    .filter(
      (m) =>
        (m?.role === 'user' || m?.role === 'assistant') &&
        typeof m.content === 'string',
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    }));
  const question = messages[messages.length - 1]?.content ?? '';
  const connections = Array.isArray(body.connections) ? body.connections : [];

  const model = resolveWorkflowModelId(body.modelId);
  const { stream, writer } = createWorkflowStream();

  void (async () => {
    try {
      const digest = (
        await truncateToTokenBudget(
          buildMapDigest(body.features),
          DIGEST_TOKEN_BUDGET,
        )
      ).text;

      const client = createAzureClient();

      // Stream the answer, holding back a tail so the MAP_EDIT sentinel
      // never leaks to the display — even split across chunk boundaries.
      let tail = '';
      const holdback = MAP_EDIT_SENTINEL.length + 2;
      const answer = await callStreamedText({
        client,
        model,
        system: buildMapChatSystemPrompt(),
        user: buildMapChatUserPrompt(digest, connections, messages),
        onDelta: (delta) => {
          tail += delta;
          if (tail.length > holdback) {
            writer.text(tail.slice(0, tail.length - holdback));
            tail = tail.slice(tail.length - holdback);
          }
        },
        signal: req.signal,
      });

      const wantsEdit = answer.trimEnd().endsWith(MAP_EDIT_SENTINEL);
      // Flush the held-back tail minus the sentinel.
      const finalTail = wantsEdit
        ? tail.replace(MAP_EDIT_SENTINEL, '').trimEnd()
        : tail;
      if (finalTail) writer.text(finalTail);

      if (wantsEdit) {
        writer.activity('chat.activity.workflow.updatingMap');
        const mutations = await callStructured<{
          addFeatures: Array<
            Record<string, unknown> & {
              lat: number;
              lon: number;
              event?: {
                start?: string;
                end?: string;
                precision?: string;
                ongoing?: boolean;
              };
            }
          >;
          addConnections: NamedConnection[];
        }>({
          client,
          model,
          system: buildMutationsSystemPrompt(),
          user: buildMutationsUserPrompt(
            digest,
            question,
            answer.replace(MAP_EDIT_SENTINEL, ''),
          ),
          schemaName: 'map_chat_mutations',
          schema: MAP_CHAT_MUTATIONS_SCHEMA as unknown as Record<
            string,
            unknown
          >,
        });

        const features = mutations.addFeatures
          .filter((f) => isValidCoordinate(f.lat, f.lon))
          .map((f) => {
            const event = normalizeEventRange(f.event);
            return { ...f, ...(event ? { event } : { event: undefined }) };
          });
        const addConnections = mutations.addConnections.filter(
          (c) =>
            !!c &&
            typeof c.fromName === 'string' &&
            typeof c.toName === 'string',
        );

        if (features.length > 0 || addConnections.length > 0) {
          writer.event({
            workflow: 'map',
            type: 'chat_mutations',
            data: { features, connections: addConnections },
          });
        }
      }

      writer.close();
    } catch (error) {
      console.error('[workflows/map/chat] Failed:', error);
      writer.fail(
        'map',
        error instanceof Error ? error.message : 'Map chat failed',
      );
    }
  })();

  return new Response(stream, { headers: STREAMING_RESPONSE_HEADERS });
}

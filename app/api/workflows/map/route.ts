import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { ServiceContainer } from '@/lib/services/ServiceContainer';
import {
  MAP_FEATURES_SCHEMA,
  buildMapSystemPrompt,
  buildMapUserPrompt,
} from '@/lib/services/workflows/map/prompts';
import { truncateToTokenBudget } from '@/lib/services/workflows/shared/textBudget';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { normalizeEventFields } from '@/lib/utils/shared/date/partialDate';
import { isValidCoordinate } from '@/lib/utils/shared/geo/geojson';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import {
  MapFeatureConfidence,
  MapFeatureGranularity,
  MapFeatureProminence,
} from '@/types/workflow';

import { auth } from '@/auth';

// Two model calls in the search path (Foundry web search + extraction).
export const maxDuration = 300;

const SOURCE_TOKEN_BUDGET = 60_000;
const MAX_EXISTING_NAMES = 500;
const MAX_SEARCH_QUERY_CHARS = 500;

interface MapWorkflowRequest {
  /** Raw material to map. Exactly one of sourceText/searchQuery required. */
  sourceText?: string;
  /** Web-search mode: query run through the Foundry grounding agent. */
  searchQuery?: string;
  existingNames?: string[];
  instructions?: string;
  /** Preferred model; ineligible/unknown ids fall back server-side. */
  modelId?: string;
}

interface SearchCitation {
  number: number;
  title: string;
  url: string;
  date: string;
}

/** Name-referenced connection as the model reports it. */
interface LlmMapConnection {
  fromName: string;
  toName: string;
  kind: string;
  description: string;
}

/**
 * Runs the app's standard Foundry web search (Bing grounding configured on
 * the agent in Azure) and returns the grounded answer text + citations.
 * Mirrors ToolRouterEnricher.getAgentModelForSearch for the model guard:
 * null when the default search agent has no discovered agentId.
 */
async function runGroundedSearch(
  searchQuery: string,
  user: Session['user'],
): Promise<{ text: string; citations: SearchCitation[] } | null> {
  const searchModel = OpenAIModels[OpenAIModelID.GPT_5_2];
  if (!searchModel?.agentId) {
    return null;
  }
  const service = ServiceContainer.getInstance().getAgentChatService();
  return service.executeWebSearchTool({
    searchQuery,
    model: searchModel,
    user,
  });
}

interface LlmMapFeature {
  name: string;
  description: string;
  lat: number;
  lon: number;
  confidence: MapFeatureConfidence;
  confidenceReason: string;
  category: string;
  prominence: MapFeatureProminence;
  granularity: MapFeatureGranularity;
  countryCode: string;
  parentName: string;
  approxRadiusKm: number;
  eventStart: string;
  eventEnd: string;
  eventOngoing: boolean;
}

/**
 * POST /api/workflows/map — identifies locations in the material and
 * geocodes them from model knowledge (no external geocoding service is
 * called; the viewed data never leaves the LLM request the user initiated).
 * Synchronous JSON; invalid coordinates are dropped server-side.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: MapWorkflowRequest;
  try {
    body = (await req.json()) as MapWorkflowRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  const sourceText = body.sourceText?.trim();
  const searchQuery = body.searchQuery?.trim();
  if (!sourceText && !searchQuery) {
    return badRequestResponse('Source text or a search query is required');
  }
  if (sourceText && searchQuery) {
    return badRequestResponse(
      'Provide either sourceText or searchQuery, not both',
    );
  }
  if (searchQuery && searchQuery.length > MAX_SEARCH_QUERY_CHARS) {
    return badRequestResponse('Search query is too long');
  }

  const existingNames = Array.isArray(body.existingNames)
    ? body.existingNames
        .filter((n): n is string => typeof n === 'string')
        .slice(0, MAX_EXISTING_NAMES)
    : [];

  try {
    let material = sourceText ?? '';
    let citations: SearchCitation[] = [];

    if (searchQuery) {
      const search = await runGroundedSearch(searchQuery, session.user);
      if (search === null) {
        return badRequestResponse(
          'Web search is not available in this environment',
          'SEARCH_UNAVAILABLE',
        );
      }
      citations = search.citations;
      // Sources appended so the extraction model can use publication
      // context (dates, outlet names) when judging events.
      const sourceList =
        citations.length > 0
          ? `\n\nSources:\n${citations
              .map(
                (c) =>
                  `[${c.number}] ${c.title} — ${c.url}${c.date ? ` (${c.date})` : ''}`,
              )
              .join('\n')}`
          : '';
      material = `${search.text}${sourceList}`;
    }

    const budgeted = await truncateToTokenBudget(material, SOURCE_TOKEN_BUDGET);
    const client = createAzureClient();
    const result = await callStructured<{
      features: LlmMapFeature[];
      connections: LlmMapConnection[];
    }>({
      client,
      model: resolveWorkflowModelId(body.modelId),
      system: buildMapSystemPrompt(),
      user: buildMapUserPrompt(
        budgeted.text,
        existingNames,
        typeof body.instructions === 'string'
          ? body.instructions.slice(0, 2_000)
          : undefined,
      ),
      schemaName: 'map_features',
      schema: MAP_FEATURES_SCHEMA as unknown as Record<string, unknown>,
    });

    const features = result.features
      .filter((f) => isValidCoordinate(f.lat, f.lon))
      .map((f) => ({
        ...f,
        countryCode: f.countryCode?.trim().toUpperCase().slice(0, 2) ?? '',
        approxRadiusKm:
          typeof f.approxRadiusKm === 'number' &&
          Number.isFinite(f.approxRadiusKm) &&
          f.approxRadiusKm > 0
            ? f.approxRadiusKm
            : 0,
        ...normalizeEventFields(f),
      }));
    const dropped = result.features.length - features.length;

    const connections = Array.isArray(result.connections)
      ? result.connections.filter(
          (c): c is LlmMapConnection =>
            !!c &&
            typeof c.fromName === 'string' &&
            typeof c.toName === 'string' &&
            c.fromName.trim() !== '' &&
            c.toName.trim() !== '' &&
            c.fromName.trim().toLowerCase() !== c.toName.trim().toLowerCase(),
        )
      : [];

    return successResponse({
      features,
      connections,
      dropped,
      truncatedSource: budgeted.truncated,
      ...(searchQuery ? { searched: true, sources: citations } : {}),
    });
  } catch (error) {
    console.error('[workflows/map] Failed:', error);
    return handleApiError(error, 'Location extraction failed');
  }
}
